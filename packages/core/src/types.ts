// Agent events streamed to CLI / VS Code
export type AgentEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_input"; id: string; partialInput: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_complete"; iterations: number }
  | { type: "compacted" }
  | { type: "guardrail_triggered"; reason: string }
  | { type: "error"; message: string };

// Messages stored in session
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ConversationMessage {
  role: MessageRole;
  blocks: ContentBlock[];
  usage?: TokenUsage;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: string }
  | { type: "tool_result"; toolUseId: string; toolName: string; output: string; isError: boolean };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// Tool definitions (JSON Schema input)
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  isError: boolean;
}

// Agent configuration
export interface AgentConfig {
  /** OpenAI-compatible base URL */
  baseUrl: string;
  /** Model name (e.g., "qwen2.5-coder:32b") */
  model: string;
  /** API key — empty string for local models */
  apiKey: string;
  /** Max tool-call iterations per turn (default: 6) */
  maxIterations: number;
  /** Max estimated tokens before compaction (default: 8000) */
  maxTokensBeforeCompact: number;
  /** Permission mode */
  permissionMode: "read-only" | "workspace-write" | "allow-all";
  /** Working directory */
  cwd: string;
  /** Enable few-shot examples in system prompt (helps smaller local models) */
  fewShotExamples: boolean;
}
