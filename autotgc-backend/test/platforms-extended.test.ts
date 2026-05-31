import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { AdapterRegistry } from '../src/platforms/registry';
import { UnsupportedOperationError } from '../src/platforms/adapter';
import type { PlatformId } from '../src/platforms/adapter';
import type {
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
} from '../src/platforms/httpClient';
import type { PlatformTokenProvider } from '../src/platforms/tokenProvider';
import { YouTubeAdapter } from '../src/platforms/youtubeAdapter';
import { ZaloAdapter } from '../src/platforms/zaloAdapter';

/**
 * Fake HttpClient: returns a canned ok response body for every call, recording
 * the last request so assertions can inspect the shape the adapter sent.
 */
interface RecordedCall {
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  options?: HttpRequestOptions;
}

function fakeHttp(body: unknown, ok = true, status = 200): HttpClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const response: HttpResponse = { status, ok, body };
  return {
    calls,
    async post(url, reqBody, options) {
      calls.push({ method: 'POST', url, body: reqBody, options });
      return response;
    },
    async get(url, options) {
      calls.push({ method: 'GET', url, options });
      return response;
    },
  };
}

/** Fake token provider with a configurable per-platform value. */
function fakeTokens(value: string | undefined): PlatformTokenProvider {
  return { getTokenValue: (_platform: PlatformId) => value };
}

const PUBLISH_REQ = {
  draftId: 'd1',
  title: 'Hello',
  body: 'World',
  ctas: ['Subscribe now'],
  idempotencyKey: 'k1',
} as const;

describe('extended platform adapters (YouTube, Zalo OA)', () => {
  describe('YouTubeAdapter', () => {
    it('publish maps returned id -> externalId and youtu.be url', async () => {
      const http = fakeHttp({ id: 'vid123' });
      const adapter = new YouTubeAdapter({ tokens: fakeTokens('valid-oauth-token'), httpClient: http });

      const result = await adapter.publish({ ...PUBLISH_REQ });

      expect(result.externalId).toBe('vid123');
      expect(result.url).toContain('vid123');
      expect(result.url).toBe('https://youtu.be/vid123');
      // Hit the videos.insert metadata endpoint shape with a bearer token.
      expect(http.calls[0].method).toBe('POST');
      expect(http.calls[0].url).toContain('/videos?part=snippet,status');
      expect(http.calls[0].options?.headers?.authorization).toBe('Bearer valid-oauth-token');
    });

    it('collectAnalytics maps statistics -> metrics; missing fields are null (not 0)', async () => {
      // Only viewCount present; likeCount/commentCount absent.
      const http = fakeHttp({ items: [{ statistics: { viewCount: '42' } }] });
      const adapter = new YouTubeAdapter({ tokens: fakeTokens('valid-oauth-token'), httpClient: http });

      const result = await adapter.collectAnalytics({ externalPostId: 'vid123' });

      expect(result.metrics.views).toBe(42);
      expect(result.metrics.likes).toBeNull();
      expect(result.metrics.comments).toBeNull();
      // Explicitly NOT coerced to 0.
      expect(result.metrics.likes).not.toBe(0);
    });

    // Property: any non-negative statistics map round-trips to numbers, and any
    // omitted statistic is null (never 0).
    it('Property: present stats -> numbers, absent stats -> null', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            viewCount: fc.option(fc.nat(), { nil: undefined }),
            likeCount: fc.option(fc.nat(), { nil: undefined }),
            commentCount: fc.option(fc.nat(), { nil: undefined }),
          }),
          async (stats) => {
            const statistics: Record<string, number> = {};
            if (stats.viewCount !== undefined) statistics.viewCount = stats.viewCount;
            if (stats.likeCount !== undefined) statistics.likeCount = stats.likeCount;
            if (stats.commentCount !== undefined) statistics.commentCount = stats.commentCount;

            const http = fakeHttp({ items: [{ statistics }] });
            const adapter = new YouTubeAdapter({
              tokens: fakeTokens('valid-oauth-token'),
              httpClient: http,
            });
            const { metrics } = await adapter.collectAnalytics({ externalPostId: 'v' });

            expect(metrics.views).toBe(stats.viewCount === undefined ? null : stats.viewCount);
            expect(metrics.likes).toBe(stats.likeCount === undefined ? null : stats.likeCount);
            expect(metrics.comments).toBe(
              stats.commentCount === undefined ? null : stats.commentCount,
            );
          },
        ),
        { numRuns: 200 },
      );
    });

    it('publish throws when token is missing (502 not configured)', async () => {
      const http = fakeHttp({ id: 'vid123' });
      const adapter = new YouTubeAdapter({ tokens: fakeTokens(undefined), httpClient: http });

      let thrown: unknown;
      try {
        await adapter.publish({ ...PUBLISH_REQ });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { status?: number }).status).toBe(502);
      // No HTTP call should have been attempted.
      expect(http.calls.length).toBe(0);
    });
  });

  describe('ZaloAdapter', () => {
    it('publish maps returned id -> externalId', async () => {
      const http = fakeHttp({ data: { id: 'art-789', url: 'https://zalo.me/art-789' } });
      const adapter = new ZaloAdapter({ tokens: fakeTokens('valid-oa-token'), httpClient: http });

      const result = await adapter.publish({ ...PUBLISH_REQ });

      expect(result.externalId).toBe('art-789');
      expect(result.url).toBe('https://zalo.me/art-789');
      expect(http.calls[0].method).toBe('POST');
      expect(http.calls[0].url).toContain('/article/create');
      // Zalo OA convention: access_token header (not a bearer authorization).
      expect(http.calls[0].options?.headers?.access_token).toBe('valid-oa-token');
    });

    it('collectAnalytics rejects with UnsupportedOperationError (status 400)', async () => {
      const http = fakeHttp({});
      const adapter = new ZaloAdapter({ tokens: fakeTokens('valid-oa-token'), httpClient: http });

      let thrown: unknown;
      try {
        await adapter.collectAnalytics({ externalPostId: 'art-789' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(UnsupportedOperationError);
      expect((thrown as UnsupportedOperationError).status).toBe(400);
    });

    it('publish throws when token is missing (502 not configured)', async () => {
      const http = fakeHttp({ data: { id: 'art-789' } });
      const adapter = new ZaloAdapter({ tokens: fakeTokens(undefined), httpClient: http });

      let thrown: unknown;
      try {
        await adapter.publish({ ...PUBLISH_REQ });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { status?: number }).status).toBe(502);
      expect(http.calls.length).toBe(0);
    });
  });

  describe('registry routing for extended adapters', () => {
    it('registers youtube + zalo; both resolve with correct capabilities', () => {
      const registry = new AdapterRegistry();
      const youtube = new YouTubeAdapter({ tokens: fakeTokens('t'), httpClient: fakeHttp({}) });
      const zalo = new ZaloAdapter({ tokens: fakeTokens('t'), httpClient: fakeHttp({}) });

      registry.register(youtube);
      registry.register(zalo);

      expect(registry.get('youtube').platform).toBe('youtube');
      expect(registry.get('zalo').platform).toBe('zalo');

      // YouTube supports both publish and analytics.
      expect(registry.get('youtube').supports('publish')).toBe(true);
      expect(registry.get('youtube').supports('analytics')).toBe(true);

      // Zalo supports publish but NOT analytics.
      expect(registry.get('zalo').supports('publish')).toBe(true);
      expect(registry.get('zalo').supports('analytics')).toBe(false);

      expect(new Set(registry.list())).toEqual(new Set<PlatformId>(['youtube', 'zalo']));
    });
  });
});
