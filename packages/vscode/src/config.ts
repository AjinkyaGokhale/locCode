import * as vscode from "vscode";
import type { AgentConfig } from "@loccode/core";

const CANDIDATES = [
  { url: "http://localhost:11434/v1", label: "Ollama" },
  { url: "http://localhost:1234/v1", label: "LM Studio" },
  { url: "http://localhost:8080/v1", label: "llama.cpp" },
  { url: "http://localhost:8001/v1", label: "llama.cpp" },
  { url: "http://127.0.0.1:8080/v1", label: "llama.cpp" },
  { url: "http://127.0.0.1:8001/v1", label: "llama.cpp" },
];

async function probeForModel(baseUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const ollamaUrl = `${baseUrl.replace(/\/v1\/?$/, "")}/api/tags`;
    const resp = await fetch(ollamaUrl, { signal: controller.signal });
    if (resp.ok) {
      const data = (await resp.json()) as { models?: Array<{ name: string }> };
      return data.models?.[0]?.name ?? null;
    }
  } catch {
    // fall through
  } finally {
    clearTimeout(timer);
  }

  const controller2 = new AbortController();
  const timer2 = setTimeout(() => controller2.abort(), 2000);
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      signal: controller2.signal,
      headers: { Authorization: "Bearer not-needed" },
    });
    if (resp.ok) {
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      return data.data?.[0]?.id ?? null;
    }
  } catch {
    // unavailable
  } finally {
    clearTimeout(timer2);
  }

  return null;
}

export async function getAgentConfig(): Promise<AgentConfig> {
  const cfg = vscode.workspace.getConfiguration("loccode");
  let baseUrl: string = cfg.get("baseUrl") ?? "http://localhost:11434/v1";
  let model: string = cfg.get("model") ?? "";
  const apiKey: string = cfg.get("apiKey") ?? "";
  const permissionMode: AgentConfig["permissionMode"] =
    cfg.get("permissionMode") ?? "workspace-write";
  const maxIterations: number = cfg.get("maxIterations") ?? 6;

  // Auto-detect: if model is blank, probe candidates for baseUrl + model
  if (!model) {
    for (const candidate of CANDIDATES) {
      const found = await probeForModel(candidate.url);
      if (found) {
        baseUrl = candidate.url;
        model = found;
        break;
      }
    }
  }

  const cwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  return {
    baseUrl,
    model,
    apiKey,
    permissionMode,
    maxIterations,
    maxTokensBeforeCompact: 8000,
    cwd,
    fewShotExamples: false,
  };
}

export function onConfigChange(
  callback: (config: Promise<AgentConfig>) => void,
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("loccode")) {
      callback(getAgentConfig());
    }
  });
}
