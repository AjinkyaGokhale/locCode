import { statSync } from "node:fs";
import { resolve } from "node:path";
import fg from "fast-glob";
import type { AgentConfig, ToolResult } from "../types.js";

const MAX_RESULTS = 200;

export async function executeGlob(
  input: Record<string, unknown>,
  config: AgentConfig,
): Promise<ToolResult> {
  const pattern = input.pattern;
  if (typeof pattern !== "string" || !pattern.trim()) {
    return { output: "Error: pattern is required", isError: true };
  }

  const searchPath = typeof input.path === "string" ? resolve(config.cwd, input.path) : config.cwd;

  try {
    const files = await fg(pattern, {
      cwd: searchPath,
      absolute: true,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    // Sort by mtime descending (most recently modified first)
    const sorted = files
      .map((f) => {
        try {
          return { path: f, mtime: statSync(f).mtimeMs };
        } catch {
          return { path: f, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => f.path);

    const capped = sorted.slice(0, MAX_RESULTS);
    const notice =
      sorted.length > MAX_RESULTS
        ? `\n... (showing ${MAX_RESULTS} of ${sorted.length} results)`
        : "";

    return {
      output: capped.length > 0 ? capped.join("\n") + notice : "No files matched",
      isError: false,
    };
  } catch (err) {
    const e = err as Error;
    return { output: `Error: ${e.message}`, isError: true };
  }
}
