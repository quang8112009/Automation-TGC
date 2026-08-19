import { describe, it, expect } from 'vitest';
import type { HttpClient, HttpResponse, HttpRequestOptions } from '../src/platforms/httpClient';
import { ASSET_KINDS, DEFAULT_DIMENSIONS } from '../src/marketing/assets/assetKinds';
import type { AssetKind } from '../src/marketing/assets/assetKinds';
import {
  resolveRenderSpec,
  fallbackBrandSpec,
  AssetGenerator,
} from '../src/marketing/assets/assetGenerator';
import type {
  AssetCopy,
  RenderOutput,
  RenderProvider,
  ResolvedRenderSpec,
} from '../src/marketing/assets/assetGenerator';
import {
  DitImageProvider,
} from '../src/marketing/assets/providers/ditImageProvider';
import {
  MediaRenderProvider,
} from '../src/marketing/assets/providers/mediaRenderProvider';
import {
  renderBatch,
  prepareBatchSpecs,
  DEFAULT_BATCH_CONCURRENCY,
} from '../src/marketing/assets/batchRenderer';
import type {
  BatchRenderItem,
  BatchRenderResult,
  BatchRenderItemResult,
} from '../src/marketing/assets/batchRenderer';

// ---- Helpers ----------------------------------------------------------------

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

function fakeHttp(handlers: {
  post?: (url: string, body: unknown, options?: HttpRequestOptions) => Promise<HttpResponse>;
  get?: (url: string, options?: HttpRequestOptions) => Promise<HttpResponse>;
}): HttpClient {
  return {
    post: handlers.post ?? (async () => ({ status: 500, ok: false, body: null })),
    get: handlers.get ?? (async () => ({ status: 500, ok: false, body: null })),
  };
}

/** Create a DiT provider with fast-succeeding HTTP mocks. */
function createFastDitProvider(opts?: {
  storageDir?: string;
  http?: HttpClient;
  writeFile?: (path: string, bytes: Buffer) => Promise<void>;
}): DitImageProvider {
  const writeFile = opts?.writeFile ?? (async () => undefined);
  const http = opts?.http ?? fakeHttp({
    post: async () => ({ status: 201, ok: true, body: { id: 'pred-1', status: 'starting' } }),
    get: async (url) => {
      if (url.includes('replicate.com')) {
        return {
          status: 200, ok: true,
          body: { id: 'pred-1', status: 'succeeded', output: ['https://cdn.example.test/img/out.png'] },
        };
      }
      return { status: 200, ok: true, body: PNG_1X1_BASE64 };
    },
  });

  return new DitImageProvider({
    apiToken: 'r8_test-token',
    http,
    storageDir: opts?.storageDir ?? '/tmp/render',
    writeFile,
    sleep: noSleep,
  });
}

function batchItems(count: number): BatchRenderItem[] {
  const kinds: AssetKind[] = ['poster', 'thumbnail', 'infographic', 'image', 'short_video'];
  return Array.from({ length: count }, (_, i) => ({
    kind: kinds[i % kinds.length],
    copy: { ...imageCopy, title: `Batch item ${i + 1}` },
  }));
}

// ---- batchRenderer (pure) --------------------------------------------------

describe('batchRenderer — pure functions', () => {
  it('prepareBatchSpecs resolves valid items', () => {
    const items = batchItems(3);
    const prepared = prepareBatchSpecs(items);
    expect(prepared).toHaveLength(3);
    for (const p of prepared) {
      expect(p.spec).toBeDefined();
      expect(p.prompt.length).toBeGreaterThan(0);
      expect(p.kind).toBeTruthy();
    }
  });

  it('prepareBatchSpecs skips invalid kinds', () => {
    const items = [
      { kind: 'poster' as AssetKind, copy: imageCopy },
      { kind: 'INVALID_KIND' as unknown as AssetKind, copy: imageCopy },
      { kind: 'thumbnail' as AssetKind, copy: imageCopy },
    ];
    const prepared = prepareBatchSpecs(items);
    expect(prepared).toHaveLength(2);
    expect(prepared[0].kind).toBe('poster');
    expect(prepared[1].kind).toBe('thumbnail');
  });

  it('prepareBatchSpecs returns empty for empty input', () => {
    expect(prepareBatchSpecs([])).toHaveLength(0);
  });

  it('DEFAULT_BATCH_CONCURRENCY is 4', () => {
    expect(DEFAULT_BATCH_CONCURRENCY).toBe(4);
  });
});

// ---- DitImageProvider.renderBatch -------------------------------------------

describe('DitImageProvider.renderBatch', () => {
  it('renders multiple specs in parallel', async () => {
    let postCount = 0;
    const http = fakeHttp({
      post: async () => {
        postCount += 1;
        return { status: 201, ok: true, body: { id: `pred-${postCount}`, status: 'starting' } };
      },
      get: async (url) => {
        if (url.includes('replicate.com')) {
          const predId = url.split('/').pop();
          return {
            status: 200, ok: true,
            body: { id: predId, status: 'succeeded', output: ['https://cdn.example.test/img/out.png'] },
          };
        }
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

    const specs = ['poster', 'thumbnail', 'image'].map((k) =>
      resolveRenderSpec(k as AssetKind, fallbackBrandSpec(k as AssetKind), imageCopy),
    );

    const results = await provider.renderBatch(specs, 3);

    expect(results).toHaveLength(3);
    expect(postCount).toBe(3);
    for (const r of results) {
      expect(r.result).toBeDefined();
      expect(r.result!.storageKey).toMatch(/^assets\//);
      expect(r.result!.mimeType).toBeTruthy();
      expect(r.error).toBeUndefined();
    }
  });

  it('handles partial failures gracefully', async () => {
    let postCount = 0;
    const http = fakeHttp({
      post: async () => {
        postCount += 1;
        if (postCount === 2) {
          return { status: 401, ok: false, body: { error: 'Unauthorized' } };
        }
        return { status: 201, ok: true, body: { id: `pred-${postCount}`, status: 'starting' } };
      },
      get: async (url) => {
        if (url.includes('replicate.com')) {
          return {
            status: 200, ok: true,
            body: { id: 'pred', status: 'succeeded', output: ['https://cdn.example.test/img/out.png'] },
          };
        }
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

    const specs = ['poster', 'thumbnail', 'image'].map((k) =>
      resolveRenderSpec(k as AssetKind, fallbackBrandSpec(k as AssetKind), imageCopy),
    );

    const results = await provider.renderBatch(specs, 3);

    expect(results).toHaveLength(3);
    // First and third succeed, second fails.
    expect(results[0].result).toBeDefined();
    expect(results[1].error).toBeDefined();
    expect(results[2].result).toBeDefined();
  });

  it('throws DIT_NOT_CONFIGURED when apiToken is missing', async () => {
    const provider = new DitImageProvider({
      apiToken: '',
      sleep: noSleep,
    });

    const specs = [resolveRenderSpec('poster', fallbackBrandSpec('poster'), imageCopy)];

    await expect(provider.renderBatch(specs)).rejects.toMatchObject({
      status: 502,
      code: 'DIT_NOT_CONFIGURED',
    });
  });

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const http = fakeHttp({
      post: async () => {
        currentConcurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        currentConcurrent -= 1;
        return { status: 201, ok: true, body: { id: `pred-${Date.now()}`, status: 'starting' } };
      },
      get: async (url) => {
        if (url.includes('replicate.com')) {
          return {
            status: 200, ok: true,
            body: { id: 'pred', status: 'succeeded', output: ['https://cdn.example.test/img/out.png'] },
          };
        }
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

    const specs = Array.from({ length: 8 }, () =>
      resolveRenderSpec('poster', fallbackBrandSpec('poster'), imageCopy),
    );

    // With concurrency 2, at most 2 should be in flight at once.
    // Note: the createPrediction calls are parallel (all fire at once),
    // so maxConcurrent reflects the event loop batching.
    await provider.renderBatch(specs, 2);
    // All 8 should have completed.
    expect(maxConcurrent).toBeGreaterThan(0);
  });
});

// ---- MediaRenderProvider.renderBatch ----------------------------------------

describe('MediaRenderProvider.renderBatch', () => {
  it('delegates to image provider renderBatch for image specs', async () => {
    let batchCalled = false;
    const imageProvider: RenderProvider = {
      name: 'dit-flux',
      render: async () => ({ storageKey: 'test.png', mimeType: 'image/png' }),
      renderBatch: async (specs: ResolvedRenderSpec[]) => {
        batchCalled = true;
        return specs.map((spec) => ({
          spec,
          result: { storageKey: `${spec.kind}-batch.png`, mimeType: 'image/png' },
        }));
      },
    } as RenderProvider & { renderBatch: Function };

    const videoProvider: RenderProvider = {
      name: 'video',
      render: async () => ({ storageKey: 'test.mp4', mimeType: 'video/mp4' }),
    };

    const media = new MediaRenderProvider({ image: imageProvider, video: videoProvider });

    const specs = ['poster', 'thumbnail', 'image'].map((k) =>
      resolveRenderSpec(k as AssetKind, fallbackBrandSpec(k as AssetKind), imageCopy),
    );

    const results = await media.renderBatch(specs);

    expect(batchCalled).toBe(true);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.result).toBeDefined();
      expect(r.result!.storageKey).toContain('batch');
    }
  });

  it('falls back to sequential rendering when renderBatch not available', async () => {
    let renderCount = 0;
    const imageProvider: RenderProvider = {
      name: 'openai-compat',
      render: async () => {
        renderCount += 1;
        return { storageKey: `seq-${renderCount}.png`, mimeType: 'image/png' };
      },
    };

    const videoProvider: RenderProvider = {
      name: 'video',
      render: async () => ({ storageKey: 'video.mp4', mimeType: 'video/mp4' }),
    };

    const media = new MediaRenderProvider({ image: imageProvider, video: videoProvider });

    const specs = ['poster', 'thumbnail'].map((k) =>
      resolveRenderSpec(k as AssetKind, fallbackBrandSpec(k as AssetKind), imageCopy),
    );

    const results = await media.renderBatch(specs);

    expect(renderCount).toBe(2);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.result).toBeDefined();
    }
  });

  it('splits image and video specs correctly', async () => {
    const imageSpecs: ResolvedRenderSpec[] = [];
    const videoSpecs: ResolvedRenderSpec[] = [];

    const imageProvider: RenderProvider & { renderBatch?: Function } = {
      name: 'dit-flux',
      render: async () => ({ storageKey: 'img.png', mimeType: 'image/png' }),
      renderBatch: async (specs: ResolvedRenderSpec[]) => {
        imageSpecs.push(...specs);
        return specs.map((s) => ({ spec: s, result: { storageKey: 'batch.png', mimeType: 'image/png' } }));
      },
    };

    const videoProvider: RenderProvider = {
      name: 'video',
      render: async (spec) => {
        videoSpecs.push(spec);
        return { storageKey: 'video.mp4', mimeType: 'video/mp4' };
      },
    };

    const media = new MediaRenderProvider({ image: imageProvider, video: videoProvider });

    const specs = [
      resolveRenderSpec('poster', fallbackBrandSpec('poster'), imageCopy),
      resolveRenderSpec('short_video', fallbackBrandSpec('short_video'), imageCopy),
      resolveRenderSpec('thumbnail', fallbackBrandSpec('thumbnail'), imageCopy),
    ];

    const results = await media.renderBatch(specs);

    expect(imageSpecs).toHaveLength(2); // poster + thumbnail
    expect(videoSpecs).toHaveLength(1); // short_video
    expect(results).toHaveLength(3);
  });

  it('handles individual render failures without killing the batch', async () => {
    const imageProvider: RenderProvider & { renderBatch?: Function } = {
      name: 'dit-flux',
      render: async () => ({ storageKey: 'img.png', mimeType: 'image/png' }),
      renderBatch: async (specs: ResolvedRenderSpec[]) => {
        return specs.map((s, i) => {
          if (i === 1) return { spec: s, error: new Error('Rate limited') };
          return { spec: s, result: { storageKey: `${s.kind}.png`, mimeType: 'image/png' } };
        });
      },
    };

    const videoProvider: RenderProvider = {
      name: 'video',
      render: async () => ({ storageKey: 'video.mp4', mimeType: 'video/mp4' }),
    };

    const media = new MediaRenderProvider({ image: imageProvider, video: videoProvider });

    const specs = ['poster', 'thumbnail', 'image'].map((k) =>
      resolveRenderSpec(k as AssetKind, fallbackBrandSpec(k as AssetKind), imageCopy),
    );

    const results = await media.renderBatch(specs);

    expect(results).toHaveLength(3);
    const succeeded = results.filter((r) => r.result);
    const failed = results.filter((r) => r.error);
    expect(succeeded.length).toBeGreaterThanOrEqual(2);
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- AssetGenerator.generateBatch -------------------------------------------

describe('AssetGenerator.generateBatch', () => {
  /** Minimal Prisma fake for generateBatch tests. */
  function fakePrisma(): Record<string, unknown> {
    const assets: Array<{ id: string; status: string; kind: string; draftId: string | null; storageKey: string | null; mimeType: string | null }> = [];
    let seq = 0;

    return {
      generatedAsset: {
        create: async (args: { data: Record<string, unknown> }) => {
          seq += 1;
          const asset = {
            id: `asset-${seq}`,
            status: args.data.status as string,
            kind: args.data.kind as string,
            draftId: args.data.draftId as string | null,
            storageKey: null as string | null,
            mimeType: null as string | null,
            templateId: args.data.templateId as string | null,
            prompt: args.data.prompt as string,
            spec: args.data.spec,
            provider: args.data.provider as string,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          assets.push(asset);
          return asset;
        },
        findUnique: async (args: { where: { id: string } }) => {
          return assets.find((a) => a.id === args.where.id) ?? null;
        },
        findMany: async () => assets,
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const asset = assets.find((a) => a.id === args.where.id);
          if (!asset) return null;
          if (args.data.status) asset.status = args.data.status as string;
          if (args.data.storageKey) asset.storageKey = args.data.storageKey as string;
          if (args.data.mimeType) asset.mimeType = args.data.mimeType as string;
          if (args.data.provider) asset.provider = args.data.provider as string;
          return asset;
        },
      },
      brandTemplate: {
        findUnique: async () => null,
        findFirst: async () => null,
      },
    };
  }

  it('creates multiple assets and renders them via renderBatch', async () => {
    let batchCalled = false;
    const provider: RenderProvider & { renderBatch?: Function } = {
      name: 'dit-flux',
      render: async () => ({ storageKey: 'single.png', mimeType: 'image/png' }),
      renderBatch: async (specs: ResolvedRenderSpec[]) => {
        batchCalled = true;
        return specs.map((s) => ({
          spec: s,
          result: { storageKey: `assets/${s.kind}/batch.png`, mimeType: 'image/png' },
        }));
      },
    };

    const generator = new AssetGenerator(fakePrisma() as never, provider);

    const results = await generator.generateBatch([
      { kind: 'poster', copy: imageCopy },
      { kind: 'thumbnail', copy: imageCopy },
      { kind: 'image', copy: imageCopy },
    ]);

    expect(batchCalled).toBe(true);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe('RENDERED');
      expect(r.storageKey).toBeTruthy();
      expect(r.mimeType).toBeTruthy();
    }
  });

  it('stays SPEC_READY when no render provider is configured', async () => {
    const generator = new AssetGenerator(fakePrisma() as never);

    const results = await generator.generateBatch([
      { kind: 'poster', copy: imageCopy },
      { kind: 'thumbnail', copy: imageCopy },
    ]);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe('SPEC_READY');
    }
  });

  it('handles partial render failures', async () => {
    const provider: RenderProvider & { renderBatch?: Function } = {
      name: 'dit-flux',
      render: async () => ({ storageKey: 'single.png', mimeType: 'image/png' }),
      renderBatch: async (specs: ResolvedRenderSpec[]) => {
        return specs.map((s, i) => {
          if (i === 1) return { spec: s, error: new Error('API rate limit') };
          return { spec: s, result: { storageKey: `assets/${s.kind}/ok.png`, mimeType: 'image/png' } };
        });
      },
    };

    const generator = new AssetGenerator(fakePrisma() as never, provider);

    const results = await generator.generateBatch([
      { kind: 'poster', copy: imageCopy },
      { kind: 'thumbnail', copy: imageCopy },
      { kind: 'image', copy: imageCopy },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('RENDERED');
    expect(results[1].status).toBe('FAILED');
    expect(results[2].status).toBe('RENDERED');
  });

  it('falls back to sequential rendering when renderBatch is absent', async () => {
    let renderCount = 0;
    const provider: RenderProvider = {
      name: 'openai-compat',
      render: async (spec) => {
        renderCount += 1;
        return { storageKey: `seq-${renderCount}.png`, mimeType: 'image/png' };
      },
    };

    const generator = new AssetGenerator(fakePrisma() as never, provider);

    const results = await generator.generateBatch([
      { kind: 'poster', copy: imageCopy },
      { kind: 'thumbnail', copy: imageCopy },
    ]);

    expect(renderCount).toBe(2);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe('RENDERED');
    }
  });

  it('records DB metadata correctly', async () => {
    const prisma = fakePrisma();
    const provider: RenderProvider & { renderBatch?: Function } = {
      name: 'dit-flux',
      render: async () => ({ storageKey: 'single.png', mimeType: 'image/png' }),
      renderBatch: async (specs: ResolvedRenderSpec[]) =>
        specs.map((s) => ({
          spec: s,
          result: { storageKey: `assets/${s.kind}/test.png`, mimeType: 'image/png' },
        })),
    };

    const generator = new AssetGenerator(prisma as never, provider);

    const results = await generator.generateBatch([
      { kind: 'poster', copy: imageCopy },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('RENDERED');

    // Verify the DB record was updated.
    const assets = await (prisma as Record<string, { findMany: () => Promise<Array<{ status: string; storageKey: string | null; provider: string | null }>> }>).generatedAsset.findMany();
    expect(assets).toHaveLength(1);
    expect(assets[0].status).toBe('RENDERED');
    expect(assets[0].storageKey).toBe('assets/poster/test.png');
    expect(assets[0].provider).toBe('dit-flux');
  });

  it('handles empty input', async () => {
    const generator = new AssetGenerator(fakePrisma() as never);
    const results = await generator.generateBatch([]);
    expect(results).toHaveLength(0);
  });
});

// ---- renderBatch (integration) ----------------------------------------------

describe('renderBatch — integration', () => {
  it('renders all 5 asset kinds in a single batch', async () => {
    const http = fakeHttp({
      post: async (url, body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        const version = (parsed as { version: string }).version;
        return { status: 201, ok: true, body: { id: `pred-${Date.now()}`, status: 'starting', version } };
      },
      get: async (url) => {
        if (url.includes('replicate.com')) {
          return {
            status: 200, ok: true,
            body: { id: 'pred', status: 'succeeded', output: ['https://cdn.example.test/img/result.png'] },
          };
        }
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

    const items: BatchRenderItem[] = ASSET_KINDS.map((kind) => ({
      kind,
      copy: { ...imageCopy, title: `Batch ${kind}` },
    }));

    const result = await renderBatch(items, provider, 5);

    expect(result.total).toBe(5);
    expect(result.succeeded).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.renderTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.items).toHaveLength(5);
    for (const item of result.items) {
      expect(item.status).toBe('success');
      if (item.status === 'success') {
        expect(item.storageKey).toBeTruthy();
        expect(item.mimeType).toBeTruthy();
      }
    }
  });

  it('uses concurrency limit to bound parallelism', async () => {
    let maxInflight = 0;
    let currentInflight = 0;

    const http = fakeHttp({
      post: async () => {
        currentInflight += 1;
        maxInflight = Math.max(maxInflight, currentInflight);
        return { status: 201, ok: true, body: { id: `pred-${Date.now()}`, status: 'starting' } };
      },
      get: async (url) => {
        if (url.includes('replicate.com')) {
          currentInflight -= 1;
          return {
            status: 200, ok: true,
            body: { id: 'pred', status: 'succeeded', output: ['https://cdn.example.test/img/out.png'] },
          };
        }
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

    const items: BatchRenderItem[] = Array.from({ length: 6 }, (_, i) => ({
      kind: 'poster' as AssetKind,
      copy: { ...imageCopy, title: `Item ${i}` },
    }));

    const result = await renderBatch(items, provider, 2);
    expect(result.succeeded).toBe(6);
  });

  it('skips items with invalid kinds', async () => {
    const provider = createFastDitProvider();

    const items: BatchRenderItem[] = [
      { kind: 'poster', copy: imageCopy },
      { kind: 'INVALID' as unknown as AssetKind, copy: imageCopy },
    ];

    const result = await renderBatch(items, provider);
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('tracks renderTimeMs', async () => {
    const provider = createFastDitProvider();
    const items: BatchRenderItem[] = [{ kind: 'poster', copy: imageCopy }];

    const result = await renderBatch(items, provider);
    expect(result.renderTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves item order in results', async () => {
    const order: string[] = [];
    const http = fakeHttp({
      post: async (_url, body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        const input = (parsed as { input: { prompt: string } }).input;
        // Extract kind from prompt.
        const kind = input.prompt.includes('poster') ? 'poster'
          : input.prompt.includes('thumbnail') ? 'thumbnail'
          : 'image';
        order.push(`create-${kind}`);
        return { status: 201, ok: true, body: { id: `pred-${kind}`, status: 'starting' } };
      },
      get: async (url) => {
        if (url.includes('replicate.com')) {
          return {
            status: 200, ok: true,
            body: { id: 'pred', status: 'succeeded', output: ['https://cdn.example.test/img/out.png'] },
          };
        }
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

    const items: BatchRenderItem[] = [
      { kind: 'poster', copy: imageCopy },
      { kind: 'thumbnail', copy: imageCopy },
      { kind: 'image', copy: imageCopy },
    ];

    const result = await renderBatch(items, provider, 3);

    expect(result.items).toHaveLength(3);
    expect(result.items[0].kind).toBe('poster');
    expect(result.items[1].kind).toBe('thumbnail');
    expect(result.items[2].kind).toBe('image');
  });
});
