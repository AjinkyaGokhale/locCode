import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface Memory {
  id: string;
  type: "user" | "feedback" | "project" | "reference";
  summary: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  lastAccessed: string;
  embedding: Buffer | null;
}

export interface Observation {
  id?: number;
  sessionId: string;
  hook: string;
  data: string; // JSON
  createdAt: string;
  processed: number;
}

export interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt: string | null;
  model: string;
  cwd: string;
  turnCount: number;
  summary: string | null;
  tokenUsage: number;
}

export interface MemoryStats {
  totalMemories: number;
  byType: Record<string, number>;
  totalSessions: number;
  dbSizeBytes: number;
  lastConsolidation: string | null;
}

export function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null };
  const currentVersion = row?.v ?? 0;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT NOT NULL,
        embedding BLOB
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        model TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        turn_count INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        token_usage INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        hook TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS hook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hook TEXT NOT NULL,
        session_id TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consolidation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ran_at TEXT NOT NULL,
        merged INTEGER NOT NULL DEFAULT 0,
        deduped INTEGER NOT NULL DEFAULT 0,
        pruned INTEGER NOT NULL DEFAULT 0,
        sharpened INTEGER NOT NULL DEFAULT 0
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        summary,
        content,
        tokenize='porter'
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_observations_unprocessed ON observations(processed) WHERE processed = 0;
      CREATE INDEX IF NOT EXISTS idx_sessions_recent ON sessions(started_at DESC);

      INSERT INTO schema_version VALUES (1);
    `);
  }
}

export function upsertMemory(db: Database.Database, memory: Memory): void {
  db.prepare(`
    INSERT OR REPLACE INTO memories
      (id, type, summary, content, created_at, updated_at, access_count, last_accessed, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.type,
    memory.summary,
    memory.content,
    memory.createdAt,
    memory.updatedAt,
    memory.accessCount,
    memory.lastAccessed,
    memory.embedding,
  );

  // Sync to FTS
  db.prepare("DELETE FROM memories_fts WHERE id = ?").run(memory.id);
  db.prepare("INSERT INTO memories_fts (id, summary, content) VALUES (?, ?, ?)").run(
    memory.id,
    memory.summary,
    memory.content,
  );
}

export function getMemory(db: Database.Database, id: string): Memory | null {
  const row = db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToMemory(row) : null;
}

export function deleteMemory(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
}

export function listMemories(
  db: Database.Database,
  type?: string,
  limit = 100,
): Memory[] {
  const rows = type
    ? (db
        .prepare(
          "SELECT * FROM memories WHERE type = ? ORDER BY updated_at DESC LIMIT ?",
        )
        .all(type, limit) as Record<string, unknown>[])
    : (db
        .prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as Record<string, unknown>[]);
  return rows.map(rowToMemory);
}

export function incrementAccessCount(db: Database.Database, id: string): void {
  db.prepare(
    "UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
}

export function insertObservation(db: Database.Database, obs: Omit<Observation, "id">): void {
  db.prepare(`
    INSERT INTO observations (session_id, hook, data, created_at, processed)
    VALUES (?, ?, ?, ?, 0)
  `).run(obs.sessionId, obs.hook, obs.data, obs.createdAt);
}

export function getPendingObservations(
  db: Database.Database,
  limit = 50,
): Observation[] {
  return db
    .prepare(
      "SELECT * FROM observations WHERE processed = 0 ORDER BY id ASC LIMIT ?",
    )
    .all(limit) as Observation[];
}

export function markObservationsProcessed(db: Database.Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE observations SET processed = 1 WHERE id IN (${placeholders})`).run(...ids);
}

export function upsertSession(db: Database.Database, session: SessionRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO sessions
      (id, started_at, ended_at, model, cwd, turn_count, summary, token_usage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.startedAt,
    session.endedAt,
    session.model,
    session.cwd,
    session.turnCount,
    session.summary,
    session.tokenUsage,
  );
}

export function getSession(db: Database.Database, id: string): SessionRecord | null {
  const row = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function getRecentSessions(db: Database.Database, limit = 20): SessionRecord[] {
  const rows = db
    .prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function logHook(
  db: Database.Database,
  hook: string,
  sessionId: string,
  durationMs: number,
  error?: string,
): void {
  db.prepare(`
    INSERT INTO hook_logs (hook, session_id, duration_ms, error, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hook, sessionId, durationMs, error ?? null, new Date().toISOString());
}

export function getStats(db: Database.Database, dbPath: string): MemoryStats {
  const totalMemories = (
    db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }
  ).c;

  const typeRows = db
    .prepare("SELECT type, COUNT(*) as c FROM memories GROUP BY type")
    .all() as Array<{ type: string; c: number }>;
  const byType: Record<string, number> = {};
  for (const r of typeRows) byType[r.type] = r.c;

  const totalSessions = (
    db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }
  ).c;

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath).size;
  } catch {
    // ignore
  }

  const lastConsolidationRow = db
    .prepare("SELECT MAX(ran_at) as t FROM consolidation_log")
    .get() as { t: string | null };

  return {
    totalMemories,
    byType,
    totalSessions,
    dbSizeBytes,
    lastConsolidation: lastConsolidationRow?.t ?? null,
  };
}

export function logConsolidation(
  db: Database.Database,
  merged: number,
  deduped: number,
  pruned: number,
  sharpened: number,
): void {
  db.prepare(
    "INSERT INTO consolidation_log (ran_at, merged, deduped, pruned, sharpened) VALUES (?, ?, ?, ?, ?)",
  ).run(new Date().toISOString(), merged, deduped, pruned, sharpened);
}

export function getLastConsolidationTime(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT MAX(ran_at) as t FROM consolidation_log")
    .get() as { t: string | null };
  return row?.t ?? null;
}

export function countObservationsProcessedSinceConsolidation(db: Database.Database): number {
  const lastTime = getLastConsolidationTime(db);
  if (!lastTime) {
    return (db.prepare("SELECT COUNT(*) as c FROM observations WHERE processed = 1").get() as { c: number }).c;
  }
  return (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM observations WHERE processed = 1 AND created_at > ?",
      )
      .get(lastTime) as { c: number }
  ).c;
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    type: row.type as Memory["type"],
    summary: row.summary as string,
    content: row.content as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    accessCount: row.access_count as number,
    lastAccessed: row.last_accessed as string,
    embedding: row.embedding as Buffer | null,
  };
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: row.id as string,
    startedAt: row.started_at as string,
    endedAt: row.ended_at as string | null,
    model: row.model as string,
    cwd: row.cwd as string,
    turnCount: row.turn_count as number,
    summary: row.summary as string | null,
    tokenUsage: row.token_usage as number,
  };
}
