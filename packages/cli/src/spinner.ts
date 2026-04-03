import { CYAN, DARK_GRAY, R } from "./render.js";

// Modern spinner frames
const FRAMES   = ["⠧","⠇","⠏","⠃","⠏","⠇","⠉","⠙","⠸","⠼","⠴","⠦"];
const INTERVAL = 80;

let timer:   ReturnType<typeof setInterval> | null = null;
let frameIdx = 0;
let msg      = "";
let startMs  = 0;

const clear = () => process.stdout.write("\r\x1B[K");

function draw(): void {
  const frame = `${CYAN}${FRAMES[frameIdx++ % FRAMES.length]}${R}`;
  const secs  = ((Date.now() - startMs) / 1000).toFixed(1);
  process.stdout.write(`\r  ${frame} ${msg} ${DARK_GRAY}(${secs}s)${R}`);
}

export function start(message: string): void {
  if (timer) stop();
  msg      = message;
  frameIdx = 0;
  startMs  = Date.now();
  process.stdout.write("\x1B[?25l");
  draw();
  timer = setInterval(draw, INTERVAL);
}

export function update(message: string): void { msg = message; }

export function stop(final?: string): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  clear();
  process.stdout.write("\x1B[?25h");
  if (final) process.stdout.write(`${final}\n`);
}

export function isSpinning(): boolean { return timer !== null; }
