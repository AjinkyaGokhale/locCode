import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig, ToolDefinition } from "./types.js";

const INSTRUCTION_FILENAMES = ["CLAUDE.md", ".claude/CLAUDE.md", ".loccode.md"];

export function discoverInstructionFile(cwd: string): string | null {
  let dir = cwd;
  // Walk up to root
  while (true) {
    for (const name of INSTRUCTION_FILENAMES) {
      const full = join(dir, name);
      if (existsSync(full)) {
        return readFileSync(full, "utf8");
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

function formatTools(tools: ToolDefinition[]): string {
  return tools.map((t) => `- **${t.name}**: ${t.description}`).join("\n");
}

const STANDARD_PROMPT = (
  cwd: string,
  platform: string,
  model: string,
  tools: ToolDefinition[],
  projectContext: string | null,
) => `You are an AI coding assistant with access to tools for reading, writing, and searching files, and executing shell commands.

## Environment
- Working directory: ${cwd}
- Date: ${new Date().toISOString().slice(0, 10)}
- Platform: ${platform}
- Model: ${model}

## Available Tools
${formatTools(tools)}

## Rules
- Read files before editing them
- Use edit_file for modifications, not write_file (preserves unchanged content)
- Use grep_search and glob_search to find code, not bash with grep/find
- Do not execute dangerous commands (rm -rf, format, etc.)
- When done with a task, summarize what you did
${projectContext ? `\n## Project Context\n${projectContext}` : ""}`;

const FEW_SHOT_EXAMPLES = `
## IMPORTANT: Tool Call Format
When you want to use a tool, use the tool call format your API expects.
Do NOT wrap tool calls in markdown. Do NOT add explanation before a tool call.

## Examples

User: "List all TypeScript files in src/"
Think: I need to search for .ts files.
Call: glob_search({"pattern": "src/**/*.ts"})

User: "What does the main function do?"
Think: I need to find and read the main entry point.
Call: grep_search({"pattern": "function main|const main", "path": "src/"})
[After results]
Call: read_file({"path": "src/main.ts"})
[After results]
The main function initializes the application by...

User: "Fix the typo on line 5 of README.md"
Call: read_file({"path": "README.md"})
[After results showing line 5 has "teh"]
Call: edit_file({"path": "README.md", "old_string": "teh", "new_string": "the"})
Fixed the typo "teh" → "the" on line 5.`;

export function buildSystemPrompt(
  config: AgentConfig,
  tools: ToolDefinition[],
  projectContext?: string | null,
): string {
  const platform = process.platform;
  let prompt = STANDARD_PROMPT(config.cwd, platform, config.model, tools, projectContext ?? null);
  if (config.fewShotExamples) {
    prompt += FEW_SHOT_EXAMPLES;
  }
  return prompt;
}
