import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, ContentBlock, ConversationMessage, ToolResult } from "./types.js";

export class Session {
  readonly id: string;
  readonly createdAt: string;
  readonly config: Pick<AgentConfig, "model" | "baseUrl">;
  messages: ConversationMessage[];

  constructor(
    id: string,
    createdAt: string,
    config: Pick<AgentConfig, "model" | "baseUrl">,
    messages: ConversationMessage[] = [],
  ) {
    this.id = id;
    this.createdAt = createdAt;
    this.config = config;
    this.messages = messages;
  }

  static new(config: AgentConfig): Session {
    const now = new Date();
    const id = `session_${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    return new Session(id, now.toISOString(), { model: config.model, baseUrl: config.baseUrl });
  }

  static load(path: string): Session {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as {
      version: number;
      id: string;
      createdAt: string;
      config: Pick<AgentConfig, "model" | "baseUrl">;
      messages: ConversationMessage[];
    };
    return new Session(data.id, data.createdAt, data.config, data.messages);
  }

  save(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.id}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          id: this.id,
          createdAt: this.createdAt,
          config: this.config,
          messages: this.messages,
        },
        null,
        2,
      ),
      "utf8",
    );
    return path;
  }

  appendUser(text: string): void {
    this.messages.push({ role: "user", blocks: [{ type: "text", text }] });
  }

  appendAssistant(blocks: ContentBlock[]): void {
    this.messages.push({ role: "assistant", blocks });
  }

  appendToolResult(toolUseId: string, toolName: string, result: ToolResult): void {
    this.messages.push({
      role: "tool",
      blocks: [
        {
          type: "tool_result",
          toolUseId,
          toolName,
          output: result.output,
          isError: result.isError,
        },
      ],
    });
  }

  /** Prepend a system-level context block (used for memory injection). */
  prependSystemContext(text: string): void {
    const systemMsg: ConversationMessage = {
      role: "system",
      blocks: [{ type: "text", text }],
    };
    // Insert after any existing system messages
    let insertAt = 0;
    while (insertAt < this.messages.length && this.messages[insertAt].role === "system") {
      insertAt++;
    }
    this.messages.splice(insertAt, 0, systemMsg);
  }

  getRecentToolCalls(n: number): Array<{ name: string; input: string }> {
    const calls: Array<{ name: string; input: string }> = [];
    for (const msg of this.messages) {
      for (const block of msg.blocks) {
        if (block.type === "tool_use") {
          calls.push({ name: block.name, input: block.input });
        }
      }
    }
    return calls.slice(-n);
  }

  getRecentToolResults(n: number): Array<{ output: string; isError: boolean }> {
    const results: Array<{ output: string; isError: boolean }> = [];
    for (const msg of this.messages) {
      for (const block of msg.blocks) {
        if (block.type === "tool_result") {
          results.push({ output: block.output, isError: block.isError });
        }
      }
    }
    return results.slice(-n);
  }

  getLastTurnMessages(): ConversationMessage[] {
    // Everything since the last user message
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    return lastUserIdx >= 0 ? this.messages.slice(lastUserIdx) : [];
  }
}
