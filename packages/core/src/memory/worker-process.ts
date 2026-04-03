/**
 * Worker process entry point.
 * Spawned as a detached child process by MemoryWorkerClientImpl.start().
 */
import { startWorker } from "./worker.js";

const cwd = process.env.LOCCODE_WORKER_CWD ?? process.cwd();
startWorker(cwd).catch((err) => {
  console.error("[memory-worker] Failed to start:", err);
  process.exit(1);
});
