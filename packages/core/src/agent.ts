import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import type { ModelClient } from "./client.js";
import { compactSession, shouldCompact } from "./compact.js";
import { checkGuardrails } from "./guardrails.js";
import type { PermissionPolicy } from "./permissions.js";
import { buildSystemPrompt, discoverInstructionFile } from "./prompt.js";
import { recoverToolInput } from "./recovery.js";
import type { Session } from "./session.js";
import { TOOL_DEFINITIONS, executeTool, toOpenAITool } from "./tools/index.js";
import type { AgentConfig, AgentEvent, ContentBlock } from "./types.js";

function buildApiMessages(session: Session, config: AgentConfig): ChatCompletionMessageParam[] {
  const projectContext = discoverInstructionFile(config.cwd);
  const systemPrompt = buildSystemPrompt(config, TOOL_DEFINITIONS, projectContext);

  const result: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

  for (const msg of session.messages) {
    if (msg.role === "system") {
      const text = msg.blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
      result.push({ role: "system", content: text });
    } else if (msg.role === "user") {
      const text = msg.blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
      result.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: NonNullable<ChatCompletionAssistantMessageParam["tool_calls"]> = [];

      for (const block of msg.blocks) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: block.input },
          });
        }
      }

      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: textParts.join("") || null,
      };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      result.push(assistantMsg);
    } else if (msg.role === "tool") {
      for (const block of msg.blocks) {
        if (block.type === "tool_result") {
          const toolMsg: ChatCompletionToolMessageParam = {
            role: "tool",
            tool_call_id: block.toolUseId,
            content: block.isError ? `ERROR: ${block.output}` : block.output,
          };
          result.push(toolMsg);
        }
      }
    }
  }

  return result;
}

export async function* runTurn(
  client: ModelClient,
  session: Session,
  userInput: string,
  config: AgentConfig,
  permissionPolicy: PermissionPolicy,
): AsyncGenerator<AgentEvent> {
  session.appendUser(userInput);

  const apiTools = TOOL_DEFINITIONS.map(toOpenAITool) as ChatCompletionTool[];
  let iteration = 0;

  for (; iteration < config.maxIterations; iteration++) {
    const apiMessages = buildApiMessages(session, config);
    const assistantBlocks: ContentBlock[] = [];
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();

    // Stream model response
    for await (const chunk of client.streamChat(apiMessages, apiTools)) {
      const choice = chunk.choices[0];

      if (!choice) {
        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
        continue;
      }

      const delta = choice.delta;

      if (delta?.content) {
        yield { type: "text_delta", content: delta.content };
        const last = assistantBlocks.at(-1);
        if (last?.type === "text") {
          last.text += delta.content;
        } else {
          assistantBlocks.push({ type: "text", text: delta.content });
        }
      }

      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index;
        if (!pendingToolCalls.has(idx)) {
          const id = tc.id ?? `call_${idx}`;
          pendingToolCalls.set(idx, { id, name: tc.function?.name ?? "", args: "" });
          if (tc.function?.name) {
            yield { type: "tool_call_start", id, name: tc.function.name };
          }
        }
        const pending = pendingToolCalls.get(idx)!;
        if (tc.function?.name) pending.name = tc.function.name;
        if (tc.function?.arguments) {
          pending.args += tc.function.arguments;
          yield { type: "tool_call_input", id: pending.id, partialInput: tc.function.arguments };
        }
      }

      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }

    // Record assistant message
    for (const [, tc] of pendingToolCalls) {
      assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
    }
    session.appendAssistant(assistantBlocks);

    // No tool calls → model is done
    if (pendingToolCalls.size === 0) break;

    // Execute tool calls
    for (const [, tc] of pendingToolCalls) {
      const recoveredInput = recoverToolInput(tc.args, tc.name, TOOL_DEFINITIONS);

      const permission = permissionPolicy.authorize(tc.name, recoveredInput);
      if (permission.outcome === "deny") {
        const result = { output: `Permission denied: ${permission.reason}`, isError: true };
        session.appendToolResult(tc.id, tc.name, result);
        yield { type: "tool_result", id: tc.id, name: tc.name, ...result };
        continue;
      }

      // "prompt" outcome: non-interactive default is deny.
      // CLI/VS Code layers handle the actual prompt before calling runTurn.
      if (permission.outcome === "prompt") {
        const result = {
          output: `Tool "${tc.name}" requires confirmation. Use permissionMode "allow-all" or approve interactively.`,
          isError: true,
        };
        session.appendToolResult(tc.id, tc.name, result);
        yield { type: "tool_result", id: tc.id, name: tc.name, ...result };
        continue;
      }

      const result = await executeTool(tc.name, recoveredInput, config);
      session.appendToolResult(tc.id, tc.name, result);
      yield { type: "tool_result", id: tc.id, name: tc.name, ...result };
    }

    // Guardrails
    const guardrail = checkGuardrails(session, config);
    if (guardrail.shouldStop) {
      yield { type: "guardrail_triggered", reason: guardrail.reason };
      break;
    }

    // Compact if needed
    if (shouldCompact(session, config.maxTokensBeforeCompact)) {
      await compactSession(client, session, config);
    }
  }

  yield { type: "turn_complete", iterations: iteration };
}
