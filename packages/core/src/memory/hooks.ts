// Lifecycle hooks that wire memory observation into the agent loop

export interface SessionStartContext {
  sessionId: string;
  model: string;
  cwd: string;
  timestamp: string;
}

export interface PromptSubmitContext {
  userMessage: string;
  sessionId: string;
  timestamp: string;
}

export interface PostToolUseContext {
  toolName: string;
  input: unknown;
  output: string;
  isError: boolean;
  sessionId: string;
}

export interface StopContext {
  turnMessages: unknown[];
  sessionId: string;
}

export interface SessionEndContext {
  sessionId: string;
  turnCount: number;
  tokenUsage: number;
}

export interface LifecycleHooks {
  onSessionStart(ctx: SessionStartContext): void;
  onUserPromptSubmit(ctx: PromptSubmitContext): void;
  onPostToolUse(ctx: PostToolUseContext): void;
  onStop(ctx: StopContext): void;
  onSessionEnd(ctx: SessionEndContext): void;
}

export interface MemoryWorkerClient {
  hook(hookName: string, payload: unknown): Promise<void>;
  search(query: string, tokenBudget: number): Promise<string>;
  isRunning(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createMemoryHooks(worker: MemoryWorkerClient): LifecycleHooks {
  return {
    onSessionStart(ctx) {
      worker.hook("onSessionStart", ctx).catch(() => {});
    },
    onUserPromptSubmit(ctx) {
      // Eagerly detect feedback patterns
      const feedbackPatterns = /\b(don't|always|never|stop|instead|avoid|please don't)\b/i;
      if (feedbackPatterns.test(ctx.userMessage)) {
        worker.hook("onUserPromptSubmit:feedback", ctx).catch(() => {});
      }
      worker.hook("onUserPromptSubmit", ctx).catch(() => {});
    },
    onPostToolUse(ctx) {
      // Fire-and-forget, non-blocking
      Promise.resolve().then(() => worker.hook("onPostToolUse", ctx).catch(() => {}));
    },
    onStop(ctx) {
      worker.hook("onStop", ctx).catch(() => {});
    },
    onSessionEnd(ctx) {
      worker.hook("onSessionEnd", ctx).catch(() => {});
    },
  };
}

/** No-op hooks for when memory worker is not available */
export function createNoopHooks(): LifecycleHooks {
  return {
    onSessionStart: () => {},
    onUserPromptSubmit: () => {},
    onPostToolUse: () => {},
    onStop: () => {},
    onSessionEnd: () => {},
  };
}
