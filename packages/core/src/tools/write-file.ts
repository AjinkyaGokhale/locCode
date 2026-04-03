import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentConfig, ToolResult } from "../types.js";

export function executeWriteFile(input: Record<string, unknown>, config: AgentConfig): ToolResult {
  const path = input.path;
  const content = input.content;

  if (typeof path !== "string" || !path.trim()) {
    return { output: "Error: path is required", isError: true };
  }
  if (typeof content !== "string") {
    return { output: "Error: content is required", isError: true };
  }

  const fullPath = resolve(config.cwd, path);

  try {
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    return { output: `Wrote ${bytes} bytes to ${fullPath}`, isError: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { output: `Error writing file: ${e.message}`, isError: true };
  }
}
