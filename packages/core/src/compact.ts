import type { ModelClient } from "./client.js";
import type { Session } from "./session.js";
import type { AgentConfig, ConversationMessage } from "./types.js";

export function estimateTokens(session: Session): number {
  // ~4 chars per token heuristic
  let total = 0;
  for (const msg of session.messages) {
    for (const block of msg.blocks) {
      if (block.type === "text") {
        total += Math.ceil(block.text.length / 4);
      } else if (block.type === "tool_use") {
        total += Math.ceil((block.name.length + block.input.length) / 4);
      } else if (block.type === "tool_result") {
        total += Math.ceil((block.toolName.length + block.output.length) / 4);
      }
    }
  }
  return total;
}

export function shouldCompact(session: Session, maxTokens: number): boolean {
  return session.messages.length > 4 && estimateTokens(session) >= maxTokens;
}

export async function compactSession(
  client: ModelClient,
  session: Session,
  _config: AgentConfig,
): Promise<void> {
  const keepCount = 4;
  if (session.messages.length <= keepCount) return;

  const toSummarize = session.messages.slice(0, session.messages.length - keepCount);
  const toKeep = session.messages.slice(-keepCount);

  // Build a plain-text representation of old messages for the model to summarize
  const historyText = toSummarize
    .map((msg) => {
      const role = msg.role.toUpperCase();
      const content = msg.blocks
        .map((b) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use") return `[Tool: ${b.name}] ${b.input}`;
          if (b.type === "tool_result") {
            return `[Result: ${b.toolName}] ${b.isError ? "ERROR: " : ""}${b.output.slice(0, 500)}`;
          }
          return "";
        })
        .join("\n");
      return `${role}:\n${content}`;
    })
    .join("\n\n");

  const summaryPrompt: ConversationMessage[] = [
    {
      role: "user",
      blocks: [
        {
          type: "text",
          text: `Summarize this conversation history concisely as bullet points. Focus on: what the user asked for, what files were read/edited, what commands were run, and what was accomplished.\n\n${historyText}`,
        },
      ],
    },
  ];

  let summary = "";
  for await (const chunk of client.streamChat(
    summaryPrompt.map((m) => ({
      role: m.role as "user",
      content: m.blocks.map((b) => (b.type === "text" ? b.text : "")).join(""),
    })),
  )) {
    summary += chunk.choices[0]?.delta?.content ?? "";
  }

  const summaryMessage: ConversationMessage = {
    role: "system",
    blocks: [{ type: "text", text: `<summary>\n${summary.trim()}\n</summary>` }],
  };

  session.messages = [summaryMessage, ...toKeep];
}
