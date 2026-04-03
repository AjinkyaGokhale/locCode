import type { AgentConfig, ToolDefinition, ToolResult } from "../types.js";
import { executeBash } from "./bash.js";
import { executeEditFile } from "./edit-file.js";
import { executeGlob } from "./glob.js";
import { executeGrep } from "./grep.js";
import { executeReadFile } from "./read-file.js";
import { executeWriteFile } from "./write-file.js";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "bash",
    description: "Execute a shell command and return stdout/stderr.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read a file and return its contents with line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        offset: { type: "number", description: "Start reading from this line (0-indexed)" },
        limit: { type: "number", description: "Max number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates parent directories if needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Find and replace text in a file. The old_string must match exactly (unique occurrence).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to edit" },
        old_string: { type: "string", description: "Exact text to find" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences (default: false)",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "glob_search",
    description: "Find files matching a glob pattern, sorted by most recently modified.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g., 'src/**/*.ts')" },
        path: { type: "string", description: "Directory to search in (default: cwd)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_search",
    description: "Search file contents for a regex pattern. Uses ripgrep when available.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory to search in (default: cwd)" },
        glob: { type: "string", description: "File glob filter (e.g., '*.ts')" },
        include_context: {
          type: "number",
          description: "Lines of context around matches",
        },
      },
      required: ["pattern"],
    },
  },
];

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  config: AgentConfig,
): Promise<ToolResult> {
  switch (name) {
    case "bash":
      return executeBash(input, config);
    case "read_file":
      return executeReadFile(input, config);
    case "write_file":
      return executeWriteFile(input, config);
    case "edit_file":
      return executeEditFile(input, config);
    case "glob_search":
      return executeGlob(input, config);
    case "grep_search":
      return executeGrep(input, config);
    default:
      return { output: `Unknown tool: "${name}"`, isError: true };
  }
}

/** Convert a ToolDefinition to the OpenAI tool format. */
export function toOpenAITool(tool: ToolDefinition): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}
