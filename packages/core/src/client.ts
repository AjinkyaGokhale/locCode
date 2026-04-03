import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export interface ModelClient {
  streamChat(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
  ): AsyncIterable<ChatCompletionChunk>;
}

export function createClient(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): ModelClient {
  const openai = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey || "not-needed",
  });

  return {
    async *streamChat(messages, tools) {
      const hasTools = Boolean(tools?.length);
      const stream = await openai.chat.completions.create({
        model: config.model,
        messages,
        // Only pass tools array when non-empty — some backends reject empty arrays
        ...(hasTools ? { tools: tools as ChatCompletionTool[] } : {}),
        stream: true,
        stream_options: { include_usage: true },
      });
      for await (const chunk of stream) {
        yield chunk;
      }
    },
  };
}
