const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

let timer: ReturnType<typeof setInterval> | null = null;
let frameIdx = 0;
let currentMessage = "";

function clear(): void {
  process.stdout.write("\r\x1B[K"); // carriage return + clear line
}

function draw(): void {
  process.stdout.write(`\r${FRAMES[frameIdx % FRAMES.length]} ${currentMessage}`);
  frameIdx++;
}

export function start(message: string): void {
  if (timer) stop();
  currentMessage = message;
  frameIdx = 0;
  process.stdout.write("\x1B[?25l"); // hide cursor
  draw();
  timer = setInterval(draw, INTERVAL_MS);
}

export function update(message: string): void {
  currentMessage = message;
}

export function stop(finalMessage?: string): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  clear();
  process.stdout.write("\x1B[?25h"); // restore cursor
  if (finalMessage) process.stdout.write(`${finalMessage}\n`);
}

export function isSpinning(): boolean {
  return timer !== null;
}
