import type Database from "better-sqlite3";
import type { ModelClient } from "../client.js";
import type { AgentConfig } from "../types.js";
import type { LocalEmbedder } from "./embedder.js";
import { serializeEmbedding } from "./embedder.js";
import {
  getPendingObservations,
  insertObservation,
  markObservationsProcessed,
  upsertMemory,
} from "./store.js";
import type { Memory, Observation } from "./store.js";

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Given a set of observations from a coding assistant session, identify and extract the most important facts worth remembering for future sessions.

Extract memories of these types:
- "user": Facts about the user's role, preferences, expertise, or working style
- "feedback": Explicit corrections or preferences ("don't do X", "always use Y")
- "project": Important facts about the project, architecture, or ongoing work
- "reference": Pointers to external resources, docs, or systems

Rules:
- Skip trivial observations (routine file reads, simple queries)
- Prefer updating existing memories over creating duplicates
- Each memory should be a crisp, specific fact
- IDs should be short slugs (e.g., "user-typescript-expert", "feedback-no-mocks")

Respond with a JSON array only, no other text:
[
  {
    "type": "feedback|user|project|reference",
    "id": "slug-id",
    "summary": "One-line summary",
    "content": "Full detail of the memory"
  }
]

If nothing worth remembering, respond with: []

Observations to process:
`;

export async function extractFromObservations(
  observations: Observation[],
  db: Database.Database,
  client: ModelClient,
  embedder: LocalEmbedder,
  _config: AgentConfig,
): Promise<void> {
  if (observations.length === 0) return;

  const obsText = observations.map((o) => `[${o.hook}] ${o.data}`).join("\n");

  let responseText = "";
  try {
    for await (const chunk of client.streamChat(
      [
        {
          role: "system",
          content:
            "You extract memories from coding assistant sessions. Always respond with valid JSON only.",
        },
        { role: "user", content: EXTRACTION_PROMPT + obsText },
      ],
      [],
    )) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) responseText += delta;
    }

    const parsed = parseExtractionResponse(responseText);
    const now = new Date().toISOString();

    for (const item of parsed) {
      const embeddingText = `${item.summary} ${item.content}`;
      let embedding: Buffer | null = null;
      try {
        const vec = await embedder.embed(embeddingText);
        embedding = serializeEmbedding(vec);
      } catch {
        // Embedding failure is non-fatal
      }

      const memory: Memory = {
        id: item.id,
        type: item.type as Memory["type"],
        summary: item.summary,
        content: item.content,
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
        lastAccessed: now,
        embedding,
      };

      upsertMemory(db, memory);
    }
  } catch {
    // Extraction failure is non-fatal — observations will remain unprocessed
    return;
  }

  markObservationsProcessed(
    db,
    observations.map((o) => o.id!),
  );
}

function parseExtractionResponse(
  text: string,
): Array<{ type: string; id: string; summary: string; content: string }> {
  try {
    // Strip markdown fences
    const cleaned = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof item.type === "string" &&
        typeof item.id === "string" &&
        typeof item.summary === "string" &&
        typeof item.content === "string" &&
        ["user", "feedback", "project", "reference"].includes(item.type),
    );
  } catch {
    return [];
  }
}

export function bufferObservation(
  db: Database.Database,
  sessionId: string,
  hook: string,
  data: unknown,
): void {
  insertObservation(db, {
    sessionId,
    hook,
    data: JSON.stringify(data),
    createdAt: new Date().toISOString(),
    processed: 0,
  });
}

export async function processPendingObservations(
  db: Database.Database,
  client: ModelClient,
  embedder: LocalEmbedder,
  config: AgentConfig,
): Promise<void> {
  const pending = getPendingObservations(db, 50);
  if (pending.length === 0) return;
  await extractFromObservations(pending, db, client, embedder, config);
}
