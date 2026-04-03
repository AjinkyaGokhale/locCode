import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// Configure marked with terminal renderer once
// @ts-expect-error — marked-terminal types are loose
marked.use(markedTerminal({ reflowText: false }));

// ANSI helpers
const DIM = "\x1B[2m";
const RESET = "\x1B[0m";
const GREEN = "\x1B[32m";
const RED = "\x1B[31m";
const YELLOW = "\x1B[33m";
const CYAN = "\x1B[36m";

export function renderMarkdown(text: string): string {
  try {
    const result = marked.parse(text);
    // marked.parse can return a Promise in some configs — handle both
    if (typeof result === "string") return result;
    return text; // fallback
  } catch {
    return text;
  }
}

export function renderToolCall(name: string, input: Record<string, unknown>): string {
  const args = JSON.stringify(input, null, 2)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return `${DIM}  ╭ tool: ${CYAN}${name}${RESET}${DIM}\n${args}${RESET}\n`;
}

export function renderToolResult(name: string, output: string, isError: boolean): string {
  if (isError) {
    const lines = output.split("\n");
    const preview = lines.slice(0, 5).join("\n");
    const extra = lines.length > 5 ? `\n${DIM}  … (${lines.length - 5} more lines)${RESET}` : "";
    return `${DIM}  ╰ ${RED}✗ ${name}${RESET}\n${RED}${preview}${RESET}${extra}\n`;
  }

  const lines = output.split("\n");
  const preview = lines.slice(0, 8).join("\n");
  const extra = lines.length > 8 ? `\n${DIM}  … (${lines.length - 8} more lines)${RESET}` : "";
  return `${DIM}  ╰ ${GREEN}✓ ${name}${RESET}${DIM}\n${preview}${extra}${RESET}\n`;
}

export function renderUsage(inputTokens: number, outputTokens: number): string {
  return `${DIM}  ↑ ${inputTokens.toLocaleString()} in  ↓ ${outputTokens.toLocaleString()} out${RESET}\n`;
}

export function renderGuardrail(reason: string): string {
  return `${YELLOW}⚠ Guardrail: ${reason}${RESET}\n`;
}

export function renderError(message: string): string {
  return `${RED}Error: ${message}${RESET}\n`;
}

export function renderInfo(message: string): string {
  return `${DIM}${message}${RESET}\n`;
}

export function renderHeader(model: string, url: string, version: string): void {
  process.stdout.write(
    [
      "",
      `  ${CYAN}loccode${RESET} ${DIM}v${version}${RESET} — ${model} via ${DIM}${url}${RESET}`,
      `  ${DIM}Type /help for commands, Ctrl+C to exit${RESET}`,
      "",
    ].join("\n"),
  );
}
