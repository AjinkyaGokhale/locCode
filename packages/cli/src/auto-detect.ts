const CANDIDATES = [
  { url: "http://localhost:11434/v1", label: "Ollama" },
  { url: "http://localhost:1234/v1", label: "LM Studio" },
  { url: "http://localhost:8080/v1", label: "llama.cpp" },
  { url: "http://localhost:8001/v1", label: "llama.cpp" },
];

interface ProbeResult {
  available: boolean;
  models: string[];
}

async function probeEndpoint(baseUrl: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    // Try Ollama-style first: GET /api/tags
    const ollamaUrl = `${baseUrl.replace(/\/v1\/?$/, "")}/api/tags`;
    const resp = await fetch(ollamaUrl, { signal: controller.signal });
    if (resp.ok) {
      const data = (await resp.json()) as { models?: Array<{ name: string }> };
      const models = (data.models ?? []).map((m) => m.name).filter(Boolean);
      return { available: true, models };
    }
  } catch {
    // fall through to generic probe
  } finally {
    clearTimeout(timeout);
  }

  // Try OpenAI-style: GET /v1/models
  const controller2 = new AbortController();
  const timeout2 = setTimeout(() => controller2.abort(), 2000);
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      signal: controller2.signal,
      headers: { Authorization: "Bearer not-needed" },
    });
    if (resp.ok) {
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      const models = (data.data ?? []).map((m) => m.id).filter(Boolean);
      return { available: true, models };
    }
  } catch {
    // unavailable
  } finally {
    clearTimeout(timeout2);
  }

  return { available: false, models: [] };
}

export interface DetectResult {
  url: string;
  model: string;
  label: string;
}

export async function detectBackend(): Promise<DetectResult | null> {
  for (const candidate of CANDIDATES) {
    const result = await probeEndpoint(candidate.url);
    if (result.available) {
      return {
        url: candidate.url,
        model: result.models[0] ?? "",
        label: candidate.label,
      };
    }
  }
  return null;
}

export function printNoBackendError(): void {
  process.stderr.write(
    [
      "",
      "No local model backend found. Start one of:",
      "",
      "  Ollama     → ollama serve  (then: ollama pull qwen2.5-coder:7b)",
      "  LM Studio  → Open the app and load a model",
      "  llama.cpp  → ./server -m your-model.gguf",
      "",
      "Or specify a URL directly:  loccode --url http://localhost:11434/v1",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
