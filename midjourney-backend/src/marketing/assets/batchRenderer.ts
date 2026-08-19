/**
 * batchRenderer — concurrency-limited parallel rendering of multiple asset
 * specs through a single RenderProvider (customer: Thanh Giang, XKLĐ).
 *
 * DESIGN:
 *   - Accepts an array of (kind + copy) items.
 *   - Resolves each to a ResolvedRenderSpec (pure, deterministic).
 *   - Renders all specs in parallel with a configurable concurrency cap
 *     (default 4 — Replicate rate limits concurrent predictions).
 *   - Uses Promise.allSettled so a single failure never kills the batch.
 *   - Returns per-item results: success (storageKey, mimeType, metadata),
 *     failure (error code, message), or skip (invalid kind/copy).
 *
 * WHY:
 *   The autopilot workflow and the API currently render assets one-by-one.
 *   For a typical 5-item content plan this means 5 sequential Replicate API
 *   calls (each with ~10-30s of poll time). Batch rendering runs them in
 *   parallel, cutting wall-clock time from ~5×30s = 150s to ~30s + overhead.
 */
import type { GeneratedAsset } from '@prisma/client';
import type { AssetCopy } from './assetGenerator';
import type { RenderOutput, RenderProvider, ResolvedRenderSpec } from './assetGenerator';
import { resolveRenderSpec, fallbackBrandSpec, assetPromptText } from './assetGenerator';
import { isAssetKind, type AssetKind } from './assetKinds';
import { isTemplateKind } from './assetKinds';
import type { BrandSpec } from './brandTemplateService';
import { defaultBrandSpec, validateBrandSpec } from './brandTemplateService';

// ── Types ───────────────────────────────────────────────────────────────────

/** A single item in a batch render request. */
export interface BatchRenderItem {
  /** Asset kind (thumbnail|infographic|poster|short_video|image). */
  kind: AssetKind;
  /** Copy to fill the render spec slots. */
  copy: AssetCopy;
  /** Optional BrandSpec override; otherwise the active/default template for the kind. */
  brandSpec?: BrandSpec;
  /** Optional template ID for tracking / brand alignment. */
  templateId?: string;
}

/** Result for a single item in a batch render. */
export type BatchRenderItemResult =
  | {
      status: 'success';
      kind: AssetKind;
      storageKey: string;
      mimeType: string;
      metadata?: Record<string, unknown>;
      prompt: string;
      templateId: string | null;
    }
  | {
      status: 'failed';
      kind: AssetKind;
      error: string;
      code: string;
      prompt: string;
      templateId: string | null;
    }
  | {
      status: 'skipped';
      kind: AssetKind;
      reason: string;
    };

/** Aggregate result for a batch render. */
export interface BatchRenderResult {
  /** Total items requested. */
  total: number;
  /** Successfully rendered items. */
  succeeded: number;
  /** Failed items. */
  failed: number;
  /** Skipped items (invalid kind, etc.). */
  skipped: number;
  /** Wall-clock time in milliseconds. */
  renderTimeMs: number;
  /** Per-item results, in input order. */
  items: BatchRenderItemResult[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the brand spec for a batch item, with fallback. */
function resolveBrandSpecForItem(item: BatchRenderItem): BrandSpec {
  if (item.brandSpec) {
    return item.brandSpec;
  }
  if (isTemplateKind(item.kind)) {
    return defaultBrandSpec(item.kind);
  }
  return fallbackBrandSpec(item.kind);
}

// ── Core batch render function ──────────────────────────────────────────────

/** Default concurrency limit for parallel renders. */
export const DEFAULT_BATCH_CONCURRENCY = 4;

/**
 * Render multiple asset specs in parallel with bounded concurrency.
 *
 * @param items - The items to render.
 * @param provider - The render provider (e.g. DitImageProvider, MediaRenderProvider).
 * @param concurrency - Max parallel renders (default 4).
 * @returns Aggregate result with per-item success/failure/skip.
 */
export async function renderBatch(
  items: readonly BatchRenderItem[],
  provider: RenderProvider,
  concurrency: number = DEFAULT_BATCH_CONCURRENCY,
): Promise<BatchRenderResult> {
  const startTime = Date.now();
  const maxConcurrency = Math.max(1, Math.floor(concurrency));

  // Phase 1: resolve all specs deterministically (fast, no I/O).
  const resolved: Array<{
    index: number;
    item: BatchRenderItem;
    spec: ResolvedRenderSpec;
    prompt: string;
  } | null> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !isAssetKind(item.kind)) {
      resolved.push(null);
      continue;
    }
    try {
      const brandSpec = resolveBrandSpecForItem(item);
      const spec = resolveRenderSpec(item.kind, brandSpec, item.copy);
      const prompt = assetPromptText(item.kind, item.copy);
      resolved.push({ index: i, item, spec, prompt });
    } catch {
      resolved.push(null);
    }
  }

  // Phase 2: render with bounded concurrency using a sliding window.
  const results: BatchRenderItemResult[] = new Array(items.length);
  let nextIdx = 0;

  async function renderOne(entry: (typeof resolved)[number]): Promise<void> {
    if (!entry) return;
    const { index, item, spec, prompt } = entry;
    const templateId = item.templateId ?? null;

    try {
      const out = await provider.render(spec);
      results[index] = {
        status: 'success',
        kind: item.kind,
        storageKey: out.storageKey,
        mimeType: out.mimeType,
        metadata: out.metadata,
        prompt,
        templateId,
      };
    } catch (err: unknown) {
      const code = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code)
        : 'BATCH_RENDER_FAILED';
      const message = typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
      results[index] = {
        status: 'failed',
        kind: item.kind,
        error: message,
        code,
        prompt,
        templateId,
      };
    }
  }

  // Initialize skipped slots.
  for (let i = 0; i < items.length; i++) {
    if (!resolved[i]) {
      results[i] = {
        status: 'skipped',
        kind: items[i]?.kind ?? ('image' as AssetKind),
        reason: 'Invalid kind or failed spec resolution',
      };
    }
  }

  // Sliding-window concurrency limiter.
  const inflight: Set<Promise<void>> = new Set();

  while (nextIdx < resolved.length) {
    // Fill the window up to maxConcurrency.
    while (inflight.size < maxConcurrency && nextIdx < resolved.length) {
      const entry = resolved[nextIdx];
      nextIdx += 1;
      if (!entry) continue;

      const p = renderOne(entry).then(() => {
        inflight.delete(p);
      });
      inflight.add(p);
    }

    // Wait for at least one to finish before adding more.
    if (inflight.size > 0) {
      await Promise.race(inflight);
    }
  }

  // Drain remaining.
  if (inflight.size > 0) {
    await Promise.all(inflight);
  }

  // Aggregate stats.
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === 'success') succeeded += 1;
    else if (r.status === 'failed') failed += 1;
    else skipped += 1;
  }

  return {
    total: items.length,
    succeeded,
    failed,
    skipped,
    renderTimeMs: Date.now() - startTime,
    items: results,
  };
}

/**
 * Prepare a batch of specs from items (for use by AssetGenerator.generateBatch).
 * This resolves specs + creates DB records without rendering, so the generator
 * can persist them and then call renderBatch for the actual rendering.
 */
export interface PreparedBatchItem {
  index: number;
  kind: AssetKind;
  copy: AssetCopy;
  spec: ResolvedRenderSpec;
  prompt: string;
  templateId: string | null;
}

export function prepareBatchSpecs(
  items: readonly BatchRenderItem[],
): PreparedBatchItem[] {
  const prepared: PreparedBatchItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !isAssetKind(item.kind)) continue;

    try {
      const brandSpec = resolveBrandSpecForItem(item);
      const spec = resolveRenderSpec(item.kind, brandSpec, item.copy);
      const prompt = assetPromptText(item.kind, item.copy);
      prepared.push({
        index: i,
        kind: item.kind,
        copy: item.copy,
        spec,
        prompt,
        templateId: item.templateId ?? null,
      });
    } catch {
      // Skip items with invalid specs.
    }
  }

  return prepared;
}
