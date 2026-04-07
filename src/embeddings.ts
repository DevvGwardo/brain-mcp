/**
 * Embedding provider for semantic memory search.
 *
 * Uses the OpenAI embeddings API (text-embedding-3-small) for high-quality
 * vector search. Falls back gracefully when no API key is available.
 * Zero new dependencies — uses Node 18+ built-in fetch().
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
}

// ── LRU Cache ──────────────────────────────────────────────────────────────

class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.maxSize) {
      // Delete oldest entry
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
  }
}

// ── OpenAI Embedding Provider ──────────────────────────────────────────────

const DIMENSION_MAP: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private cache = new LRUCache<string, Float32Array>(100);

  constructor(
    private apiKey: string,
    private model = 'text-embedding-3-small',
    private baseUrl = 'https://api.openai.com/v1',
  ) {
    this.dimensions = DIMENSION_MAP[model] || 1536;
  }

  async embed(text: string): Promise<Float32Array> {
    const cached = this.cache.get(text);
    if (cached) return cached;

    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Check cache first
    const results: (Float32Array | null)[] = texts.map(t => this.cache.get(t) ?? null);
    const uncached = texts.filter((_, i) => results[i] === null);

    if (uncached.length === 0) return results as Float32Array[];

    // Call API for uncached texts (max 2048 inputs per request)
    const allEmbeddings: Float32Array[] = [];
    for (let i = 0; i < uncached.length; i += 2048) {
      const batch = uncached.slice(i, i + 2048);
      const embeddings = await this.callApi(batch);
      allEmbeddings.push(...embeddings);
    }

    // Merge cached + new results
    let uncachedIdx = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        const embedding = allEmbeddings[uncachedIdx++];
        results[i] = embedding;
        this.cache.set(texts[i], embedding);
      }
    }

    return results as Float32Array[];
  }

  private async callApi(texts: string[], attempt = 1): Promise<Float32Array[]> {
    const maxAttempts = 3;

    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          encoding_format: 'float',
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 429 && attempt < maxAttempts) {
          const wait = Math.pow(2, attempt) * 1000;
          await new Promise(r => setTimeout(r, wait));
          return this.callApi(texts, attempt + 1);
        }
        throw new Error(`Embeddings API ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Sort by index to maintain input order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (err: any) {
      if (attempt < maxAttempts && err.message?.includes('ECONNRESET')) {
        const wait = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, wait));
        return this.callApi(texts, attempt + 1);
      }
      throw err;
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an embedding provider from environment variables.
 * Returns null if no API key is available (signals LIKE fallback).
 */
export function createEmbeddingProvider(): EmbeddingProvider | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.BRAIN_EMBEDDING_MODEL || 'text-embedding-3-small';
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

  return new OpenAIEmbeddingProvider(apiKey, model, baseUrl);
}
