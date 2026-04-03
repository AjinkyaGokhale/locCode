// Public memory API

export type { Memory, MemoryStats, Observation, SessionRecord } from "./store.js";
export {
  deleteMemory,
  getMemory,
  getRecentSessions,
  getStats,
  incrementAccessCount,
  insertObservation,
  listMemories,
  openDatabase,
  upsertMemory,
} from "./store.js";

export {
  LocalEmbedder,
  cosineSimilarity,
  deserializeEmbedding,
  serializeEmbedding,
} from "./embedder.js";

export type { SearchOptions, SearchResult } from "./search.js";
export { hybridSearch, keywordSearch, recentSearch, semanticSearch, typeSearch } from "./search.js";

export type {
  LifecycleHooks,
  MemoryWorkerClient,
  PostToolUseContext,
  PromptSubmitContext,
  SessionEndContext,
  SessionStartContext,
  StopContext,
} from "./hooks.js";
export { createMemoryHooks, createNoopHooks } from "./hooks.js";

export {
  bufferObservation,
  extractFromObservations,
  processPendingObservations,
} from "./extract.js";

export type { ConsolidateResult } from "./consolidate.js";
export { autoDream, consolidate, shouldConsolidate } from "./consolidate.js";

export { retrieveForPrompt } from "./retrieve.js";

export { MemoryWorkerClientImpl, startWorker } from "./worker.js";
