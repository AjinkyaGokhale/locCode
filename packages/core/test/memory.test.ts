import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldConsolidate } from "../src/memory/consolidate.js";
import {
  cosineSimilarity,
  deserializeEmbedding,
  serializeEmbedding,
} from "../src/memory/embedder.js";
import { keywordSearch, reciprocalRankFusion } from "../src/memory/search.js";
import type { SearchResult } from "../src/memory/search.js";
import {
  countObservationsProcessedSinceConsolidation,
  deleteMemory,
  getMemory,
  getPendingObservations,
  getStats,
  incrementAccessCount,
  insertObservation,
  listMemories,
  markObservationsProcessed,
  openDatabase,
  upsertMemory,
} from "../src/memory/store.js";
import type { Memory } from "../src/memory/store.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: "test-memory",
    type: "user",
    summary: "User prefers TypeScript",
    content: "The user is an experienced TypeScript developer",
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessed: now,
    embedding: null,
    ...overrides,
  };
}

describe("SQLite CRUD", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("upsertMemory → getMemory round-trip", () => {
    const mem = makeMemory();
    upsertMemory(db, mem);
    const retrieved = getMemory(db, mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(mem.id);
    expect(retrieved?.summary).toBe(mem.summary);
    expect(retrieved?.content).toBe(mem.content);
    expect(retrieved?.type).toBe(mem.type);
  });

  it("deleteMemory → getMemory returns null", () => {
    const mem = makeMemory();
    upsertMemory(db, mem);
    deleteMemory(db, mem.id);
    expect(getMemory(db, mem.id)).toBeNull();
  });

  it("listMemories by type", () => {
    upsertMemory(db, makeMemory({ id: "m1", type: "user" }));
    upsertMemory(db, makeMemory({ id: "m2", type: "feedback" }));
    upsertMemory(db, makeMemory({ id: "m3", type: "user" }));

    const userMems = listMemories(db, "user");
    expect(userMems).toHaveLength(2);
    for (const m of userMems) expect(m.type).toBe("user");

    const feedbackMems = listMemories(db, "feedback");
    expect(feedbackMems).toHaveLength(1);
  });

  it("listMemories without type returns all", () => {
    upsertMemory(db, makeMemory({ id: "m1" }));
    upsertMemory(db, makeMemory({ id: "m2", type: "feedback" }));
    const all = listMemories(db);
    expect(all).toHaveLength(2);
  });

  it("incrementAccessCount updates field", () => {
    const mem = makeMemory({ accessCount: 0 });
    upsertMemory(db, mem);
    incrementAccessCount(db, mem.id);
    const updated = getMemory(db, mem.id);
    expect(updated?.accessCount).toBe(1);
    incrementAccessCount(db, mem.id);
    expect(getMemory(db, mem.id)?.accessCount).toBe(2);
  });

  it("upsertMemory updates existing record", () => {
    upsertMemory(db, makeMemory({ summary: "original" }));
    upsertMemory(db, makeMemory({ summary: "updated" }));
    const mem = getMemory(db, "test-memory");
    expect(mem?.summary).toBe("updated");
  });
});

describe("Observations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("insertObservation → getPendingObservations → markProcessed", () => {
    insertObservation(db, {
      sessionId: "sess1",
      hook: "onUserPromptSubmit",
      data: JSON.stringify({ message: "test" }),
      createdAt: new Date().toISOString(),
      processed: 0,
    });

    const pending = getPendingObservations(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].hook).toBe("onUserPromptSubmit");
    expect(pending[0].processed).toBe(0);

    markObservationsProcessed(db, [pending[0].id!]);
    expect(getPendingObservations(db)).toHaveLength(0);
  });

  it("markObservationsProcessed with empty array is no-op", () => {
    expect(() => markObservationsProcessed(db, [])).not.toThrow();
  });
});

describe("FTS5 keyword search", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    const now = new Date().toISOString();
    upsertMemory(db, {
      id: "m1",
      type: "user",
      summary: "TypeScript expert",
      content: "User has ten years of TypeScript experience",
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessed: now,
      embedding: null,
    });
    upsertMemory(db, {
      id: "m2",
      type: "feedback",
      summary: "No mocking in tests",
      content: "User prefers real database over mocked testing approaches",
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessed: now,
      embedding: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("exact word match returns result", () => {
    const results = keywordSearch("TypeScript", db, { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === "m1")).toBe(true);
  });

  it("search in content field works", () => {
    const results = keywordSearch("testing", db, { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("no match returns empty", () => {
    const results = keywordSearch("xyznonexistent12345", db, { limit: 10 });
    expect(results).toHaveLength(0);
  });

  it("type filter works", () => {
    const results = keywordSearch("TypeScript", db, { limit: 10, type: "feedback" });
    // m1 is type "user", not "feedback"
    expect(results.every((r) => r.type === "feedback")).toBe(true);
  });
});

describe("Reciprocal Rank Fusion", () => {
  function makeResult(id: string, type = "user"): SearchResult {
    return {
      id,
      type,
      summary: id,
      content: id,
      score: 1,
      keywordScore: 0,
      semanticScore: 0,
      matchSource: "keyword",
    };
  }

  it("combines results from two lists", () => {
    const list1 = [makeResult("a"), makeResult("b"), makeResult("c")];
    const list2 = [makeResult("b"), makeResult("d"), makeResult("a")];
    const result = reciprocalRankFusion(list1, list2);

    // "a" and "b" appear in both lists, should score higher
    const ids = result.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).toContain("d");

    const a = result.find((r) => r.id === "a")!;
    const c = result.find((r) => r.id === "c")!;
    expect(a.score).toBeGreaterThan(c.score);
    expect(a.matchSource).toBe("both");
  });

  it("empty lists produce empty result", () => {
    expect(reciprocalRankFusion([], [])).toHaveLength(0);
  });
});

describe("Embedder utilities", () => {
  it("serializeEmbedding / deserializeEmbedding round-trip", () => {
    const original = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const buf = serializeEmbedding(original);
    const restored = deserializeEmbedding(buf);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("cosineSimilarity of identical normalized vectors = 1", () => {
    const v = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("cosineSimilarity of orthogonal vectors = 0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });
});

describe("getStats", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("returns correct counts", () => {
    const now = new Date().toISOString();
    upsertMemory(db, {
      id: "m1",
      type: "user",
      summary: "s",
      content: "c",
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessed: now,
      embedding: null,
    });
    upsertMemory(db, {
      id: "m2",
      type: "feedback",
      summary: "s",
      content: "c",
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessed: now,
      embedding: null,
    });

    const stats = getStats(db, ":memory:");
    expect(stats.totalMemories).toBe(2);
    expect(stats.byType.user).toBe(1);
    expect(stats.byType.feedback).toBe(1);
  });
});

describe("shouldConsolidate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("returns false when few memories", () => {
    expect(shouldConsolidate(db)).toBe(false);
  });

  it("returns true when > 200 memories", () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 201; i++) {
      upsertMemory(db, {
        id: `m${i}`,
        type: "user",
        summary: `summary ${i}`,
        content: `content ${i}`,
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
        lastAccessed: now,
        embedding: null,
      });
    }
    expect(shouldConsolidate(db)).toBe(true);
  });
});

describe("consolidation_log", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("countObservationsProcessedSinceConsolidation returns 0 initially", () => {
    expect(countObservationsProcessedSinceConsolidation(db)).toBe(0);
  });
});
