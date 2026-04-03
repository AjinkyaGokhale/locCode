import type Database from "better-sqlite3";
import type { LocalEmbedder } from "./embedder.js";
import { hybridSearch } from "./search.js";
import type { SearchResult } from "./search.js";

const TYPE_PRIORITY: Record<string, number> = {
  feedback: 4,
  user: 3,
  project: 2,
  reference: 1,
};

/** Retrieve memories relevant to the query and format for system prompt injection */
export async function retrieveForPrompt(
  query: string,
  db: Database.Database,
  embedder: LocalEmbedder,
  tokenBudget = 2000,
): Promise<string> {
  const results = await hybridSearch(query, db, embedder, { limit: 20 });
  if (results.length === 0) return "";

  // Sort by type priority first, then by score
  results.sort((a, b) => {
    const pa = TYPE_PRIORITY[a.type] ?? 0;
    const pb = TYPE_PRIORITY[b.type] ?? 0;
    if (pa !== pb) return pb - pa;
    return b.score - a.score;
  });

  const charBudget = tokenBudget * 4; // ~4 chars per token
  const lines: string[] = ["=== Relevant Memories ==="];
  let usedChars = lines[0].length + 1;

  // Ensure at least 1 of each type if available
  const byType = new Map<string, SearchResult[]>();
  for (const r of results) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type)!.push(r);
  }

  const prioritized: SearchResult[] = [];
  for (const type of ["feedback", "user", "project", "reference"]) {
    const items = byType.get(type);
    if (items && items.length > 0) {
      prioritized.push(items[0]);
    }
  }
  // Add remaining results
  for (const r of results) {
    if (!prioritized.includes(r)) prioritized.push(r);
  }

  for (const r of prioritized) {
    const line = `[${r.type}] ${r.summary}: ${r.content}`;
    if (usedChars + line.length + 1 > charBudget) {
      // Try truncating content
      const maxContent = charBudget - usedChars - `[${r.type}] ${r.summary}: `.length - 5;
      if (maxContent > 50) {
        lines.push(`[${r.type}] ${r.summary}: ${r.content.slice(0, maxContent)}...`);
        usedChars += maxContent + 50;
      }
      break;
    }
    lines.push(line);
    usedChars += line.length + 1;
  }

  return lines.join("\n");
}
