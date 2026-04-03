import type { AgentConfig } from "./types.js";

export type PermissionOutcome = "allow" | "deny" | "prompt";

export interface PermissionResult {
  outcome: PermissionOutcome;
  reason: string;
}

export interface PermissionPolicy {
  authorize(toolName: string, input: Record<string, unknown>): PermissionResult | Promise<PermissionResult>;
}

// Tools that are always read-only and safe
const READ_ONLY_TOOLS = new Set(["read_file", "glob_search", "grep_search"]);
// Tools that write to the workspace
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

export function createPermissionPolicy(mode: AgentConfig["permissionMode"]): PermissionPolicy {
  return {
    authorize(toolName, _input): PermissionResult {
      switch (mode) {
        case "read-only":
          if (READ_ONLY_TOOLS.has(toolName)) {
            return { outcome: "allow", reason: "" };
          }
          return { outcome: "deny", reason: `Tool "${toolName}" is not allowed in read-only mode` };

        case "workspace-write":
          if (READ_ONLY_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
            return { outcome: "allow", reason: "" };
          }
          if (toolName === "bash") {
            return {
              outcome: "prompt",
              reason: "bash requires confirmation in workspace-write mode",
            };
          }
          return { outcome: "deny", reason: `Unknown tool "${toolName}"` };

        case "allow-all":
          return { outcome: "allow", reason: "" };
      }
    },
  };
}
