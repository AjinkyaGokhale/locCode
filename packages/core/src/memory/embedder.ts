// Local embedding model using all-MiniLM-L6-v2 via @xenova/transformers

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransformersPipeline = any;

export function serializeEmbedding(v: Float32Array): Buffer {
  return Buffer.from(v.buffer);
}

export function deserializeEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Vectors are already normalized (normalize: true in pipeline)
  // so cosine similarity = dot product
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export class LocalEmbedder {
  private pipe: TransformersPipeline | null = null;

  async init(): Promise<void> {
    const { pipeline } = await import("@xenova/transformers");
    this.pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.log("Embedding model loaded (all-MiniLM-L6-v2)");
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) await this.init();
    const output = await this.pipe?.(text, { pooling: "mean", normalize: true });
    return output.data as Float32Array;
  }

  async batchEmbed(texts: string[]): Promise<Float32Array[]> {
    const BATCH_SIZE = 32;
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      for (const text of batch) {
        results.push(await this.embed(text));
      }
    }
    return results;
  }
}
