import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';
import type { HttpClient, HttpResponse, HttpRequestOptions } from '../src/platforms/httpClient';
import { ASSET_KINDS, DEFAULT_DIMENSIONS } from '../src/marketing/assets/assetKinds';
import type { AssetKind } from '../src/marketing/assets/assetKinds';
import { resolveRenderSpec, fallbackBrandSpec, AssetGenerator } from '../src/marketing/assets/assetGenerator';
import type {
  AssetCopy,
  RenderOutput,
  RenderProvider,
  ResolvedRenderSpec,
} from '../src/marketing/assets/assetGenerator';
import {
  buildImagePrompt,
  buildDitImagePrompt,
  buildVideoPrompt,
  brandStyleSuffix,
} from '../src/marketing/assets/providers/renderPrompt';
import {
  OpenAiCompatImageProvider,
} from '../src/marketing/assets/providers/openaiImageProvider';
import { OpenAiCompatVideoProvider } from '../src/marketing/assets/providers/openaiVideoProvider';
import type { WriteFileFn } from '../src/marketing/assets/providers/renderShared';
import {
  MediaRenderProvider,
  createMediaRenderProvider,
} from '../src/marketing/assets/providers/mediaRenderProvider';
import { DitImageProvider } from '../src/marketing/assets/providers/ditImageProvider';
import { createSecretLoader } from '../src/infra/secrets';

// ---- Helpers ----------------------------------------------------------------

/** A tiny 1x1 PNG, base64-encoded — a realistic non-empty inline image. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A short base64 "video" blob (non-empty bytes; content is irrelevant for tests). */
const MP4_FAKE_BASE64 = Buffer.from('fake-mp4-bytes-thanh-giang').toString('base64');

/** The OpenAI Images response shape with an inline base64 payload. */
function imagesB64Response(base64: string): HttpResponse {
  return { status: 200, ok: true, body: { data: [{ b64_json: base64 }] } };
}

/** The OpenAI Images response shape carrying a url (image or video). */
function imagesUrlResponse(url: string): HttpResponse {
  return { status: 200, ok: true, body: { data: [{ url }] } };
}

/** A 429 "overloaded" transient response (YeScale capacity). */
function overloadedResponse(model: string): HttpResponse {
  return { status: 429, ok: false, body: { error: `Model ${model} currently overloaded` } };
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

function videoSpec(): ResolvedRenderSpec {
  return resolveRenderSpec('short_video', fallbackBrandSpec('short_video'), imageCopy);
}

// ---- Property 6: render prompt determinism + brand --------------------------

const assetKindArb: fc.Arbitrary<AssetKind> = fc.constantFrom(...ASSET_KINDS);
const copyArb: fc.Arbitrary<AssetCopy> = fc.record({
  title: fc.string({ minLength: 1, maxLength: 80 }),
  body: fc.string({ maxLength: 400 }),
  ctas: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 4 }),
  market: fc.option(fc.constantFrom('JAPAN', 'KOREA', 'GERMANY', 'TAIWAN'), { nil: undefined }),
});

describe('render prompt builders (pure)', () => {
  // Feature: marketing-autopilot, Property 6: render prompt determinism + brand
  it('Property 6: image+video prompts are deterministic, non-empty, brand-bearing, secret-free', () => {
    fc.assert(
      fc.property(assetKindArb, copyArb, (kind, copy) => {
        const spec = resolveRenderSpec(kind, fallbackBrandSpec(kind), copy);

        const img1 = buildImagePrompt(spec);
        const img2 = buildImagePrompt(spec);
        const vid1 = buildVideoPrompt(spec);
        const vid2 = buildVideoPrompt(spec);

        // Deterministic: identical spec => byte-identical prompt.
        expect(img1).toBe(img2);
        expect(vid1).toBe(vid2);

        // Non-empty.
        expect(img1.length).toBeGreaterThan(0);
        expect(vid1.length).toBeGreaterThan(0);

        // Brand-bearing: mention Thanh Giang + palette hex colors.
        for (const out of [img1, vid1]) {
          expect(out).toContain('Thanh Giang');
          expect(out).toContain(spec.palette.primary);
          expect(out).toContain(spec.palette.secondary);
        }

        // Headline text is encoded (title is the verbatim headline slot).
        const headline = spec.slots.find((s) => s.name === 'headline');
        if (headline && headline.text.trim().length > 0) {
          expect(img1).toContain(headline.text.trim());
          expect(vid1).toContain(headline.text.trim());
        }

        // No secret leakage: never an 'sk-' or 'AIza' substring.
        for (const out of [img1, vid1]) {
          expect(out.includes('sk-')).toBe(false);
          expect(out.includes('AIza')).toBe(false);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('brandStyleSuffix is a non-empty Thanh Giang descriptor with no secrets', () => {
    const s = brandStyleSuffix();
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain('Thanh Giang');
    expect(s.includes('sk-')).toBe(false);
    expect(s.includes('AIza')).toBe(false);
  });
});

// ---- buildDitImagePrompt (DiT-optimized) -----------------------------------

describe('buildDitImagePrompt', () => {
  it('is deterministic: identical spec => identical prompt', () => {
    const spec = imageSpec('poster');
    const p1 = buildDitImagePrompt(spec);
    const p2 = buildDitImagePrompt(spec);
    expect(p1).toBe(p2);
    expect(p1.length).toBeGreaterThan(0);
  });

  it('contains brand identity (Thanh Giang, palette hex colors)', () => {
    const spec = imageSpec('poster');
    const prompt = buildDitImagePrompt(spec);
    expect(prompt).toContain('Thanh Giang');
    expect(prompt).toContain(spec.palette.primary);
    expect(prompt).toContain(spec.palette.secondary);
  });

  it('encodes Vietnamese headline text verbatim', () => {
    const spec = imageSpec('poster');
    const headline = spec.slots.find((s) => s.name === 'headline');
    expect(headline).toBeDefined();
    const prompt = buildDitImagePrompt(spec);
    expect(prompt).toContain(headline!.text.trim());
  });

  it('contains DiT-specific compositional layout clause', () => {
    const poster = imageSpec('poster');
    const posterPrompt = buildDitImagePrompt(poster);
    // Poster should mention vertical layout and upper third
    expect(posterPrompt).toContain('upper third');
    expect(posterPrompt).toContain('lower third');

    const thumb = imageSpec('thumbnail');
    const thumbPrompt = buildDitImagePrompt(thumb);
    // Thumbnail should mention landscape layout
    expect(thumbPrompt).toContain('landscape');
    expect(thumbPrompt).toContain('bottom-right');
  });

  it('contains DiT-specific typography instructions', () => {
    const spec = imageSpec('poster');
    const prompt = buildDitImagePrompt(spec);
    // Should mention diacritics (critical for Vietnamese)
    expect(prompt).toContain('diacritics');
    // Should mention text hierarchy
    expect(prompt).toContain('Text hierarchy');
    // Should mention headline as anchor
    expect(prompt).toContain('visual anchor');
  });

  it('contains DiT-specific quality modifiers', () => {
    const spec = imageSpec('poster');
    const prompt = buildDitImagePrompt(spec);
    // Quality modifiers tuned for FLUX.1/SD3
    expect(prompt).toContain('sharp focus');
    expect(prompt).toContain('professional');
    expect(prompt).toContain('No artificial filters');
  });

  it('uses lighter negative prompts (DiT guidance-distilled)', () => {
    const spec = imageSpec('poster');
    const prompt = buildDitImagePrompt(spec);
    // Lighter negatives (no extra fingers, no warped faces)
    expect(prompt).toContain('Avoid misspelled or illegible Vietnamese text');
    // Should NOT contain the heavier U-Net style negatives
    expect(prompt).not.toContain('extra fingers');
    expect(prompt).not.toContain('warped faces');
  });

  it('contains explicit copy clause with Vietnamese text', () => {
    const spec = imageSpec('poster');
    const prompt = buildDitImagePrompt(spec);
    // Should mention exact Vietnamese text rendering
    expect(prompt).toContain('exact Vietnamese text');
  });

  it('contains logo placement instruction', () => {
    const spec = imageSpec('poster');
    const prompt = buildDitImagePrompt(spec);
    expect(prompt).toContain('logo');
    expect(prompt).toContain(spec.logo.position);
  });

  it('contains aspect ratio and dimensions', () => {
    const spec = imageSpec('poster');
    const prompt = buildDitImagePrompt(spec);
    expect(prompt).toContain(`${spec.dimensions.width}x${spec.dimensions.height}`);
  });

  it('is longer than buildImagePrompt (superset with DiT clauses)', () => {
    const spec = imageSpec('poster');
    const standard = buildImagePrompt(spec);
    const dit = buildDitImagePrompt(spec);
    // DiT prompt should be longer due to extra compositional/typography clauses
    expect(dit.length).toBeGreaterThan(standard.length);
  });

  it('different layout clauses per asset kind', () => {
    const poster = buildDitImagePrompt(imageSpec('poster'));
    const thumb = buildDitImagePrompt(imageSpec('thumbnail'));
    const infog = buildDitImagePrompt(imageSpec('infographic'));
    const img = buildDitImagePrompt(imageSpec('image'));

    // Poster: vertical
    expect(poster).toContain('Vertical poster layout');
    // Thumbnail: wide landscape
    expect(thumb).toContain('Wide landscape thumbnail layout');
    // Infographic: dense
    expect(infog).toContain('Dense infographic layout');
    // Image: square or balanced
    expect(img).toContain('Square or balanced layout');
  });

  it('contains CTA typography instruction when CTA text exists', () => {
    const spec = imageSpec('poster');
    const cta = spec.slots.find((s) => s.name === 'cta');
    expect(cta).toBeDefined();
    if (cta && cta.text.trim().length > 0) {
      const prompt = buildDitImagePrompt(spec);
      expect(prompt).toContain('button-style element');
    }
  });

  it('no secret leakage (sk-, AIza)', () => {
    const spec = imageSpec('poster');
    const prompt = buildDitImagePrompt(spec);
    expect(prompt.includes('sk-')).toBe(false);
    expect(prompt.includes('AIza')).toBe(false);
  });
});

// ---- OpenAiCompatImageProvider ----------------------------------------------

describe('OpenAiCompatImageProvider', () => {
  it('POSTs to /images/generations with Bearer auth and the {model,prompt,n} body', async () => {
    let capturedUrl = '';
    let capturedBody: unknown;
    let capturedAuth: string | undefined;
    const http = fakeHttp({
      post: async (url, body, options) => {
        capturedUrl = url;
        capturedBody = body;
        capturedAuth = options?.headers?.authorization;
        return imagesB64Response(PNG_1X1_BASE64);
      },
    });

    const provider = new OpenAiCompatImageProvider({
      apiKey: 'test-key',
      model: 'nano-banana-pro',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      storageDir: '/tmp/render',
      writeFile: async () => undefined,
      sleep: noSleep,
    });

    await provider.render(imageSpec('poster'));

    expect(capturedUrl).toBe('https://gateway.example.test/v1/images/generations');
    expect(capturedAuth).toBe('Bearer test-key');
    expect((capturedBody as { model: string }).model).toBe('nano-banana-pro');
    expect((capturedBody as { n: number }).n).toBe(1);
    expect(typeof (capturedBody as { prompt: string }).prompt).toBe('string');
  });

  it('parses data[0].b64_json into a .png file with image/* mime + non-empty bytes', async () => {
    let captured: { path: string; bytes: Buffer } | undefined;
    const writeFile: WriteFileFn = async (p, bytes) => {
      captured = { path: p, bytes };
    };
    const http = fakeHttp({ post: async () => imagesB64Response(PNG_1X1_BASE64) });

    const provider = new OpenAiCompatImageProvider({
      apiKey: 'test-key',
      model: 'nano-banana-pro',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      storageDir: '/tmp/render',
      writeFile,
      sleep: noSleep,
    });

    const out: RenderOutput = await provider.render(imageSpec('poster'));

    expect(out.storageKey.endsWith('.png')).toBe(true);
    expect(out.storageKey.startsWith('assets/poster/')).toBe(true);
    expect(out.mimeType.startsWith('image/')).toBe(true);
    expect(captured).toBeDefined();
    expect((captured as { bytes: Buffer }).bytes.length).toBeGreaterThan(0);
  });

  it('parses data[0].url by downloading the bytes via the http GET', async () => {
    let downloadedFrom = '';
    let captured: Buffer | undefined;
    const http = fakeHttp({
      post: async () => imagesUrlResponse('https://cdn.example.test/img/abc.jpg'),
      get: async (url) => {
        downloadedFrom = url;
        return { status: 200, ok: true, body: PNG_1X1_BASE64 };
      },
    });

    const provider = new OpenAiCompatImageProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      storageDir: '/tmp/render',
      writeFile: async (_p, bytes) => {
        captured = bytes;
      },
      sleep: noSleep,
    });

    const out = await provider.render(imageSpec('poster'));

    expect(downloadedFrom).toBe('https://cdn.example.test/img/abc.jpg');
    expect(out.storageKey.endsWith('.jpg')).toBe(true);
    expect(out.mimeType).toBe('image/jpeg');
    expect((captured as Buffer).length).toBeGreaterThan(0);
  });

  it('retries on HTTP 429 ("overloaded") then succeeds', async () => {
    let postCalls = 0;
    const http = fakeHttp({
      post: async () => {
        postCalls += 1;
        if (postCalls < 3) return overloadedResponse('nano-banana-pro');
        return imagesB64Response(PNG_1X1_BASE64);
      },
    });
    const provider = new OpenAiCompatImageProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      writeFile: async () => undefined,
      maxRetries: 3,
      sleep: noSleep,
    });

    const out = await provider.render(imageSpec('poster'));
    expect(out.storageKey.endsWith('.png')).toBe(true);
    expect(postCalls).toBe(3);
  });

  it('throws 502 IMAGE_AI_REQUEST_FAILED when 429 persists beyond maxRetries', async () => {
    let postCalls = 0;
    const http = fakeHttp({
      post: async () => {
        postCalls += 1;
        return overloadedResponse('nano-banana-pro');
      },
    });
    const provider = new OpenAiCompatImageProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      writeFile: async () => undefined,
      maxRetries: 2,
      sleep: noSleep,
    });

    await expect(provider.render(imageSpec())).rejects.toMatchObject({
      status: 502,
      code: 'IMAGE_AI_REQUEST_FAILED',
    });
    // initial attempt + 2 retries = 3 calls.
    expect(postCalls).toBe(3);
  });

  it('throws 502 IMAGE_AI_NOT_CONFIGURED when no apiKey', async () => {
    const provider = new OpenAiCompatImageProvider({
      baseUrl: 'https://gateway.example.test/v1',
      http: fakeHttp({}),
      writeFile: async () => undefined,
      sleep: noSleep,
    });
    await expect(provider.render(imageSpec())).rejects.toMatchObject({
      status: 502,
      code: 'IMAGE_AI_NOT_CONFIGURED',
    });
  });

  it('throws 502 when the HTTP call is not ok (non-429)', async () => {
    const http = fakeHttp({ post: async () => ({ status: 500, ok: false, body: { error: 'boom' } }) });
    const provider = new OpenAiCompatImageProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      writeFile: async () => undefined,
      sleep: noSleep,
    });
    await expect(provider.render(imageSpec())).rejects.toMatchObject({ status: 502 });
  });

  it('throws 502 IMAGE_AI_BAD_RESPONSE and does NOT write when data is missing', async () => {
    let wrote = false;
    const writeFile: WriteFileFn = async () => {
      wrote = true;
    };
    const http = fakeHttp({
      post: async () => ({ status: 200, ok: true, body: { data: [] } }),
    });
    const provider = new OpenAiCompatImageProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      writeFile,
      sleep: noSleep,
    });
    await expect(provider.render(imageSpec())).rejects.toMatchObject({
      status: 502,
      code: 'IMAGE_AI_BAD_RESPONSE',
    });
    expect(wrote).toBe(false);
  });
});

// ---- OpenAiCompatVideoProvider ----------------------------------------------

describe('OpenAiCompatVideoProvider', () => {
  it('POSTs the video model to /images/generations, downloads data[0].url, writes .mp4', async () => {
    let capturedUrl = '';
    let capturedAuth: string | undefined;
    let downloadedFrom = '';
    let captured: Buffer | undefined;
    const http = fakeHttp({
      post: async (url, _body, options) => {
        capturedUrl = url;
        capturedAuth = options?.headers?.authorization;
        return imagesUrlResponse('https://cdn.example.test/v/op-123.mp4');
      },
      get: async (url) => {
        downloadedFrom = url;
        return { status: 200, ok: true, body: MP4_FAKE_BASE64 };
      },
    });

    const provider = new OpenAiCompatVideoProvider({
      apiKey: 'test-key',
      model: 'veo3.1',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      storageDir: '/tmp/render',
      writeFile: async (_p, bytes) => {
        captured = bytes;
      },
      sleep: noSleep,
    });

    const out = await provider.render(videoSpec());

    expect(capturedUrl).toBe('https://gateway.example.test/v1/images/generations');
    expect(capturedAuth).toBe('Bearer test-key');
    expect(downloadedFrom).toBe('https://cdn.example.test/v/op-123.mp4');
    expect(out.storageKey.endsWith('.mp4')).toBe(true);
    expect(out.storageKey.startsWith('assets/short_video/')).toBe(true);
    expect(out.mimeType).toBe('video/mp4');
    expect((captured as Buffer).length).toBeGreaterThan(0);
  });

  it('parses an inline data[0].b64_json video payload', async () => {
    let captured: Buffer | undefined;
    const http = fakeHttp({
      post: async () => imagesB64Response(MP4_FAKE_BASE64),
    });
    const provider = new OpenAiCompatVideoProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      writeFile: async (_p, bytes) => {
        captured = bytes;
      },
      sleep: noSleep,
    });

    const out = await provider.render(videoSpec());
    expect(out.mimeType).toBe('video/mp4');
    expect((captured as Buffer).length).toBeGreaterThan(0);
  });

  it('retries on HTTP 429 ("overloaded") then succeeds', async () => {
    let postCalls = 0;
    const http = fakeHttp({
      post: async () => {
        postCalls += 1;
        if (postCalls < 2) return overloadedResponse('veo3.1');
        return imagesUrlResponse('https://cdn.example.test/v/x.mp4');
      },
      get: async () => ({ status: 200, ok: true, body: MP4_FAKE_BASE64 }),
    });
    const provider = new OpenAiCompatVideoProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      writeFile: async () => undefined,
      maxRetries: 3,
      sleep: noSleep,
    });

    const out = await provider.render(videoSpec());
    expect(out.storageKey.endsWith('.mp4')).toBe(true);
    expect(postCalls).toBe(2);
  });

  it('throws 502 VIDEO_AI_NOT_CONFIGURED when no apiKey', async () => {
    const provider = new OpenAiCompatVideoProvider({
      baseUrl: 'https://gateway.example.test/v1',
      http: fakeHttp({}),
      writeFile: async () => undefined,
      sleep: noSleep,
    });
    await expect(provider.render(videoSpec())).rejects.toMatchObject({
      status: 502,
      code: 'VIDEO_AI_NOT_CONFIGURED',
    });
  });

  it('throws 502 VIDEO_AI_BAD_RESPONSE (no hang) when no url/bytes are present', async () => {
    let wrote = false;
    const http = fakeHttp({
      post: async () => ({ status: 200, ok: true, body: { data: [{ id: 'task-1', status: 'queued' }] } }),
    });
    const provider = new OpenAiCompatVideoProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      http,
      writeFile: async () => {
        wrote = true;
      },
      sleep: noSleep,
    });
    await expect(provider.render(videoSpec())).rejects.toMatchObject({
      status: 502,
      code: 'VIDEO_AI_BAD_RESPONSE',
    });
    expect(wrote).toBe(false);
  });
});

// ---- MediaRenderProvider router ---------------------------------------------

/** Recording stub provider. */
function recordingProvider(name: string, calls: string[]): RenderProvider {
  return {
    name,
    render: async (spec: ResolvedRenderSpec): Promise<RenderOutput> => {
      calls.push(`${name}:${spec.kind}`);
      return { storageKey: `assets/${spec.kind}/x.bin`, mimeType: 'application/octet-stream' };
    },
  };
}

describe('MediaRenderProvider router', () => {
  it('routes short_video to the video provider and image kinds to the image provider', async () => {
    const calls: string[] = [];
    const image = recordingProvider('img', calls);
    const video = recordingProvider('vid', calls);
    const router = new MediaRenderProvider({ image, video });

    await router.render(videoSpec());
    for (const kind of ['image', 'thumbnail', 'poster', 'infographic'] as const) {
      await router.render(imageSpec(kind));
    }

    expect(calls[0]).toBe('vid:short_video');
    expect(calls.slice(1)).toEqual([
      'img:image',
      'img:thumbnail',
      'img:poster',
      'img:infographic',
    ]);
  });

  it('createMediaRenderProvider returns undefined when neither modality is configured', () => {
    const secrets = createSecretLoader({});
    expect(createMediaRenderProvider(secrets)).toBeUndefined();
  });

  it('createMediaRenderProvider with image-only env returns a provider whose video render throws 502', async () => {
    const secrets = createSecretLoader({
      GEMINI_IMAGE_API_KEY: 'test-image-key',
      GEMINI_IMAGE_BASE_URL: 'https://gateway.example.test/v1',
      ASSET_RENDER_DIR: '/tmp/render',
    });
    const provider = createMediaRenderProvider(secrets);
    expect(provider).toBeDefined();

    // Video modality is unconfigured -> clean 502 (graceful), no crash.
    await expect((provider as MediaRenderProvider).render(videoSpec())).rejects.toMatchObject({
      status: 502,
      code: 'VIDEO_AI_NOT_CONFIGURED',
    });
  });
});

// ---- Integration with AssetGenerator ---------------------------------------

interface AssetRow {
  id: string;
  draftId: string | null;
  kind: string;
  templateId: string | null;
  prompt: string;
  spec: unknown;
  status: string;
  storageKey: string | null;
  mimeType: string | null;
  provider: string;
}

/** Minimal Prisma fake (mirrors test/assets.test.ts) for generateStandalone. */
function fakeAssetPrisma(): { prisma: PrismaClient; assets: AssetRow[] } {
  const assets: AssetRow[] = [];
  let seq = 0;
  const prisma = {
    brandTemplate: { findUnique: async () => null, findFirst: async () => null },
    generatedAsset: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: AssetRow = {
          id: `asset-${++seq}`,
          draftId: (args.data.draftId as string | null) ?? null,
          kind: args.data.kind as string,
          templateId: (args.data.templateId as string | null) ?? null,
          prompt: (args.data.prompt as string) ?? '',
          spec: args.data.spec,
          status: (args.data.status as string) ?? 'SPEC_READY',
          storageKey: (args.data.storageKey as string | null) ?? null,
          mimeType: (args.data.mimeType as string | null) ?? null,
          provider: (args.data.provider as string) ?? 'none',
        };
        assets.push(row);
        return { ...row };
      },
      findUnique: async (args: { where: { id: string } }) => {
        const found = assets.find((a) => a.id === args.where.id);
        return found ? { ...found } : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = assets.find((a) => a.id === args.where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data);
        return { ...row };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, assets };
}

describe('AssetGenerator + media render provider integration', () => {
  it('persists RENDERED + storageKey when the provider renders successfully', async () => {
    const { prisma } = fakeAssetPrisma();
    const calls: string[] = [];
    const provider = new MediaRenderProvider({
      image: recordingProvider('img', calls),
      video: recordingProvider('vid', calls),
    });
    const generator = new AssetGenerator(prisma, provider);

    const asset = await generator.generateStandalone('poster', imageCopy);

    expect(asset.status).toBe('RENDERED');
    expect(asset.storageKey).toBe('assets/poster/x.bin');
    expect(asset.provider).toBe('gemini-media');
  });

  it('persists FAILED when the provider throws (no fake artifact)', async () => {
    const { prisma } = fakeAssetPrisma();
    const throwing: RenderProvider = {
      name: 'gemini-media',
      render: async () => {
        throw new Error('gateway unreachable');
      },
    };
    const generator = new AssetGenerator(prisma, throwing);

    const asset = await generator.generateStandalone('short_video', imageCopy);

    expect(asset.status).toBe('FAILED');
    expect(asset.storageKey).toBeNull();
    expect(asset.mimeType).toBeNull();
  });

  it('DEFAULT_DIMENSIONS sanity for short_video is 9:16 vertical', () => {
    expect(DEFAULT_DIMENSIONS.short_video.height).toBeGreaterThan(DEFAULT_DIMENSIONS.short_video.width);
  });
});

// ---- DitImageProvider (DiT / FLUX.1 via Replicate) --------------------------

describe('DitImageProvider', () => {
  it('throws 502 DIT_NOT_CONFIGURED when no apiToken', async () => {
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

  it('creates a Replicate prediction with correct Bearer auth and model input', async () => {
    let capturedUrl = '';
    let capturedBody: unknown;
    let capturedAuth: string | undefined;
    const http = fakeHttp({
      post: async (url, body, options) => {
        capturedUrl = url;
        capturedBody = body;
        capturedAuth = options?.headers?.authorization;
        return { status: 201, ok: true, body: { id: 'pred-abc123', status: 'starting' } };
      },
      get: async (url) => {
        if (url.includes('replicate.com')) {
          return {
            status: 200,
            ok: true,
            body: {
              id: 'pred-abc123',
              status: 'succeeded',
              output: ['https://cdn.example.test/img/result.png'],
            },
          };
        }
        // Image download
        return { status: 200, ok: true, body: PNG_1X1_BASE64 };
      },
    });

    const provider = new DitImageProvider({
      apiToken: 'r8_test-token',
      model: 'black-forest-labs/flux-schnell',
      http,
      storageDir: '/tmp/render',
      writeFile: async () => undefined,
      sleep: noSleep,
    });

    await provider.render(imageSpec('poster'));

    expect(capturedUrl).toBe('https://api.replicate.com/v1/predictions');
    expect(capturedAuth).toBe('Bearer r8_test-token');
    const parsed = typeof capturedBody === 'string' ? JSON.parse(capturedBody) : capturedBody;
    const body = parsed as { version: string; input: Record<string, unknown> };
    expect(body.version).toBe('black-forest-labs/flux-schnell');
    expect(typeof body.input.prompt).toBe('string');
    expect(body.input.num_outputs).toBe(1);
    expect(body.input.output_format).toBe('png');
  });

  it('downloads the output URL and writes the image file', async () => {
    let downloadedFrom = '';
    let captured: Buffer | undefined;
    const http = fakeHttp({
      post: async () => ({ status: 201, ok: true, body: { id: 'pred-1', status: 'starting' } }),
      get: async (url, options) => {
        if (url.includes('replicate.com')) {
          return {
            status: 200,
            ok: true,
            body: { id: 'pred-1', status: 'succeeded', output: ['https://cdn.example.test/img/flux-out.png'] },
          };
        }
        downloadedFrom = url;
        return { status: 200, ok: true, body: PNG_1X1_BASE64 };
      },
    });

    const provider = new DitImageProvider({
      apiToken: 'r8_test-token',
      http,
      storageDir: '/tmp/render',
      writeFile: async (_p, bytes) => {
        captured = bytes;
      },
      sleep: noSleep,
    });

    const out = await provider.render(imageSpec('poster'));

    expect(downloadedFrom).toBe('https://cdn.example.test/img/flux-out.png');
    expect(out.storageKey.startsWith('assets/poster/')).toBe(true);
    expect(out.storageKey.endsWith('.png')).toBe(true);
    expect(out.mimeType).toBe('image/png');
    expect((captured as Buffer).length).toBeGreaterThan(0);
  });

  it('polls until status is succeeded, then extracts image', async () => {
    let pollCount = 0;
    const http = fakeHttp({
      post: async () => ({ status: 201, ok: true, body: { id: 'pred-poll', status: 'starting' } }),
      get: async (url) => {
        if (url.includes('replicate.com')) {
          pollCount += 1;
          if (pollCount < 3) {
            return { status: 200, ok: true, body: { id: 'pred-poll', status: 'processing' } };
          }
          return {
            status: 200,
            ok: true,
            body: { id: 'pred-poll', status: 'succeeded', output: ['https://cdn.example.test/img/done.jpg'] },
          };
        }
        // Image download
        return { status: 200, ok: true, body: PNG_1X1_BASE64 };
      },
    });

    const provider = new DitImageProvider({
      apiToken: 'r8_test-token',
      http,
      storageDir: '/tmp/render',
      writeFile: async () => undefined,
      sleep: noSleep,
    });

    const out = await provider.render(imageSpec());
    expect(out.storageKey.endsWith('.jpg')).toBe(true);
    expect(out.mimeType).toBe('image/jpeg');
    expect(pollCount).toBe(3);
  });

  it('throws 502 DIT_REQUEST_FAILED when prediction fails', async () => {
    const http = fakeHttp({
      post: async () => ({ status: 201, ok: true, body: { id: 'pred-fail', status: 'starting' } }),
      get: async () => ({
        status: 200,
        ok: true,
        body: { id: 'pred-fail', status: 'failed', error: 'Out of memory' },
      }),
    });

    const provider = new DitImageProvider({
      apiToken: 'r8_test-token',
      http,
      writeFile: async () => undefined,
      sleep: noSleep,
    });

    await expect(provider.render(imageSpec())).rejects.toMatchObject({
      status: 502,
      code: 'DIT_REQUEST_FAILED',
    });
  });

  it('throws 502 DIT_BAD_RESPONSE when output array is empty', async () => {
    const http = fakeHttp({
      post: async () => ({ status: 201, ok: true, body: { id: 'pred-empty', status: 'starting' } }),
      get: async () => ({
        status: 200,
        ok: true,
        body: { id: 'pred-empty', status: 'succeeded', output: [] },
      }),
    });

    const provider = new DitImageProvider({
      apiToken: 'r8_test-token',
      http,
      writeFile: async () => undefined,
      sleep: noSleep,
    });

    await expect(provider.render(imageSpec())).rejects.toMatchObject({
      status: 502,
      code: 'DIT_BAD_RESPONSE',
    });
  });

  it('throws 502 DIT_REQUEST_FAILED when Replicate API returns non-ok', async () => {
    const http = fakeHttp({
      post: async () => ({ status: 401, ok: false, body: { error: 'Unauthorized' } }),
    });

    const provider = new DitImageProvider({
      apiToken: 'bad-token',
      http,
      writeFile: async () => undefined,
      sleep: noSleep,
    });

    await expect(provider.render(imageSpec())).rejects.toMatchObject({
      status: 502,
      code: 'DIT_REQUEST_FAILED',
    });
  });

  it('derives correct aspect ratio from spec dimensions', async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const http = fakeHttp({
      post: async (_url, body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        capturedInput = (parsed as { input: Record<string, unknown> }).input;
        return { status: 201, ok: true, body: { id: 'pred-ar', status: 'starting' } };
      },
      get: async (url) => {
        if (url.includes('replicate.com')) {
          return {
            status: 200,
            ok: true,
            body: { id: 'pred-ar', status: 'succeeded', output: ['https://cdn.example.test/img/ar.png'] },
          };
        }
        return { status: 200, ok: true, body: PNG_1X1_BASE64 };
      },
    });

    const provider = new DitImageProvider({
      apiToken: 'r8_test-token',
      http,
      writeFile: async () => undefined,
      sleep: noSleep,
    });

    // thumbnail is 1280x720 -> 16:9
    await provider.render(imageSpec('thumbnail'));
    expect(capturedInput?.aspect_ratio).toBe('16:9');

    // poster is 1080x1350 -> 4:5
    await provider.render(imageSpec('poster'));
    expect(capturedInput?.aspect_ratio).toBe('4:5');
  });

  it('accepts custom numSteps and guidanceScale', async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const http = fakeHttp({
      post: async (_url, body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        capturedInput = (parsed as { input: Record<string, unknown> }).input;
        return { status: 201, ok: true, body: { id: 'pred-cfg', status: 'starting' } };
      },
      get: async (url) => {
        if (url.includes('replicate.com')) {
          return {
            status: 200,
            ok: true,
            body: { id: 'pred-cfg', status: 'succeeded', output: ['https://cdn.example.test/img/cfg.png'] },
          };
        }
        return { status: 200, ok: true, body: PNG_1X1_BASE64 };
      },
    });

    const provider = new DitImageProvider({
      apiToken: 'r8_test-token',
      model: 'black-forest-labs/flux-dev',
      numSteps: 20,
      guidanceScale: 3.5,
      http,
      writeFile: async () => undefined,
      sleep: noSleep,
    });

    await provider.render(imageSpec());
    // Non-schnell model should include steps and guidance
    expect(capturedInput?.num_inference_steps).toBe(20);
    expect(capturedInput?.guidance_scale).toBe(3.5);
  });

  it('provider name is dit-flux', () => {
    const provider = new DitImageProvider({ apiToken: 'test' });
    expect(provider.name).toBe('dit-flux');
  });
});

// ---- MediaRenderProvider with DiT routing -----------------------------------

describe('MediaRenderProvider DiT routing', () => {
  it('createMediaRenderProvider returns DiT-backed provider when REPLICATE_API_TOKEN is set', () => {
    const secrets = createSecretLoader({
      REPLICATE_API_TOKEN: 'r8_test-token',
      ASSET_RENDER_DIR: '/tmp/render',
    });
    const provider = createMediaRenderProvider(secrets);
    expect(provider).toBeDefined();
    // DiT provider sets name='dit-flux', MediaRenderProvider detects it -> 'dit-media'
    expect((provider as MediaRenderProvider).name).toBe('dit-media');
  });

  it('createMediaRenderProvider falls back to OpenAI-compat when REPLICATE_API_TOKEN is empty', () => {
    const secrets = createSecretLoader({
      REPLICATE_API_TOKEN: '',
      GEMINI_IMAGE_API_KEY: 'test-image-key',
      GEMINI_IMAGE_BASE_URL: 'https://gateway.example.test/v1',
      ASSET_RENDER_DIR: '/tmp/render',
    });
    const provider = createMediaRenderProvider(secrets);
    expect(provider).toBeDefined();
    // OpenAI-compat provider sets name='yescale-image', MediaRenderProvider -> 'gemini-media'
    expect((provider as MediaRenderProvider).name).toBe('gemini-media');
  });

  it('createMediaRenderProvider prefers DiT when both REPLICATE_API_TOKEN and GEMINI_IMAGE_API_KEY are set', () => {
    const secrets = createSecretLoader({
      REPLICATE_API_TOKEN: 'r8_test-token',
      GEMINI_IMAGE_API_KEY: 'test-image-key',
      GEMINI_IMAGE_BASE_URL: 'https://gateway.example.test/v1',
      ASSET_RENDER_DIR: '/tmp/render',
    });
    const provider = createMediaRenderProvider(secrets);
    expect(provider).toBeDefined();
    // DiT wins when both are configured
    expect((provider as MediaRenderProvider).name).toBe('dit-media');
  });

  it('createMediaRenderProvider returns undefined when no image or video keys are set', () => {
    const secrets = createSecretLoader({});
    expect(createMediaRenderProvider(secrets)).toBeUndefined();
  });

  it('MediaRenderProvider with DiT image provider routes correctly by kind', async () => {
    const calls: string[] = [];
    const ditImage: RenderProvider = {
      name: 'dit-flux',
      render: async (spec) => {
        calls.push(`dit:${spec.kind}`);
        return { storageKey: `assets/${spec.kind}/dit.png`, mimeType: 'image/png' };
      },
    };
    const video: RenderProvider = {
      name: 'veo',
      render: async (spec) => {
        calls.push(`veo:${spec.kind}`);
        return { storageKey: `assets/${spec.kind}/vid.mp4`, mimeType: 'video/mp4' };
      },
    };
    const router = new MediaRenderProvider({ image: ditImage, video });

    // DiT router name should be 'dit-media'
    expect(router.name).toBe('dit-media');

    await router.render(videoSpec());
    await router.render(imageSpec('poster'));
    await router.render(imageSpec('thumbnail'));

    expect(calls).toEqual(['veo:short_video', 'dit:poster', 'dit:thumbnail']);
  });
});
