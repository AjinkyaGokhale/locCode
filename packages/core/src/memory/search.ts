import type Database from "better-sqlite3";
import { cosineSimilarity, deserializeEmbedding } from "./embedder.js";
import type { LocalEmbedder } from "./embedder.js";
import { incrementAccessCount } from "./store.js";
import type { Memory } from "./store.js";

export interface SearchResult {
  id: string;
  type: string;
  summary: string;
  content: string;
  score: number;
  keywordScore: number;
  semanticScore: number;
  matchSource: "keyword" | "semantic" | "both";
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  type?: string;
}

export async function hybridSearch(
  query: string,
  db: Database.Database,
  embedder: LocalEmbedder,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const { limit = 10, minScore = 0.3, type } = options;

  const subOptions: SearchOptions = { limit: 50 };
  if (type !== undefined) subOptions.type = type;

  const [keywordResults, semanticResults] = await Promise.all([
    keywordSearch(query, db, subOptions),
    semanticSearch(query, db, embedder, subOptions),
  ]);

  const fused = reciprocalRankFusion(keywordResults, semanticResults);
  const filtered = fused.filter((r) => r.score >= minScore).slice(0, limit);

  // Increment access counts for returned results
  for (const r of filtered) {
    incrementAccessCount(db, r.id);
  }

  return filtered;
}

export function reciprocalRankFusion(
  list1: SearchResult[],
  list2: SearchResult[],
  k = 60,
): SearchResult[] {
  const scores = new Map<string, SearchResult>();

  for (let i = 0; i < list1.length; i++) {
    const r = list1[i];
    const rrfScore = 1 / (k + i + 1);
    if (scores.has(r.id)) {
      const existing = scores.get(r.id)!;
      existing.score += rrfScore;
      existing.keywordScore = rrfScore;
      existing.matchSource = "both";
    } else {
      scores.set(r.id, { ...r, score: rrfScore, keywordScore: rrfScore, semanticScore: 0, matchSource: "keyword" });
    }
  }

  for (let i = 0; i < list2.length; i++) {
    const r = list2[i];
    const rrfScore = 1 / (k + i + 1);
    if (scores.has(r.id)) {
      const existing = scores.get(r.id)!;
      existing.score += rrfScore;
      existing.semanticScore = rrfScore;
      existing.matchSource = "both";
    } else {
      scores.set(r.id, { ...r, score: rrfScore, keywordScore: 0, semanticScore: rrfScore, matchSource: "semantic" });
    }
  }

  return Array.from(scores.values()).sort((a, b) => b.score - a.score);
}

export async function semanticSearch(
  query: string,
  db: Database.Database,
  embedder: LocalEmbedder,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const { limit = 10, type } = options;

  const queryEmbedding = await embedder.embed(query);

  const rows = type
    ? (db
        .prepare("SELECT id, type, summary, content, embedding FROM memories WHERE type = ? AND embedding IS NOT NULL")
        .all(type) as Array<{ id: string; type: string; summary: string; content: string; embedding: Buffer }>)
    : (db
        .prepare("SELECT id, type, summary, content, embedding FROM memories WHERE embedding IS NOT NULL")
        .all() as Array<{ id: string; type: string; summary: string; content: string; embedding: Buffer }>);

  const scored = rows
    .map((row) => {
      const embedding = deserializeEmbedding(row.embedding);
      const sim = cosineSimilarity(queryEmbedding, embedding);
      return {
        id: row.id,
        type: row.type,
        summary: row.summary,
        content: row.content,
        score: sim,
        keywordScore: 0,
        semanticScore: sim,
        matchSource: "semantic" as const,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

export function keywordSearch(
  query: string,
  db: Database.Database,
  options: SearchOptions = {},
): SearchResult[] {
  const { limit = 10, type } = options;

  try {
    const rows = db
      .prepare(
        `
        SELECT m.id, m.type, m.summary, m.content,
               rank as fts_rank
        FROM memories_fts
        JOIN memories m ON memories_fts.id = m.id
        WHERE memories_fts MATCH ?
        ${type ? "AND m.type = ?" : ""}
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(...(type ? [query, type, limit] : [query, limit])) as Array<{
      id: string;
      type: string;
      summary: string;
      content: string;
      fts_rank: number;
    }>;

    return rows.map((row, i) => ({
      id: row.id,
      type: row.type,
      summary: row.summary,
      content: row.content,
      score: 1 / (i + 1),
      keywordScore: 1 / (i + 1),
      semanticScore: 0,
      matchSource: "keyword" as const,
    }));
  } catch {
    // FTS5 query error (e.g., special chars) — return empty
    return [];
  }
}

export function typeSearch(
  type: string,
  db: Database.Database,
  options: SearchOptions = {},
): SearchResult[] {
  const { limit = 10 } = options;
  const rows = db
    .prepare("SELECT id, type, summary, content FROM memories WHERE type = ? ORDER BY updated_at DESC LIMIT ?")
    .all(type, limit) as Array<{ id: string; type: string; summary: string; content: string }>;

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    summary: row.summary,
    content: row.content,
    score: 1,
    keywordScore: 0,
    semanticScore: 0,
    matchSource: "keyword" as const,
  }));
}

export function recentSearch(db: Database.Database, limit = 10): Memory[] {
  return db
    .prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as Memory[];
}
