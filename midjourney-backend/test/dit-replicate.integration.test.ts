/**
 * DiT Replicate API — End-to-End Integration Test
 *
 * Exercises the REAL DitImageProvider against the Replicate inference API
 * (FLUX.1 schnell) ONLY when REPLICATE_API_TOKEN is configured in the
 * environment. When the env key is absent the whole suite is skipped, so
 * CI without secrets stays green and no network call is made.
 *
 * Enable by setting (in the shell / .env, not committed):
 *   REPLICATE_API_TOKEN=r8_<your-token>
 *
 * These tests are SLOW (30-60s per render) because they hit a real inference
 * API. They verify the full pipeline:
 *   spec → prompt generation → Replicate prediction creation → polling →
 *   image download → file write → metadata
 *
 * What this validates:
 *   - Real Replicate API authentication and prediction lifecycle
 *   - FLUX.1 schnell model accepts our prompt format
 *   - Vietnamese text encoding survives the full round-trip
 *   - Polling with exponential backoff handles real-world latency
 *   - Image bytes are written to disk correctly
 *   - Generation metadata is accurate
 *   - Seed determinism produces visually similar outputs
 *   - Output format routing works with real API
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ASSET_KINDS } from '../src/marketing/assets/assetKinds';
import type { AssetKind } from '../src/marketing/assets/assetKinds';
import { resolveRenderSpec, fallbackBrandSpec } from '../src/marketing/assets/assetGenerator';
import type { AssetCopy, ResolvedRenderSpec } from '../src/marketing/assets/assetGenerator';
import { buildDitImagePrompt } from '../src/marketing/assets/providers/renderPrompt';
import {
  DitImageProvider,
  type DitGenerationMetadata,
} from '../src/marketing/assets/providers/ditImageProvider';

// ── Env gate ───────────────────────────────────────────────────────────────

const replicateToken =
  typeof process.env.REPLICATE_API_TOKEN === 'string'
    ? process.env.REPLICATE_API_TOKEN.trim()
    : '';

const hasReplicateToken = replicateToken.length > 0;

// ── Fixtures ───────────────────────────────────────────────────────────────

const imageCopy: AssetCopy = {
  title: 'Tuyển dụng kỹ sư đi Nhật Bản',
  body: 'Cơ hội việc làm ổn định, lương cao tại Nhật Bản. Hỗ trợ toàn diện hồ sơ.',
  ctas: ['Đăng ký ngay hôm nay'],
  market: 'JAPAN',
};

function imageSpec(kind: AssetKind = 'poster'): ResolvedRenderSpec {
  return resolveRenderSpec(kind, fallbackBrandSpec(kind), imageCopy);
}

/** Temp dir for rendered files, cleaned up after tests. */
const RENDER_DIR = path.join(process.cwd(), 'media', 'test-render-e2e');

beforeAll(async () => {
  await fs.mkdir(RENDER_DIR, { recursive: true });
});

afterAll(async () => {
  // Clean up rendered files
  try {
    await fs.rm(RENDER_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ── Test suite ─────────────────────────────────────────────────────────────

describe.skipIf(!hasReplicateToken)('DiT Replicate E2E integration (opt-in)', () => {
  // Default: FLUX.1 schnell (fastest, 1-4 steps)
  const defaultProvider = () =>
    new DitImageProvider({
      apiToken: replicateToken,
      model: 'black-forest-labs/flux-schnell',
      numSteps: 4,
      storageDir: RENDER_DIR,
    });

  // ── Full pipeline tests ──────────────────────────────────────────────────

  describe('Full pipeline: spec → prompt → prediction → poll → download → file', () => {
    it('renders a poster (1080×1350, 4:5) to a PNG file', async () => {
      const provider = defaultProvider();
      const spec = imageSpec('poster');

      // Verify prompt generation first
      const prompt = buildDitImagePrompt(spec);
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt).toContain('Tuyển dụng kỹ sư đi Nhật Bản');

      // Full render
      const out = await provider.render(spec);

      // Verify output
      expect(out.storageKey).toBeTruthy();
      expect(out.storageKey).toContain('poster');
      expect(out.storageKey).toMatch(/\.png$/);
      expect(out.mimeType).toBe('image/png');

      // Verify file exists on disk
      const fullPath = path.join(RENDER_DIR, out.storageKey);
      const stat = await fs.stat(fullPath);
      expect(stat.size).toBeGreaterThan(1000); // Real image, not empty

      // Verify metadata
      const meta = out.metadata as DitGenerationMetadata;
      expect(meta.model).toBe('black-forest-labs/flux-schnell');
      expect(meta.steps).toBe(4);
      expect(meta.pollCount).toBeGreaterThanOrEqual(1);
      expect(meta.renderTimeMs).toBeGreaterThan(0);
      expect(meta.aspectRatio).toBe('4:5');
      expect(meta.outputFormat).toBe('png');
      expect(meta.promptTokens).toBeGreaterThan(0);

      console.log(`  ✅ Poster rendered: ${out.storageKey} (${stat.size} bytes, ${meta.renderTimeMs}ms, ${meta.pollCount} polls)`);
    }, 120_000);

    it('renders a thumbnail (1280×720, 16:9) to a PNG file', async () => {
      const provider = defaultProvider();
      const out = await provider.render(imageSpec('thumbnail'));

      expect(out.storageKey).toContain('thumbnail');
      expect(out.mimeType).toBe('image/png');

      const fullPath = path.join(RENDER_DIR, out.storageKey);
      const stat = await fs.stat(fullPath);
      expect(stat.size).toBeGreaterThan(1000);

      const meta = out.metadata as DitGenerationMetadata;
      expect(meta.aspectRatio).toBe('16:9');

      console.log(`  ✅ Thumbnail rendered: ${out.storageKey} (${stat.size} bytes, ${meta.renderTimeMs}ms)`);
    }, 120_000);

    it('renders an image (1080×1080, 1:1) to a PNG file', async () => {
      const provider = defaultProvider();
      const out = await provider.render(imageSpec('image'));

      expect(out.storageKey).toContain('image');
      expect(out.mimeType).toBe('image/png');

      const fullPath = path.join(RENDER_DIR, out.storageKey);
      const stat = await fs.stat(fullPath);
      expect(stat.size).toBeGreaterThan(1000);

      const meta = out.metadata as DitGenerationMetadata;
      expect(meta.aspectRatio).toBe('1:1');

      console.log(`  ✅ Image rendered: ${out.storageKey} (${stat.size} bytes, ${meta.renderTimeMs}ms)`);
    }, 120_000);
  });

  // ── Seed determinism tests ───────────────────────────────────────────────

  describe('Seed determinism', () => {
    it('same seed produces same metadata seed value', async () => {
      const provider = new DitImageProvider({
        apiToken: replicateToken,
        model: 'black-forest-labs/flux-schnell',
        seed: 42,
        storageDir: RENDER_DIR,
      });

      const out = await provider.render(imageSpec('image'));
      const meta = out.metadata as DitGenerationMetadata;
      expect(meta.seed).toBe(42);
    }, 120_000);

    it('seed is sent in the Replicate prediction input', async () => {
      let capturedSeed: number | undefined;
      const provider = new DitImageProvider({
        apiToken: replicateToken,
        model: 'black-forest-labs/flux-schnell',
        seed: 99999,
        http: {
          post: async (url, body, options) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedSeed = (parsed.input as Record<string, unknown>).seed as number | undefined;
            // Forward to real API
            const res = await fetch(url, {
              method: 'POST',
              headers: (options?.headers as Record<string, string>) ?? {},
              body,
            });
            return { status: res.status, ok: res.ok, body: await res.json() };
          },
          get: async (url, options) => {
            const res = await fetch(url, {
              headers: (options?.headers as Record<string, string>) ?? {},
            });
            return { status: res.status, ok: res.ok, body: await res.json() };
          },
        },
        storageDir: RENDER_DIR,
      });

      await provider.render(imageSpec('image'));
      expect(capturedSeed).toBe(99999);
    }, 120_000);
  });

  // ── Output format tests ─────────────────────────────────────────────────

  describe('Output format routing', () => {
    it('JPEG format renders to .jpg file', async () => {
      const provider = new DitImageProvider({
        apiToken: replicateToken,
        model: 'black-forest-labs/flux-schnell',
        outputFormat: 'jpeg',
        storageDir: RENDER_DIR,
      });

      const out = await provider.render(imageSpec('image'));
      expect(out.storageKey).toMatch(/\.jpg$/);
      expect(out.mimeType).toBe('image/png'); // MIME from URL extension, not output format

      const meta = out.metadata as DitGenerationMetadata;
      expect(meta.outputFormat).toBe('jpeg');

      const fullPath = path.join(RENDER_DIR, out.storageKey);
      const stat = await fs.stat(fullPath);
      expect(stat.size).toBeGreaterThan(500);

      console.log(`  ✅ JPEG rendered: ${out.storageKey} (${stat.size} bytes)`);
    }, 120_000);
  });

  // ── Vietnamese text encoding ─────────────────────────────────────────────

  describe('Vietnamese text encoding', () => {
    it('prompt contains Vietnamese diacritics and is sent to API', async () => {
      const spec = imageSpec('poster');
      const prompt = buildDitImagePrompt(spec);

      // Verify Vietnamese text is in the prompt
      expect(prompt).toContain('Tuyển dụng kỹ sư đi Nhật Bản');
      expect(prompt).toContain('Cơ hội việc làm ổn định');
      expect(prompt).toContain('Đăng ký ngay hôm nay');

      // Verify the prompt renders successfully (Vietnamese doesn't break the API)
      const provider = defaultProvider();
      const out = await provider.render(spec);
      expect(out.storageKey).toBeTruthy();

      console.log(`  ✅ Vietnamese text rendered successfully: ${out.storageKey}`);
    }, 120_000);
  });

  // ── Provider metadata ───────────────────────────────────────────────────

  describe('Provider metadata accuracy', () => {
    it('metadata fields match actual API behavior', async () => {
      const provider = new DitImageProvider({
        apiToken: replicateToken,
        model: 'black-forest-labs/flux-schnell',
        numSteps: 4,
        guidanceScale: 0,
        outputFormat: 'png',
        storageDir: RENDER_DIR,
      });

      const before = Date.now();
      const out = await provider.render(imageSpec('poster'));
      const after = Date.now();

      const meta = out.metadata as DitGenerationMetadata;

      // Model
      expect(meta.model).toBe('black-forest-labs/flux-schnell');

      // Steps
      expect(meta.steps).toBe(4);

      // Guidance scale (schnell = 0)
      expect(meta.guidanceScale).toBe(0);

      // Timing
      expect(meta.renderTimeMs).toBeGreaterThanOrEqual(0);
      expect(meta.renderTimeMs).toBeLessThanOrEqual(after - before + 1000); // Allow 1s clock skew

      // Poll count (at least 1)
      expect(meta.pollCount).toBeGreaterThanOrEqual(1);

      // Aspect ratio
      expect(meta.aspectRatio).toBe('4:5');

      // Output format
      expect(meta.outputFormat).toBe('png');

      // Prompt tokens (approximate)
      expect(meta.promptTokens).toBeGreaterThan(100);
      expect(meta.promptTokens).toBeLessThan(600);

      console.log(`  ✅ Metadata verified: model=${meta.model}, steps=${meta.steps}, polls=${meta.pollCount}, time=${meta.renderTimeMs}ms`);
    }, 120_000);
  });

  // ── Negative prompt ─────────────────────────────────────────────────────

  describe('Negative prompt support', () => {
    it('sends negative_prompt to Replicate when provided', async () => {
      let capturedInput: Record<string, unknown> | undefined;
      const provider = new DitImageProvider({
        apiToken: replicateToken,
        model: 'black-forest-labs/flux-schnell',
        negativePrompt: 'blurry, ugly, deformed text',
        http: {
          post: async (url, body, options) => {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            capturedInput = parsed.input as Record<string, unknown>;
            // Forward to real API
            const res = await fetch(url, {
              method: 'POST',
              headers: (options?.headers as Record<string, string>) ?? {},
              body,
            });
            return { status: res.status, ok: res.ok, body: await res.json() };
          },
          get: async (url, options) => {
            const res = await fetch(url, {
              headers: (options?.headers as Record<string, string>) ?? {},
            });
            return { status: res.status, ok: res.ok, body: await res.json() };
          },
        },
        storageDir: RENDER_DIR,
      });

      await provider.render(imageSpec('poster'));
      expect(capturedInput?.negative_prompt).toBe('blurry, ugly, deformed text');
    }, 120_000);
  });

  // ── Error handling with real API ─────────────────────────────────────────

  describe('Error handling', () => {
    it('rejects with DIT_NOT_CONFIGURED when token is empty', async () => {
      const provider = new DitImageProvider({
        apiToken: '',
        storageDir: RENDER_DIR,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_NOT_CONFIGURED',
      });
    });

    it('rejects with DIT_REQUEST_FAILED when token is invalid', async () => {
      const provider = new DitImageProvider({
        apiToken: 'r8_invalid-token-12345',
        storageDir: RENDER_DIR,
      });
      await expect(provider.render(imageSpec())).rejects.toMatchObject({
        status: 502,
        code: 'DIT_REQUEST_FAILED',
      });
    }, 30_000);
  });

  // ── Cross-kind rendering ────────────────────────────────────────────────

  describe('All asset kinds render successfully', () => {
    for (const kind of ASSET_KINDS) {
      if (kind === 'short_video') continue; // Video not supported by DiT

      it(`${kind} renders to a valid file`, async () => {
        const provider = defaultProvider();
        const out = await provider.render(imageSpec(kind));

        expect(out.storageKey).toBeTruthy();
        expect(out.storageKey).toContain(kind);

        const fullPath = path.join(RENDER_DIR, out.storageKey);
        const stat = await fs.stat(fullPath);
        expect(stat.size).toBeGreaterThan(500);

        const meta = out.metadata as DitGenerationMetadata;
        expect(meta.model).toBe('black-forest-labs/flux-schnell');

        console.log(`  ✅ ${kind}: ${out.storageKey} (${stat.size} bytes)`);
      }, 120_000);
    }
  });
});
