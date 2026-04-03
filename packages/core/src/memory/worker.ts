/**
 * Memory worker HTTP sidecar — runs on port 37899.
 * Can be spawned as a separate process or run in-process.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { LocalEmbedder } from "./embedder.js";
import { bufferObservation, processPendingObservations } from "./extract.js";
import { hybridSearch, keywordSearch, semanticSearch } from "./search.js";
import {
  deleteMemory,
  getMemory,
  getRecentSessions,
  getStats,
  listMemories,
  openDatabase,
  upsertMemory,
} from "./store.js";

const PORT = 37899;
const AUTO_STOP_MS = 30 * 60 * 1000; // 30 minutes

function getDbPath(cwd?: string): string {
  const base = cwd ?? process.cwd();
  return join(base, ".loccode", "memory.db");
}

function getPidPath(cwd?: string): string {
  const base = cwd ?? process.cwd();
  return join(base, ".loccode", "worker.pid");
}

export async function startWorker(cwd?: string): Promise<void> {
  const dbPath = getDbPath(cwd);
  const pidPath = getPidPath(cwd);

  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openDatabase(dbPath);
  const embedder = new LocalEmbedder();

  // Write PID file
  writeFileSync(pidPath, process.pid.toString(), "utf8");

  let lastRequestTime = Date.now();

  // Auto-stop timer
  const autoStopTimer = setInterval(() => {
    if (Date.now() - lastRequestTime > AUTO_STOP_MS) {
      console.log("[memory-worker] No requests for 30 minutes, shutting down");
      cleanup();
      process.exit(0);
    }
  }, 60_000);
  autoStopTimer.unref();

  function cleanup(): void {
    try {
      db.close();
    } catch {}
    try {
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch {}
  }

  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    lastRequestTime = Date.now();
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path = url.pathname;

    res.setHeader("Content-Type", "application/json");

    try {
      // POST /api/observe
      if (req.method === "POST" && path === "/api/observe") {
        const body = await readBody(req);
        const { sessionId, hook, data } = JSON.parse(body);
        bufferObservation(db, sessionId, hook, data);
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /api/extract
      if (req.method === "POST" && path === "/api/extract") {
        // Runs async, responds immediately
        const config = {
          baseUrl: process.env.LOCCODE_BASE_URL ?? "http://localhost:11434/v1",
          model: process.env.LOCCODE_MODEL ?? "",
          apiKey: process.env.LOCCODE_API_KEY ?? "",
          maxIterations: 6,
          maxTokensBeforeCompact: 8000,
          permissionMode: "read-only" as const,
          cwd: cwd ?? process.cwd(),
          fewShotExamples: false,
        };

        // Lazy import to avoid circular deps
        const { createClient } = await import("../client.js");
        const client = createClient(config);

        processPendingObservations(db, client, embedder, config).catch(() => {});
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /api/consolidate
      if (req.method === "POST" && path === "/api/consolidate") {
        const config = {
          baseUrl: process.env.LOCCODE_BASE_URL ?? "http://localhost:11434/v1",
          model: process.env.LOCCODE_MODEL ?? "",
          apiKey: process.env.LOCCODE_API_KEY ?? "",
          maxIterations: 6,
          maxTokensBeforeCompact: 8000,
          permissionMode: "read-only" as const,
          cwd: cwd ?? process.cwd(),
          fewShotExamples: false,
        };
        const { consolidate } = await import("./consolidate.js");
        const { createClient } = await import("../client.js");
        const client = createClient(config);
        const result = await consolidate(db, client, embedder, config);
        sendJson(res, 200, result);
        return;
      }

      // GET /api/search
      if (req.method === "GET" && path === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = parseInt(url.searchParams.get("limit") ?? "10");
        const typeParam = url.searchParams.get("type");
        const searchOpts = typeParam ? { limit, type: typeParam } : { limit };
        const results = await hybridSearch(q, db, embedder, searchOpts);
        sendJson(res, 200, results);
        return;
      }

      // GET /api/search/semantic
      if (req.method === "GET" && path === "/api/search/semantic") {
        const q = url.searchParams.get("q") ?? "";
        const limit = parseInt(url.searchParams.get("limit") ?? "10");
        const results = await semanticSearch(q, db, embedder, { limit });
        sendJson(res, 200, results);
        return;
      }

      // GET /api/search/keyword
      if (req.method === "GET" && path === "/api/search/keyword") {
        const q = url.searchParams.get("q") ?? "";
        const limit = parseInt(url.searchParams.get("limit") ?? "10");
        const results = keywordSearch(q, db, { limit });
        sendJson(res, 200, results);
        return;
      }

      // POST /api/forget
      if (req.method === "POST" && path === "/api/forget") {
        const body = await readBody(req);
        const { id } = JSON.parse(body);
        deleteMemory(db, id);
        sendJson(res, 200, { ok: true });
        return;
      }

      // GET /api/stats
      if (req.method === "GET" && path === "/api/stats") {
        const stats = getStats(db, dbPath);
        sendJson(res, 200, stats);
        return;
      }

      // GET /api/sessions
      if (req.method === "GET" && path === "/api/sessions") {
        const sessions = getRecentSessions(db, 20);
        sendJson(res, 200, sessions);
        return;
      }

      // GET /api/memories
      if (req.method === "GET" && path === "/api/memories") {
        const type = url.searchParams.get("type") ?? undefined;
        const limit = parseInt(url.searchParams.get("limit") ?? "100");
        const memories = listMemories(db, type, limit);
        sendJson(res, 200, memories);
        return;
      }

      // GET /api/memories/:id
      if (req.method === "GET" && path.startsWith("/api/memories/")) {
        const id = decodeURIComponent(path.slice("/api/memories/".length));
        const memory = getMemory(db, id);
        if (!memory) {
          sendJson(res, 404, { error: "Not found" });
        } else {
          sendJson(res, 200, { ...memory, embedding: undefined });
        }
        return;
      }

      // POST /api/upsert
      if (req.method === "POST" && path === "/api/upsert") {
        const body = await readBody(req);
        const memory = JSON.parse(body);
        const now = new Date().toISOString();
        upsertMemory(db, {
          id: memory.id,
          type: memory.type,
          summary: memory.summary,
          content: memory.content,
          createdAt: memory.createdAt ?? now,
          updatedAt: now,
          accessCount: memory.accessCount ?? 0,
          lastAccessed: memory.lastAccessed ?? now,
          embedding: null,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /api/shutdown
      if (req.method === "POST" && path === "/api/shutdown") {
        sendJson(res, 200, { ok: true });
        setTimeout(() => { cleanup(); process.exit(0); }, 100);
        return;
      }

      // GET /viewer and static assets
      if (req.method === "GET" && (path === "/viewer" || path === "/viewer/")) {
        const viewerPath = new URL("./viewer/index.html", import.meta.url).pathname;
        try {
          const html = readFileSync(viewerPath, "utf8");
          res.setHeader("Content-Type", "text/html");
          res.writeHead(200);
          res.end(html);
        } catch {
          res.setHeader("Content-Type", "text/plain");
          res.writeHead(404);
          res.end("Viewer not found");
        }
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`[memory-worker] Listening on http://127.0.0.1:${PORT}`);
      resolve();
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

// ─── MemoryWorkerClient ──────────────────────────────────────────────────────

export class MemoryWorkerClientImpl {
  private baseUrl = `http://127.0.0.1:${PORT}`;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async hook(hookName: string, payload: unknown): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session", hook: hookName, data: payload }),
      });
    } catch {
      // Worker not running — ignore
    }
  }

  async search(query: string, tokenBudget = 2000): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/api/search?q=${encodeURIComponent(query)}&limit=20`);
      if (!res.ok) return "";
      const results = (await res.json()) as Array<{ type: string; summary: string; content: string }>;
      if (results.length === 0) return "";

      const charBudget = tokenBudget * 4;
      const lines = ["=== Relevant Memories ==="];
      let usedChars = lines[0].length;
      for (const r of results) {
        const line = `[${r.type}] ${r.summary}: ${r.content}`;
        if (usedChars + line.length > charBudget) break;
        lines.push(line);
        usedChars += line.length;
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/stats`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (await this.isRunning()) return;

    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");

    // Spawn worker as separate Node process
    const workerScript = fileURLToPath(new URL("./worker-process.js", import.meta.url));
    const child = spawn(process.execPath, [workerScript], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LOCCODE_WORKER_CWD: this.cwd },
    });
    child.unref();

    // Wait for worker to be ready (up to 10s)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.isRunning()) return;
    }
  }

  async stop(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/shutdown`, { method: "POST" });
    } catch {
      // Already stopped
    }
  }
}
