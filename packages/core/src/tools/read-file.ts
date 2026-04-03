import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig, ToolResult } from "../types.js";

export function executeReadFile(input: Record<string, unknown>, config: AgentConfig): ToolResult {
  const path = input.path;
  if (typeof path !== "string" || !path.trim()) {
    return { output: "Error: path is required", isError: true };
  }

  const offset = typeof input.offset === "number" ? input.offset : 0;
  const limit = typeof input.limit === "number" ? input.limit : undefined;

  const fullPath = resolve(config.cwd, path);

  try {
    const content = readFileSync(fullPath, "utf8");
    const lines = content.split("\n");
    const sliced = limit !== undefined ? lines.slice(offset, offset + limit) : lines.slice(offset);

    // cat -n style: right-aligned line numbers
    const width = String(offset + sliced.length).length;
    const numbered = sliced
      .map((line, i) => `${String(offset + i + 1).padStart(width)}\t${line}`)
      .join("\n");

    return { output: numbered, isError: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { output: `Error: file not found: ${fullPath}`, isError: true };
    }
    return { output: `Error reading file: ${e.message}`, isError: true };
  }
}
