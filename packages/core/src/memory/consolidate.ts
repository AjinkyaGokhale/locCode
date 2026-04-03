import type Database from "better-sqlite3";
import type { ModelClient } from "../client.js";
import type { AgentConfig } from "../types.js";
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from "./embedder.js";
import type { LocalEmbedder } from "./embedder.js";
import {
  countObservationsProcessedSinceConsolidation,
  deleteMemory,
  getLastConsolidationTime,
  listMemories,
  logConsolidation,
  upsertMemory,
} from "./store.js";
import type { Memory } from "./store.js";

export interface ConsolidateResult {
  merged: number;
  deduped: number;
  pruned: number;
  sharpened: number;
}

const SHARPEN_PROMPT = `Rewrite the following memory into a single crisp, specific fact. Keep it under 2 sentences.
Return only the rewritten memory as plain text, no JSON.

Memory to sharpen:
Summary: {summary}
Content: {content}
`;

export async function consolidate(
  db: Database.Database,
  client: ModelClient,
  embedder: LocalEmbedder,
  _config: AgentConfig,
): Promise<ConsolidateResult> {
  const result: ConsolidateResult = { merged: 0, deduped: 0, pruned: 0, sharpened: 0 };

  const memories = listMemories(db, undefined, 1000);
  if (memories.length === 0) {
    logConsolidation(db, 0, 0, 0, 0);
    return result;
  }

  // Merge step: find similar memories (cosine similarity >= 0.85)
  const withEmbeddings = memories.filter((m) => m.embedding !== null);
  const merged = new Set<string>();

  for (let i = 0; i < withEmbeddings.length; i++) {
    if (merged.has(withEmbeddings[i].id)) continue;
    const embA = deserializeEmbedding(withEmbeddings[i].embedding!);

    for (let j = i + 1; j < withEmbeddings.length; j++) {
      if (merged.has(withEmbeddings[j].id)) continue;
      const embB = deserializeEmbedding(withEmbeddings[j].embedding!);
      const sim = cosineSimilarity(embA, embB);

      if (sim >= 0.85) {
        // Merge j into i: keep i, combine content, delete j
        const a = withEmbeddings[i];
        const b = withEmbeddings[j];
        const combined: Memory = {
          ...a,
          content: `${a.content}\n\nAlso: ${b.content}`,
          updatedAt: new Date().toISOString(),
          accessCount: Math.max(a.accessCount, b.accessCount),
        };
        // Re-embed combined
        try {
          const vec = await embedder.embed(`${combined.summary} ${combined.content}`);
          combined.embedding = serializeEmbedding(vec);
        } catch {
          // keep old embedding
        }
        upsertMemory(db, combined);
        deleteMemory(db, b.id);
        merged.add(b.id);
        result.merged++;
      }
    }
  }

  // Dedupe step: find near-duplicate summaries via FTS5
  const freshMemories = listMemories(db, undefined, 1000);
  const seenSummaries = new Map<string, string>(); // normalized summary → id

  for (const m of freshMemories) {
    const normalized = m.summary.toLowerCase().trim();
    if (seenSummaries.has(normalized)) {
      // Keep the most-recently-updated one
      const existingId = seenSummaries.get(normalized)!;
      const existing = freshMemories.find((x) => x.id === existingId);
      if (existing && m.updatedAt > existing.updatedAt) {
        deleteMemory(db, existingId);
        seenSummaries.set(normalized, m.id);
      } else {
        deleteMemory(db, m.id);
      }
      result.deduped++;
    } else {
      seenSummaries.set(normalized, m.id);
    }
  }

  // Prune step: delete stale memories (access_count = 0, age > 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleMemories = listMemories(db, undefined, 1000).filter(
    (m) => m.accessCount === 0 && m.createdAt < thirtyDaysAgo,
  );
  for (const m of staleMemories) {
    deleteMemory(db, m.id);
    result.pruned++;
  }

  // Sharpen step: rewrite vague/long memories
  const longMemories = listMemories(db, undefined, 500).filter(
    (m) => m.content.length > 500 || m.summary.length > 100,
  );

  for (const m of longMemories.slice(0, 10)) {
    // limit sharpen to 10 per run to avoid excessive model calls
    try {
      const prompt = SHARPEN_PROMPT.replace("{summary}", m.summary).replace("{content}", m.content);
      let sharpened = "";
      for await (const chunk of client.streamChat(
        [
          { role: "system", content: "Rewrite memories as crisp facts. Plain text only." },
          { role: "user", content: prompt },
        ],
        [],
      )) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) sharpened += delta;
      }
      sharpened = sharpened.trim();
      if (sharpened && sharpened.length < m.content.length) {
        const updated: Memory = {
          ...m,
          content: sharpened,
          updatedAt: new Date().toISOString(),
        };
        upsertMemory(db, updated);
        result.sharpened++;
      }
    } catch {
      // Sharpen failure is non-fatal
    }
  }

  logConsolidation(db, result.merged, result.deduped, result.pruned, result.sharpened);
  return result;
}

export function shouldConsolidate(db: Database.Database): boolean {
  const totalMemories = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
  if (totalMemories > 200) return true;

  const lastTime = getLastConsolidationTime(db);
  if (lastTime) {
    const daysSince = (Date.now() - new Date(lastTime).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 7) return true;
  }

  const processedSince = countObservationsProcessedSinceConsolidation(db);
  if (processedSince > 50) return true;

  return false;
}

export async function autoDream(
  db: Database.Database,
  client: ModelClient,
  embedder: LocalEmbedder,
  config: AgentConfig,
): Promise<void> {
  if (shouldConsolidate(db)) {
    await consolidate(db, client, embedder, config);
  }
}
