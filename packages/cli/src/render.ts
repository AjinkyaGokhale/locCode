// ─── ANSI helpers ─────────────────────────────────────────────────────────────
export const R     = "\x1B[0m";
export const BOLD  = "\x1B[1m";
export const DIM   = "\x1B[2m";
export const ITALIC = "\x1B[3m";
export const UNDERLINE = "\x1B[4m";

// Modern palette inspired by Claude Code / terminal theming
export const RED     = "\x1B[38;2;244;90;97m";    // Soft red
export const GREEN   = "\x1B[38;2;112;244;118m";  // Mint green
export const YELLOW  = "\x1B[38;2;250;204;21m";   // Amber
export const ORANGE  = "\x1B[38;2;255;155;80m";   // Warm orange
export const CYAN    = "\x1B[38;2;100;220;255m";  // Sky blue
export const BLUE    = "\x1B[38;2;100;150;255m";  // Bright blue
export const MAGENTA = "\x1B[38;2;255;100;200m";  // Purple accent
export const WHITE   = "\x1B[38;2;240;240;240m";  // Off-white
export const GRAY    = "\x1B[38;2;120;120;120m";  // Medium gray
export const DARK_GRAY = "\x1B[38;2;80;80;80m";   // Dark gray
export const BG_DARK = "\x1B[48;2;30;30;30m";     // Dark background

// Primary brand color (Coral #C76B6B)
export const PRIMARY   = "\x1B[38;2;199;107;107m";
export const PRIMARY_BG = "\x1B[48;2;199;107;107m";
export const PRIMARY_DIM = "\x1B[38;2;150;80;80m";

// ─── Terminal geometry ────────────────────────────────────────────────────────
export function tw(): number {
  return Math.min(process.stdout.columns ?? 80, 120);
}

function line(ch = "─", color = DARK_GRAY): string {
  return `${color}${ch.repeat(process.stdout.columns ?? 80)}${R}`;
}

function pad(n: number): string { return " ".repeat(n); }

// ─── Logo ─────────────────────────────────────────────────────────────────────
// Modern styled logo with gradient effect
const LOGO_BLOCK = [
  `${PRIMARY_DIM}┌─────────────┐`,
  `${PRIMARY_DIM}│${PRIMARY}  LC  ${PRIMARY_DIM}│`,
  `${PRIMARY_DIM}└─────────────┘`,
];

export function renderLogo(): string {
  return LOGO_BLOCK.join("\n");
}

// ─── Header ───────────────────────────────────────────────────────────────────
export function renderHeader(model: string, url: string, version: string): void {
  const host = url.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "");

  const out = [
    "",
    `  ${PRIMARY}${BOLD}  loccode v${version}${R}`,
    "",
    `  ${DARK_GRAY}Model   ${R}${BLUE}${ITALIC}${model}${R}`,
    `  ${DARK_GRAY}Server  ${R}${CYAN}${ITALIC}${host}${R}`,
    "",
    `${line()}`,
    `  ${DARK_GRAY}Type ${CYAN}/help${DARK_GRAY} for commands · ${CYAN}Ctrl+C${DARK_GRAY} to exit${R}`,
    `${line()}`,
    "",
  ].join("\n");
  process.stdout.write(out);
}

// ─── Input prompt area ────────────────────────────────────────────────────────
/** Top border — drawn by doPrompt() before the bottom frame + rl.prompt() */
export function renderInputTop(): string {
  const w = process.stdout.columns ?? 80;
  return "\n" + DARK_GRAY + "─".repeat(w) + R + "\n";
}

/** Bottom border + patience hint — drawn below the input line via cursor tricks */
export function renderInputBottom(): string {
  const w = process.stdout.columns ?? 80;
  const divLine = DARK_GRAY + "─".repeat(w) + R;
  const patience = "Please be Patient! I am local model";
  const padding = " ".repeat(Math.max(0, w - patience.length));
  const patienceLine = padding + GRAY + patience + R;
  return divLine + "\n" + patienceLine; // no trailing newline — caller handles cursor position
}

/** The actual readline prompt string */
export const PROMPT_STR = `  ${PRIMARY}❯${R} ${WHITE}`;

// ─── User bubble ──────────────────────────────────────────────────────────────
export function renderUserBubble(text: string): string {
  const inner = tw() - 8;
  const words = text.split(" ");
  const wrapped: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur ? cur + " " + w : w).length <= inner) {
      cur = cur ? `${cur} ${w}` : w;
    } else {
      if (cur) wrapped.push(cur);
      let word = w;
      while (word.length > inner) {
        wrapped.push(word.slice(0, inner));
        word = word.slice(inner);
      }
      cur = word;
    }
  }
  if (cur) wrapped.push(cur);

  const rows = wrapped.map(l => `  ${l}${R}`);
  return [
    "",
    `  ${BLUE}${BOLD}●${R} ${WHITE}${wrapped[0]}${R}`,
    ...rows.slice(1).map(r => r),
    "",
  ].join("\n");
}

// ─── Assistant response box ───────────────────────────────────────────────────
export function renderAssistantBoxStart(): string {
  return [
    "",
    `  ${MAGENTA}${BOLD}●${R} ${GRAY}loccode assistant${R}`,
    "",
  ].join("\n");
}

export function renderAssistantBoxEnd(inputTokens: number, outputTokens: number): string {
  const usage = (inputTokens > 0 || outputTokens > 0)
    ? `  ${DARK_GRAY}↑ ${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out tokens${R}\n`
    : "";
  return usage + "\n";
}

/**
 * Stateful writer that prefixes each new line so streaming
 * text appears nicely formatted.
 */
export class BoxStreamWriter {
  private atLineStart = true;

  write(chunk: string): void {
    for (const ch of chunk) {
      if (this.atLineStart) {
        process.stdout.write(`  `);
        this.atLineStart = false;
      }
      process.stdout.write(ch);
      if (ch === "\n") this.atLineStart = true;
    }
  }

  /** Ensure we end on a fresh line */
  flush(): void {
    if (!this.atLineStart) {
      process.stdout.write("\n");
      this.atLineStart = true;
    }
  }
}

// ─── Tool lines ───────────────────────────────────────────────────────────────
export function renderToolStart(name: string, input: Record<string, unknown>): string {
  const val =
    input.command ?? input.path ?? input.pattern ?? input.query ??
    Object.values(input)[0];
  const arg = val != null
    ? String(val).slice(0, Math.max(tw() - name.length - 14, 10))
    : "";
  const argStr = arg ? ` ${DARK_GRAY}${arg}${R}` : "";
  return `\n  ${ORANGE}⚡${R} ${CYAN}${BOLD}${name}${R}${argStr}\n`;
}

export function renderToolResult(
  name: string,
  output: string,
  isError: boolean,
  elapsedMs?: number,
): string {
  const timeStr = elapsedMs != null ? ` ${DARK_GRAY}${(elapsedMs / 1000).toFixed(2)}s${R}` : "";
  if (isError) {
    const preview = output.split("\n")[0]?.slice(0, 70) ?? output;
    return `  ${RED}✗${R} ${name}: ${RED}${preview}${R}${timeStr}\n`;
  }
  const nonEmpty = output.split("\n").filter(l => l.trim());
  const preview  = (nonEmpty[0] ?? "").slice(0, 60);
  const extra    = nonEmpty.length > 1 ? ` ${DARK_GRAY}+${nonEmpty.length - 1} lines${R}` : "";
  return `  ${GREEN}✓${R} ${name}: ${GRAY}${preview}${R}${extra}${timeStr}\n`;
}

// ─── Status / info / error ────────────────────────────────────────────────────
export function renderUsage(inputTokens: number, outputTokens: number): string {
  return `  ${DARK_GRAY}↑ ${inputTokens.toLocaleString()} in · ↓ ${outputTokens.toLocaleString()} out tokens${R}\n`;
}

export function renderGuardrail(reason: string): string {
  return `\n  ${YELLOW}⚠️ ${reason}${R}\n`;
}

export function renderError(msg: string): string {
  return `\n  ${RED}✗ ${msg}${R}\n`;
}

export function renderInfo(msg: string): string {
  return `  ${GRAY}${msg}${R}\n`;
}

export function renderSuccess(msg: string): string {
  return `  ${GREEN}✓ ${msg}${R}\n`;
}

// ─── Help ─────────────────────────────────────────────────────────────────────
export function renderHelp(): string {
  const row = (cmd: string, desc: string) =>
    `  ${CYAN}${BOLD}${cmd.padEnd(24)}${R}${GRAY}${desc}${R}`;
  return [
    "",
    `  ${BOLD}${WHITE}Commands${R}`,
    `  ${line()}`,
    row("/help",               "Show this help menu"),
    row("/status",             "Session info — model, tokens, messages"),
    row("/compact",            "Summarize and compress conversation history"),
    row("/clear",              "Reset conversation history"),
    row("/save [path]",        "Save session to JSON file"),
    row("/load <path>",        "Load session from JSON file"),
    row("/tools",              "List available tools"),
    row("/permission <mode>",  "read-only | workspace-write | allow-all"),
    row("/model <name>",       "Switch model for this session"),
    row("/exit",               "Exit loccode"),
    "",
  ].join("\n");
}

// ─── Status panel ─────────────────────────────────────────────────────────────
export function renderStatus(fields: Record<string, string>): string {
  const kLen = Math.max(...Object.keys(fields).map(k => k.length));
  const rows = Object.entries(fields).map(
    ([k, v]) => `  ${DARK_GRAY}${k.padEnd(kLen + 2)}${R}${WHITE}${v}${R}`
  );
  return [
    "",
    `  ${BOLD}${WHITE}Session Status${R}`,
    `  ${line()}`,
    ...rows,
    "",
  ].join("\n");
}

// ─── Tools table ──────────────────────────────────────────────────────────────
export function renderToolsTable(tools: Array<{ name: string; description: string }>): string {
  const nLen   = Math.max(...tools.map(t => t.name.length));
  const dMax   = tw() - nLen - 8;
  const rows   = tools.map(t => {
    const desc = t.description.length > dMax
      ? `${t.description.slice(0, dMax - 1)}…`
      : t.description;
    return `  ${CYAN}${BOLD}${t.name.padEnd(nLen + 2)}${R}${GRAY}${desc}${R}`;
  });
  return [
    "",
    `  ${BOLD}${WHITE}Available Tools${R}`,
    `  ${line()}`,
    ...rows,
    "",
  ].join("\n");
}
