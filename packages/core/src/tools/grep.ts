import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import fg from "fast-glob";
import type { AgentConfig, ToolResult } from "../types.js";

const MAX_MATCHES = 100;

interface Match {
  path: string;
  line: number;
  text: string;
}

function formatMatches(matches: Match[]): string {
  return matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n");
}

async function nodeGrepSearch(
  pattern: RegExp,
  files: string[],
  contextLines: number,
): Promise<Match[]> {
  const matches: Match[] = [];
  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break;
    const rl = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const lines: string[] = [];
    for await (const line of rl) {
      lines.push(line);
    }
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        // Include context lines
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        for (let j = start; j <= end; j++) {
          if (j === i || contextLines === 0) {
            matches.push({ path: file, line: j + 1, text: lines[j] });
          }
        }
        if (matches.length >= MAX_MATCHES) break;
      }
    }
  }
  return matches;
}

export async function executeGrep(
  input: Record<string, unknown>,
  config: AgentConfig,
): Promise<ToolResult> {
  const pattern = input.pattern;
  if (typeof pattern !== "string" || !pattern.trim()) {
    return { output: "Error: pattern is required", isError: true };
  }

  const searchPath = typeof input.path === "string" ? resolve(config.cwd, input.path) : config.cwd;
  const glob = typeof input.glob === "string" ? input.glob : "**/*";
  const contextLines = typeof input.include_context === "number" ? input.include_context : 0;

  // Try ripgrep first
  const rgArgs = ["--line-number", "--no-heading", `--context=${contextLines}`, "-e", pattern];
  if (typeof input.glob === "string") {
    rgArgs.push("--glob", input.glob);
  }
  rgArgs.push(searchPath);

  const rg = spawnSync("rg", rgArgs, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });

  if (rg.error === null || (rg.error as NodeJS.ErrnoException)?.code !== "ENOENT") {
    const output = (rg.stdout ?? "").trim();
    if (!output) return { output: "No matches found", isError: false };

    const lines = output.split("\n");
    const capped = lines.slice(0, MAX_MATCHES);
    const notice =
      lines.length > MAX_MATCHES ? `\n... (showing ${MAX_MATCHES} of ${lines.length} matches)` : "";
    return { output: capped.join("\n") + notice, isError: false };
  }

  // Fallback: Node.js readline scan
  try {
    const files = await fg(glob, {
      cwd: searchPath,
      absolute: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    const regex = new RegExp(pattern);
    const matches = await nodeGrepSearch(regex, files, contextLines);

    if (matches.length === 0) return { output: "No matches found", isError: false };

    const capped = matches.slice(0, MAX_MATCHES);
    const notice =
      matches.length > MAX_MATCHES
        ? `\n... (showing ${MAX_MATCHES} of ${matches.length} matches)`
        : "";
    return { output: formatMatches(capped) + notice, isError: false };
  } catch (err) {
    const e = err as Error;
    return { output: `Error: ${e.message}`, isError: true };
  }
}
