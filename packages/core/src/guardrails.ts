import type { Session } from "./session.js";
import type { AgentConfig } from "./types.js";

export interface GuardrailResult {
  shouldStop: boolean;
  reason: string;
}

export function checkGuardrails(session: Session, _config: AgentConfig): GuardrailResult {
  const recentTools = session.getRecentToolCalls(6);
  const recentResults = session.getRecentToolResults(4);

  // 1. Three consecutive identical tool calls (same name + same input)
  if (recentTools.length >= 3) {
    const last3 = recentTools.slice(-3);
    const allSame = last3.every((t) => t.name === last3[0].name && t.input === last3[0].input);
    if (allSame) {
      return {
        shouldStop: true,
        reason: `Detected 3 consecutive identical "${last3[0].name}" calls — stopping to prevent infinite loop`,
      };
    }
  }

  // 2. Same file read more than twice
  const readCalls = recentTools.filter((t) => t.name === "read_file");
  const readCounts = new Map<string, number>();
  for (const call of readCalls) {
    readCounts.set(call.input, (readCounts.get(call.input) ?? 0) + 1);
  }
  for (const [file, count] of readCounts) {
    if (count >= 3) {
      return {
        shouldStop: true,
        reason: `File "${file}" has been read ${count} times — stopping to prevent loop`,
      };
    }
  }

  // 3. Too many consecutive errors
  if (recentResults.length >= 4 && recentResults.every((r) => r.isError)) {
    return { shouldStop: true, reason: "Last 4 tool calls all failed — stopping" };
  }

  // 4. Bash command suspiciously long (possible prompt injection or confused model)
  const lastBash = [...recentTools].reverse().find((t) => t.name === "bash");
  if (lastBash && lastBash.input.length > 2000) {
    return {
      shouldStop: true,
      reason: "Bash command exceeds 2000 characters — refusing to execute",
    };
  }

  return { shouldStop: false, reason: "" };
}
