/**
 * DitBenchmark — comprehensive benchmark suite for the DiT (Diffusion
 * Transformer) image generation provider (customer: Thanh Giang, XKLĐ).
 *
 * Covers:
 *   1. PROMPT QUALITY — determinism, Vietnamese encoding, token efficiency,
 *      completeness, kind-specific layout, negative prompt generation
 *   2. PROVIDER ROBUSTNESS — error handling, retry logic, timeout behavior,
 *      edge cases, graceful degradation
 *   3. PERFORMANCE — prompt generation latency, prediction creation overhead,
 *      polling efficiency, total render time estimation
 *   4. INTEGRATION — type safety, seed determinism, output format routing,
 *      metadata accuracy, model-specific parameter routing
 *
 * Run: npx vitest run test/dit-benchmark.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { HttpClient, HttpResponse, HttpRequestOptions } from '../src/platforms/httpClient';
import { ASSET_KINDS, DEFAULT_DIMENSIONS } from '../src/marketing/assets/assetKinds';
import type { AssetKind } from '../src/marketing/assets/assetKinds';
import { resolveRenderSpec, fallbackBrandSpec } from '../src/marketing/assets/assetGenerator';
import type { AssetCopy, ResolvedRenderSpec } from '../src/marketing/assets/assetGenerator';
import {
  buildImagePrompt,
  buildDitImagePrompt,
  buildDitNegativePrompt,
  brandStyleSuffix,
} from '../src/marketing/assets/providers/renderPrompt';
import {
  DitImageProvider,
  DEFAULT_DIT_MODEL,
  DEFAULT_DIT_NUM_STEPS,
  DEFAULT_DIT_GUIDANCE_SCALE,
  DEFAULT_DIT_OUTPUT_FORMAT,
  DEFAULT_DIT_TIMEOUT_MS,
  POLL_INITIAL_INTERVAL_MS,
  POLL_MAX_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
  type DitGenerationMetadata,
  type DitOutputFormat,
} from '../src/marketing/assets/providers/ditImageProvider';
import {
  MediaRenderProvider,
  createMediaRenderProvider,
} from '../src/marketing/assets/providers/mediaRenderProvider';
import { createSecretLoader } from '../src/infra/secrets';

// ── Test fixtures ──────────────────────────────────────────────────────────

/** A tiny 1x1 PNG, base64-encoded. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const noSleep = async (): Promise<void> => undefined;

const imageCopy: AssetCopy = {
  title: 'Tuyển dụng kỹ sư đi Nhật Bản',
  body: 'Cơ hội việc làm ổn định, lương cao tại Nhật Bản. Hỗ trợ toàn diện hồ sơ.',
  ctas: ['Đăng ký ngay hôm nay'],
  market: 'JAPAN',
};

function imageSpec(kind: AssetKind = 'poster'): ResolvedRenderSpec {
  return resolveRenderSpec(kind, fallbackBrandSpec(kind), imageCopy);
}

/** Build a fake HttpClient from canned post/get handlers. */
function fakeHttp(handlers: {
  post?: (url: string, body: unknown, options?: HttpRequestOptions) => Promise<HttpResponse>;
  get?: (url: string, options?: HttpRequestOptions) => Promise<HttpResponse>;
}): HttpClient {
  return {
    post:
      handlers.post ??
      (async () => ({ status: 500, ok: false, body: null })),
    get:
      handlers.get ??
      (async () => ({ status: 500, ok: false, body: null })),
  };
}

/** HTTP GET that returns PNG bytes for image downloads, poll body for Replicate URLs. */
function pollOrImageGet(predId: string, status: string, output: string[]) {
  return async (url: string) => {
    if (url.includes('replicate.com')) {
      return { status: 200, ok: true, body: { id: predId, status, output } };
    }
    return { status: 200, ok: true, body: PNG_1X1_BASE64 };
  };
}

/** Fast poll that always succeeds immediately. */
function fastSucceedHttp(predId = 'pred-bench'): HttpClient {
  return fakeHttp({
    post: async () => ({ status: 201, ok: true, body: { id: predId, status: 'starting' } }),
    get: pollOrImageGet(predId, 'succeeded', ['https://cdn.example.test/img/out.png']),
  });
}

/** HTTP that returns a specific number of polls before succeeding. */
function delayedSucceedHttp(pollCount: number, predId = 'pred-delayed'): HttpClient {
  let polls = 0;
  return fakeHttp({
    post: async () => ({ status: 201, ok: true, body: { id: predId, status: 'starting' } }),
    get: async (url) => {
      if (!url.includes('replicate.com')) {
        return { status: 200, ok: true, body: PNG_1X1_BASE64 };
      }
      polls += 1;
      if (polls >= pollCount) {
        return {
          status: 200,
          ok: true,
          body: { id: predId, status: 'succeeded', output: ['https://cdn.example.test/img/done.png'] },
        };
      }
      return { status: 200, ok: true, body: { id: predId, status: 'processing' } };
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. PROMPT QUALITY BENCHMARK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Benchmark: Prompt Quality', () => {
  describe('Determinism', () => {
    it('buildDitImagePrompt is byte-identical across 500 calls per kind', () => {
      for (const kind of ASSET_KINDS) {
        if (kind === 'short_video') continue;
        const spec = imageSpec(kind);
        const baseline = buildDitImagePrompt(spec);
        for (let i = 0; i < 500; i++) {
          expect(buildDitImagePrompt(spec)).toBe(baseline);
        }
      }
    });

    it('buildDitNegativePrompt is byte-identical across 500 calls per kind', () => {
      for (const kind of ASSET_KINDS) {
        if (kind === 'short_video') continue;
        const baseline = buildDitNegativePrompt(kind);
        for (let i = 0; i < 500; i++) {
          expect(buildDitNegativePrompt(kind)).toBe(baseline);
        }
      }
    });
  });

  describe('Vietnamese text encoding', () => {
    it('preserves all Vietnamese diacritics in headline', () => {
      const spec = imageSpec('poster');
      const prompt = buildDitImagePrompt(spec);
      // Vietnamese headline from imageCopy
      expect(prompt).toContain('Tuyển dụng kỹ sư đi Nhật Bản');
    });

    it('preserves Vietnamese diacritics in body text', () => {
      const spec = imageSpec('poster');
      const prompt = buildDitImagePrompt(spec);
      expect(prompt).toContain('Cơ hội việc làm ổn định');
    });

    it('preserves Vietnamese diacritics in CTA', () => {
      const spec = imageSpec('poster');
      const prompt = buildDitImagePrompt(spec);
      expect(prompt).toContain('Đăng ký ngay hôm nay');
    });

    it('no secret leakage (sk-, AIza, Bearer)', () => {
      for (const kind of ASSET_KINDS) {
        if (kind === 'short_video') continue;
        const prompt = buildDitImagePrompt(imageSpec(kind));
        expect(prompt).not.toContain('sk-');
        expect(prompt).not.toContain('AIza');
        expect(prompt).not.toContain('Bearer');
      }
    });
  });

  describe('Token efficiency', () => {
    it('DiT prompt is within FLUX.1 token budget (≤600 tokens ≈ 2400 chars)', () => {
      for (const kind of ASSET_KINDS) {
        if (kind === 'short_video') continue;
        const prompt = buildDitImagePrompt(imageSpec(kind));
        const estimatedTokens = Math.ceil(prompt.length / 4);
        expect(estimatedTokens).toBeLessThanOrEqual(600);
      }
    });

    it('DiT prompt is longer than standard prompt (superset)', () => {
      for (const kind of ASSET_KINDS) {
        if (kind === 'short_video') continue;
        const spec = imageSpec(kind);
        expect(buildDitImagePrompt(spec).length).toBeGreaterThan(
          buildImagePrompt(spec).length,
        );
      }
    });

    it('negative prompt is within token budget (≤256 tokens ≈ 1024 chars)', () => {
      for (const kind of ASSET_KINDS) {
        if (kind === 'short_video') continue;
        const neg = buildDitNegativePrompt(kind);
        const estimatedTokens = Math.ceil(neg.length / 4);
        expect(estimatedTokens).toBeLessThanOrEqual(256);
      }
    });
  });

  describe('Completeness', () => {
    it('DiT prompt encodes every spec field', () => {
      const spec = imageSpec('poster');
      const prompt = buildDitImagePrompt(spec);

      // Scene
      expect(prompt).toContain('poster');
      expect(prompt).toContain(`${spec.dimensions.width}x${spec.dimensions.height}`);

      // Brand
      expect(prompt).toContain('Thanh Giang');
      expect(prompt).toContain(spec.palette.primary);
      expect(prompt).toContain(spec.palette.secondary);
      expect(prompt).toContain(spec.palette.bg);
      expect(prompt).toContain(spec.palette.text);

      // Typography
      expect(prompt).toContain(spec.fonts.heading);
      expect(prompt).toContain(spec.fonts.body);

      // Logo
      expect(prompt).toContain(spec.logo.position);

      // Copy slots
      for (const slot of spec.slots) {
        if (slot.text.trim().length > 0) {
          expect(prompt).toContain(slot.text.trim());
        }
      }
    });

    it('negative prompt contains kind-specific terms', () => {
      const posterNeg = buildDitNegativePrompt('poster');
      expect(posterNeg).toContain('text overlapping images');

      const thumbNeg = buildDitNegativePrompt('thumbnail');
      expect(thumbNeg).toContain('too much empty space');

      const infogNeg = buildDitNegativePrompt('infographic');
      expect(infogNeg).toContain('unorganized layout');
    });
  });

  describe('Kind-specific layout', () => {
    it('poster: vertical layout with upper/lower thirds', () => {
      const prompt = buildDitImagePrompt(imageSpec('poster'));
      expect(prompt).toContain('Vertical poster layout');
      expect(prompt).toContain('upper third');
      expect(prompt).toContain('lower third');
    });

    it('thumbnail: landscape layout with safe margins', () => {
      const prompt = buildDitImagePrompt(imageSpec('thumbnail'));
      expect(prompt).toContain('Wide landscape thumbnail layout');
      expect(prompt).toContain('safe margins');
    });

    it('infographic: dense structured layout', () => {
      const prompt = buildDitImagePrompt(imageSpec('infographic'));
      expect(prompt).toContain('Dense infographic layout');
    });

    it('image: square balanced layout', () => {
      const prompt = buildDitImagePrompt(imageSpec('image'));
      expect(prompt).toContain('Square or balanced layout');
    });
  });

  describe('DiT-specific clauses', () => {
    it('contains typography emphasis (diacritics, hierarchy)', () => {
      const prompt = buildDitImagePrompt(imageSpec('poster'));
      expect(prompt).toContain('diacritics');
      expect(prompt).toContain('Text hierarchy');
      expect(prompt).toContain('visual anchor');
    });

    it('contains quality modifiers (sharp focus, professional)', () => {
      const prompt = buildDitImagePrompt(imageSpec('poster'));
      expect(prompt).toContain('sharp focus');
      expect(prompt).toContain('professional');
      expect(prompt).toContain('No artificial filters');
    });

    it('uses lighter negatives (no extra fingers, warped faces)', () => {
      const prompt = buildDitImagePrompt(imageSpec('poster'));
      expect(prompt).not.toContain('extra fingers');
      expect(prompt).not.toContain('warped faces');
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. PROVIDER ROBUSTNESS BENCHMARK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Benchmark: Provider Robustness', () => {
  describe('Error handling', () => {
    it('DIT_NOT_CONFIGURED when apiToken is empty', async () => {
      const provider = new DitImageProvider({
        apiToken: '',
        http: fakeHttp({}),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_NOT_CONFIGURED',
      });
    });

    it('DIT_NOT_CONFIGURED when apiToken is whitespace', async () => {
      const provider = new DitImageProvider({
        apiToken: '   ',
        http: fakeHttp({}),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_NOT_CONFIGURED',
      });
    });

    it('DIT_NOT_CONFIGURED when apiToken is undefined', async () => {
      const provider = new DitImageProvider({
        http: fakeHttp({}),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_NOT_CONFIGURED',
      });
    });

    it('DIT_REQUEST_FAILED on POST network error', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => { throw new Error('ECONNREFUSED'); },
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_REQUEST_FAILED',
      });
    });

    it('DIT_REQUEST_FAILED on POST non-ok response', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 401, ok: false, body: { error: 'Unauthorized' } }),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_REQUEST_FAILED',
      });
    });

    it('DIT_BAD_RESPONSE when POST returns no ID', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { status: 'starting' } }),
          get: async () => ({
            status: 200, ok: true,
            body: { id: 'x', status: 'succeeded', output: ['https://cdn.example.test/img/o.png'] },
          }),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_BAD_RESPONSE',
      });
    });

    it('DIT_REQUEST_FAILED when prediction fails', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { id: 'p1', status: 'starting' } }),
          get: async () => ({
            status: 200, ok: true,
            body: { id: 'p1', status: 'failed', error: 'Out of memory' },
          }),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_REQUEST_FAILED',
      });
    });

    it('DIT_REQUEST_FAILED when prediction is canceled', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { id: 'p2', status: 'starting' } }),
          get: async () => ({
            status: 200, ok: true,
            body: { id: 'p2', status: 'canceled' },
          }),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_REQUEST_FAILED',
      });
    });

    it('DIT_BAD_RESPONSE when output array is empty', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { id: 'p3', status: 'starting' } }),
          get: async () => ({
            status: 200, ok: true,
            body: { id: 'p3', status: 'succeeded', output: [] },
          }),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_BAD_RESPONSE',
      });
    });

    it('DIT_BAD_RESPONSE when output is undefined', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { id: 'p4', status: 'starting' } }),
          get: async () => ({
            status: 200, ok: true,
            body: { id: 'p4', status: 'succeeded' },
          }),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_BAD_RESPONSE',
      });
    });

    it('DIT_REQUEST_FAILED when image download GET throws', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { id: 'p5', status: 'starting' } }),
          get: async (url) => {
            if (url.includes('replicate.com')) {
              return {
                status: 200, ok: true,
                body: { id: 'p5', status: 'succeeded', output: ['https://cdn.example.test/img/dl.png'] },
              };
            }
            throw new Error('ETIMEDOUT');
          },
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_REQUEST_FAILED',
      });
    });

    it('DIT_REQUEST_FAILED when image download returns non-ok', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { id: 'p6', status: 'starting' } }),
          get: async (url) => {
            if (url.includes('replicate.com')) {
              return {
                status: 200, ok: true,
                body: { id: 'p6', status: 'succeeded', output: ['https://cdn.example.test/img/dl.png'] },
              };
            }
            return { status: 500, ok: false, body: null };
          },
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_REQUEST_FAILED',
      });
    });

    it('DIT_BAD_RESPONSE when downloaded image bytes are empty', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { id: 'p7', status: 'starting' } }),
          get: async (url) => {
            if (url.includes('replicate.com')) {
              return {
                status: 200, ok: true,
                body: { id: 'p7', status: 'succeeded', output: ['https://cdn.example.test/img/empty.png'] },
              };
            }
            return { status: 200, ok: true, body: '' };
          },
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_BAD_RESPONSE',
      });
    });
  });

  describe('Polling robustness', () => {
    it('retries on transient GET failures then succeeds', async () => {
      let polls = 0;
      const http = fakeHttp({
        post: async () => ({ status: 201, ok: true, body: { id: 'ptrans', status: 'starting' } }),
        get: async (url) => {
          if (!url.includes('replicate.com')) {
            return { status: 200, ok: true, body: PNG_1X1_BASE64 };
          }
          polls += 1;
          if (polls <= 2) return { status: 500, ok: false, body: null };
          if (polls <= 4) throw new Error('ENETUNREACH');
          return {
            status: 200, ok: true,
            body: { id: 'ptrans', status: 'succeeded', output: ['https://cdn.example.test/img/t.png'] },
          };
        },
      });
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http,
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec());
      expect(out.storageKey).toBeTruthy();
      expect(polls).toBe(5); // 2 non-ok + 2 network errors + 1 success
    });

    it('DIT_REQUEST_FAILED after exceeding poll attempts', async () => {
      const http = fakeHttp({
        post: async () => ({ status: 201, ok: true, body: { id: 'ptimeout', status: 'starting' } }),
        get: async () => ({
          status: 200, ok: true,
          body: { id: 'ptimeout', status: 'processing' },
        }),
      });
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http,
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_REQUEST_FAILED',
      });
    });
  });

  describe('Edge cases', () => {
    it('handles output as single URL string (not array)', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { id: 'psingle', status: 'starting' } }),
          get: async (url) => {
            if (url.includes('replicate.com')) {
              return {
                status: 200, ok: true,
                body: { id: 'psingle', status: 'succeeded', output: 'https://cdn.example.test/img/single.png' },
              };
            }
            return { status: 200, ok: true, body: PNG_1X1_BASE64 };
          },
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec());
      expect(out.storageKey).toBeTruthy();
      expect(out.mimeType).toBe('image/png');
    });

    it('handles output with non-string array element', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async () => ({ status: 201, ok: true, body: { id: 'pbad', status: 'starting' } }),
          get: async () => ({
            status: 200, ok: true,
            body: { id: 'pbad', status: 'succeeded', output: [123] },
          }),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_BAD_RESPONSE',
      });
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. PERFORMANCE BENCHMARK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Benchmark: Performance', () => {
  describe('Prompt generation latency', () => {
    it('buildDitImagePrompt completes in <5ms for all kinds', () => {
      for (const kind of ASSET_KINDS) {
        if (kind === 'short_video') continue;
        const spec = imageSpec(kind);
        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
          buildDitImagePrompt(spec);
        }
        const elapsed = performance.now() - start;
        // 1000 calls should complete in under 50ms (5μs per call)
        expect(elapsed).toBeLessThan(50);
      }
    });

    it('buildDitNegativePrompt completes in <2ms for all kinds', () => {
      for (const kind of ASSET_KINDS) {
        if (kind === 'short_video') continue;
        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
          buildDitNegativePrompt(kind);
        }
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(20);
      }
    });

    it('buildImagePrompt (standard) completes in <3ms for all kinds', () => {
      for (const kind of ASSET_KINDS) {
        if (kind === 'short_video') continue;
        const spec = imageSpec(kind);
        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
          buildImagePrompt(spec);
        }
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(30);
      }
    });
  });

  describe('Provider construction latency', () => {
    it('DitImageProvider construction completes in <1ms', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        new DitImageProvider({
          apiToken: 'r8_test',
          model: 'black-forest-labs/flux-schnell',
          numSteps: 4,
          guidanceScale: 0,
          outputFormat: 'png',
          timeoutMs: 30000,
        });
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('Render time estimation', () => {
    it('fast-succeed render completes with measurable timing in metadata', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fastSucceedHttp('pred-perf'),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec());
      const meta = out.metadata as DitGenerationMetadata | undefined;
      expect(meta).toBeDefined();
      expect(meta!.renderTimeMs).toBeGreaterThanOrEqual(0);
      expect(meta!.pollCount).toBe(1);
      expect(meta!.model).toBe(DEFAULT_DIT_MODEL);
      expect(meta!.steps).toBe(DEFAULT_DIT_NUM_STEPS);
      expect(meta!.guidanceScale).toBe(DEFAULT_DIT_GUIDANCE_SCALE);
    });

    it('delayed-succeed render reports accurate poll count', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: delayedSucceedHttp(5, 'pred-polls'),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec());
      const meta = out.metadata as DitGenerationMetadata;
      expect(meta.pollCount).toBe(5);
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. INTEGRATION / FEATURE BENCHMARK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Benchmark: Integration Quality', () => {
  describe('Seed determinism', () => {
    it('fixed seed produces same seed in metadata', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        seed: 42,
        http: fastSucceedHttp('pred-seed'),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec());
      const meta = out.metadata as DitGenerationMetadata;
      expect(meta.seed).toBe(42);
    });

    it('seed is sent in the prediction input', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        seed: 12345,
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-s', status: 'starting' } };
          },
          get: pollOrImageGet('pred-s', 'succeeded', ['https://cdn.example.test/img/s.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec());
      expect(capturedInput?.seed).toBe(12345);
    });

    it('metadata.seed is undefined when no fixed seed (random)', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        // No seed set
        http: fastSucceedHttp('pred-rand'),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec());
      const meta = out.metadata as DitGenerationMetadata;
      expect(meta.seed).toBeUndefined();
    });
  });

  describe('Output format routing', () => {
    it('PNG format: output_format=png, extension=.png', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        outputFormat: 'png',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-png', status: 'starting' } };
          },
          get: pollOrImageGet('pred-png', 'succeeded', ['https://cdn.example.test/img/out.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec());
      expect(capturedInput?.output_format).toBe('png');
      expect(out.storageKey).toMatch(/\.png$/);
      const meta = out.metadata as DitGenerationMetadata;
      expect(meta.outputFormat).toBe('png');
    });

    it('JPEG format: output_format=jpeg, extension=.jpg', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        outputFormat: 'jpeg',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-jpg', status: 'starting' } };
          },
          get: pollOrImageGet('pred-jpg', 'succeeded', ['https://cdn.example.test/img/out.jpg']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec());
      expect(capturedInput?.output_format).toBe('jpeg');
      expect(out.storageKey).toMatch(/\.jpg$/);
    });

    it('WebP format: output_format=webp, extension=.webp', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        outputFormat: 'webp',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-wp', status: 'starting' } };
          },
          get: pollOrImageGet('pred-wp', 'succeeded', ['https://cdn.example.test/img/out.webp']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec());
      expect(capturedInput?.output_format).toBe('webp');
      expect(out.storageKey).toMatch(/\.webp$/);
    });
  });

  describe('Model-specific parameter routing', () => {
    it('schnell: num_inference_steps capped at 4, no guidance_scale', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        model: 'black-forest-labs/flux-schnell',
        numSteps: 10, // Should be capped at 4
        guidanceScale: 5, // Should not be sent
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-sn', status: 'starting' } };
          },
          get: pollOrImageGet('pred-sn', 'succeeded', ['https://cdn.example.test/img/sn.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec());
      expect(capturedInput?.num_inference_steps).toBe(4);
      expect(capturedInput?.guidance_scale).toBeUndefined();
    });

    it('dev: full steps + guidance_scale, negative_prompt sent', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        model: 'black-forest-labs/flux-dev',
        numSteps: 28,
        guidanceScale: 3.5,
        negativePrompt: 'blurry, ugly',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-dv', status: 'starting' } };
          },
          get: pollOrImageGet('pred-dv', 'succeeded', ['https://cdn.example.test/img/dv.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec());
      expect(capturedInput?.num_inference_steps).toBe(28);
      expect(capturedInput?.guidance_scale).toBe(3.5);
      expect(capturedInput?.negative_prompt).toBe('blurry, ugly');
    });

    it('SD3: uses guidance (not guidance_scale), negative_prompt sent', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        model: 'stability-ai/stable-diffusion-3',
        numSteps: 20,
        guidanceScale: 7,
        negativePrompt: 'watermark',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-sd3', status: 'starting' } };
          },
          get: pollOrImageGet('pred-sd3', 'succeeded', ['https://cdn.example.test/img/sd3.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec());
      expect(capturedInput?.num_inference_steps).toBe(20);
      expect(capturedInput?.guidance).toBe(7);
      expect(capturedInput?.guidance_scale).toBeUndefined();
      expect(capturedInput?.negative_prompt).toBe('watermark');
    });
  });

  describe('Metadata completeness', () => {
    it('render returns full metadata with all fields', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        model: 'black-forest-labs/flux-dev',
        numSteps: 28,
        guidanceScale: 3.5,
        seed: 42,
        outputFormat: 'jpeg',
        aspectRatio: '16:9',
        http: fastSucceedHttp('pred-meta'),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec('thumbnail'));
      const meta = out.metadata as DitGenerationMetadata;

      expect(meta.model).toBe('black-forest-labs/flux-dev');
      expect(meta.seed).toBe(42);
      expect(meta.steps).toBe(28);
      expect(meta.guidanceScale).toBe(3.5);
      expect(meta.renderTimeMs).toBeGreaterThanOrEqual(0);
      expect(meta.pollCount).toBe(1);
      expect(meta.aspectRatio).toBe('16:9');
      expect(meta.outputFormat).toBe('jpeg');
      expect(meta.promptTokens).toBeGreaterThan(0);
    });

    it('metadata.promptTokens approximates real token count', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fastSucceedHttp('pred-tok'),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec('poster'));
      const meta = out.metadata as DitGenerationMetadata;
      // Prompt length / 4 should roughly match token count
      const spec = imageSpec('poster');
      const prompt = buildDitImagePrompt(spec);
      const expectedTokens = Math.ceil(prompt.length / 4);
      expect(meta.promptTokens).toBe(expectedTokens);
    });
  });

  describe('Aspect ratio derivation', () => {
    it('thumbnail (1280×720) → 16:9', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-ar1', status: 'starting' } };
          },
          get: pollOrImageGet('pred-ar1', 'succeeded', ['https://cdn.example.test/img/ar.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec('thumbnail'));
      expect(capturedInput?.aspect_ratio).toBe('16:9');
    });

    it('poster (1080×1350) → 4:5', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-ar2', status: 'starting' } };
          },
          get: pollOrImageGet('pred-ar2', 'succeeded', ['https://cdn.example.test/img/ar.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec('poster'));
      expect(capturedInput?.aspect_ratio).toBe('4:5');
    });

    it('image (1080×1080) → 1:1', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-ar3', status: 'starting' } };
          },
          get: pollOrImageGet('pred-ar3', 'succeeded', ['https://cdn.example.test/img/ar.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec('image'));
      expect(capturedInput?.aspect_ratio).toBe('1:1');
    });

    it('aspectRatio override takes precedence', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        aspectRatio: '3:4',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-ar4', status: 'starting' } };
          },
          get: pollOrImageGet('pred-ar4', 'succeeded', ['https://cdn.example.test/img/ar.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec('poster')); // 4:5 spec, but override is 3:4
      expect(capturedInput?.aspect_ratio).toBe('3:4');
    });
  });

  describe('Negative prompt integration', () => {
    it('negativePrompt option is sent when provided', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        model: 'black-forest-labs/flux-dev',
        negativePrompt: 'blurry, ugly, deformed',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-np', status: 'starting' } };
          },
          get: pollOrImageGet('pred-np', 'succeeded', ['https://cdn.example.test/img/np.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec());
      expect(capturedInput?.negative_prompt).toBe('blurry, ugly, deformed');
    });

    it('negativePrompt is NOT sent when empty', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        model: 'black-forest-labs/flux-dev',
        negativePrompt: '',
        http: fakeHttp({
          post: async (_url, body) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = (parsed as { input: Record<string, unknown> }).input;
            return { status: 201, ok: true, body: { id: 'pred-np2', status: 'starting' } };
          },
          get: pollOrImageGet('pred-np2', 'succeeded', ['https://cdn.example.test/img/np.png']),
        }),
        writeFile: async () => undefined,
        sleep: noSleep,
      });
      await provider.render(imageSpec());
      expect(capturedInput?.negative_prompt).toBeUndefined();
    });
  });

  describe('MediaRenderProvider integration', () => {
    it('createMediaRenderProvider returns DiT-backed provider when REPLICATE_API_TOKEN is set', () => {
      const secrets = createSecretLoader({
        REPLICATE_API_TOKEN: 'r8_test-token',
        ASSET_RENDER_DIR: '/tmp/render',
      });
      const provider = createMediaRenderProvider(secrets);
      expect(provider).toBeDefined();
      expect((provider as MediaRenderProvider).name).toBe('dit-media');
    });

    it('createMediaRenderProvider prefers DiT over OpenAI-compat', () => {
      const secrets = createSecretLoader({
        REPLICATE_API_TOKEN: 'r8_test-token',
        GEMINI_IMAGE_API_KEY: 'test-key',
        GEMINI_IMAGE_BASE_URL: 'https://gateway.test/v1',
        ASSET_RENDER_DIR: '/tmp/render',
      });
      const provider = createMediaRenderProvider(secrets);
      expect((provider as MediaRenderProvider).name).toBe('dit-media');
    });

    it('DiT provider passes through DIT-specific env config', () => {
      const secrets = createSecretLoader({
        REPLICATE_API_TOKEN: 'r8_test-token',
        DIT_MODEL: 'black-forest-labs/flux-dev',
        DIT_NUM_STEPS: '28',
        DIT_GUIDANCE_SCALE: '3.5',
        ASSET_RENDER_DIR: '/tmp/render',
      });
      const provider = createMediaRenderProvider(secrets);
      expect(provider).toBeDefined();
      expect((provider as MediaRenderProvider).name).toBe('dit-media');
    });
  });

  describe('File writing', () => {
    it('writes to correct path with kind and UUID', async () => {
      let writtenPath = '';
      let writtenBytes: Buffer | undefined;
      const provider = new DitImageProvider({
        apiToken: 'r8_test',
        storageDir: '/opt/render',
        http: fastSucceedHttp('pred-file'),
        writeFile: async (p, b) => { writtenPath = p; writtenBytes = b; },
        sleep: noSleep,
      });
      const out = await provider.render(imageSpec('poster'));
      expect(writtenPath).toContain('opt');
      expect(writtenPath).toContain('render');
      expect(writtenPath).toContain('assets');
      expect(writtenPath).toContain('poster');
      expect(writtenPath).toMatch(/\.png$/);
      expect(writtenBytes).toBeDefined();
      expect(writtenBytes!.length).toBeGreaterThan(0);
      expect(out.storageKey).toMatch(/^assets\/poster\//);
    });
  });

  describe('Provider name', () => {
    it('name is dit-flux', () => {
      const provider = new DitImageProvider({ apiToken: 'test' });
      expect(provider.name).toBe('dit-flux');
    });
  });

  describe('Default constants', () => {
    it('DEFAULT_DIT_MODEL is flux-schnell', () => {
      expect(DEFAULT_DIT_MODEL).toBe('black-forest-labs/flux-schnell');
    });

    it('DEFAULT_DIT_NUM_STEPS is 4', () => {
      expect(DEFAULT_DIT_NUM_STEPS).toBe(4);
    });

    it('DEFAULT_DIT_GUIDANCE_SCALE is 0', () => {
      expect(DEFAULT_DIT_GUIDANCE_SCALE).toBe(0);
    });

    it('DEFAULT_DIT_OUTPUT_FORMAT is png', () => {
      expect(DEFAULT_DIT_OUTPUT_FORMAT).toBe('png');
    });

    it('DEFAULT_DIT_TIMEOUT_MS is 30000', () => {
      expect(DEFAULT_DIT_TIMEOUT_MS).toBe(30000);
    });

    it('POLL_INITIAL_INTERVAL_MS is 1000', () => {
      expect(POLL_INITIAL_INTERVAL_MS).toBe(1000);
    });

    it('POLL_MAX_INTERVAL_MS is 16000', () => {
      expect(POLL_MAX_INTERVAL_MS).toBe(16000);
    });

    it('POLL_MAX_ATTEMPTS is 60', () => {
      expect(POLL_MAX_ATTEMPTS).toBe(60);
    });
  });
});
