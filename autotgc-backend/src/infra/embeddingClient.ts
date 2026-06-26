/**
 * Embedder — AI-OPTIONAL text-embedding seam for semantic retrieval.
 *
 * Mirrors the AI-OPTIONAL discipline of the rest of the system: an embedding is
 * a NICE-TO-HAVE that improves grounding retrieval, never a hard dependency.
 * Therefore `embed` returns `number[] | undefined` and NEVER throws — when the
 * provider is unconfigured, errors, times out, or returns a malformed body, the
 * caller transparently falls back to deterministic keyword ranking.
 *
 * Transport is the same OpenAI-COMPATIBLE gateway used for chat
 * (`POST {baseUrl}/embeddings`, body `{ model, input }`, response
 * `{ data: [{ embedding: number[] }] }`). The API key is passed via the Bearer
 * header and is NEVER logged. HTTP is injected for testing.
 */
import { createFetchHttpClient } from '../platforms/httpClient';
import type { HttpClient } from '../platforms/httpClient';
import type { AiTextConfig } from './aiTextConfig';
import { isRecord, readPath } from '../platforms/narrow';
import { normalizeEmbedding } from './semanticRanking';

/** The minimal seam consumers depend on. */
export interface Embedder {
  /**
   * Compute the embedding vector for `text`. Resolves to `undefined` (never
   * throws) when embeddings are unavailable for ANY reason, so callers degrade
   * to keyword retrieval.
   */
  embed(text: string): Promise<number[] | undefined>;
}

/**
 * Extract the first embedding vector from an OpenAI-compatible embeddings
 * response body. Pure & exported for property testing. Tolerant by design:
 * returns `undefined` for any shape that is not `data[0].embedding` of finite
 * numbers.
 */
export function extractEmbedding(body: unknown): number[] | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  const embedding = readPath(first, 'embedding');
  return normalizeEmbedding(embedding);
}

export class AiEmbeddingClient implements Embedder {
  private readonly http: HttpClient;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    httpClient?: HttpClient,
  ) {
    this.http = httpClient ?? createFetchHttpClient(undefined, this.timeoutMs);
  }

  async embed(text: string): Promise<number[] | undefined> {
    const input = text.trim();
    if (
      input.length === 0 ||
      !this.apiKey ||
      this.apiKey.trim().length === 0 ||
      this.baseUrl.trim().length === 0 ||
      this.model.trim().length === 0
    ) {
      return undefined;
    }

    try {
      const res = await this.http.post(
        `${this.baseUrl}/embeddings`,
        { model: this.model, input },
        { headers: { authorization: `Bearer ${this.apiKey}` }, timeoutMs: this.timeoutMs },
      );
      if (!res.ok) return undefined;
      return extractEmbedding(res.body);
    } catch {
      // Network/timeout/parse failure → AI-OPTIONAL: degrade to keyword ranking.
      return undefined;
    }
  }
}

/**
 * Build an `AiEmbeddingClient` from the shared AI text config + the embedding
 * model env (`GEMINI_EMBEDDING_MODEL`), reusing the gateway base URL and API
 * key. Returns `undefined` when EITHER the key or the embedding model is absent,
 * so semantic retrieval stays opt-in and the system runs keyword-only by default.
 */
export function buildEmbedderFromConfig(
  apiKey: string | undefined,
  embeddingModel: string | undefined,
  config: AiTextConfig,
): Embedder | undefined {
  if (!apiKey || apiKey.trim().length === 0) return undefined;
  if (!embeddingModel || embeddingModel.trim().length === 0) return undefined;
  return new AiEmbeddingClient(apiKey, config.baseUrl, embeddingModel, config.timeout);
}
