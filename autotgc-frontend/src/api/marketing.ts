/**
 * Typed wrappers for the AI Marketing Autopilot endpoints (customer: Thanh
 * Giang — XKLĐ): trend research, content planning, multi-format generation,
 * brand templates, and render-spec assets. Built on the shared `api` helper;
 * all paths use the /api/v1 gateway prefix and inherit Bearer auth + the
 * { error: { code, message } } envelope handling (ApiError).
 */
import { api } from '../lib/apiClient';
import { ApiError } from '../lib/apiClient';
import { apiUrl } from '../lib/config';
import { getAccessToken } from '../lib/storage';
import type {
  BrandTemplate,
  BrandTemplateListResult,
  ContentPlan,
  ContentPlanItem,
  ContentPlanItemsResult,
  ContentPlanListResult,
  ContentPlanWithItems,
  FormatsResult,
  GeneratedAsset,
  GeneratedAssetListResult,
  MultiFormatResult,
  TrendListResult,
  TrendResearchResult,
  TrendSignal,
} from '../lib/types';

// ---- Trends ----------------------------------------------------------------

export function researchTrends(market: string): Promise<TrendResearchResult> {
  return api.post<TrendResearchResult>('/api/v1/trends/research', { market });
}

export function listTrends(market?: string, status?: string): Promise<TrendListResult> {
  return api.get<TrendListResult>('/api/v1/trends', { market, status });
}

export function reviewTrend(id: string, status: string): Promise<TrendSignal> {
  return api.post<TrendSignal>(`/api/v1/trends/${encodeURIComponent(id)}/review`, { status });
}

// ---- Content plans ---------------------------------------------------------

export interface CreateContentPlanInput {
  market: string;
  objective: string;
  periodFrom: string;
  periodTo: string;
  channels?: string[];
}

export function createContentPlan(input: CreateContentPlanInput): Promise<ContentPlanWithItems> {
  return api.post<ContentPlanWithItems>('/api/v1/content-plans', input);
}

export function listContentPlans(market?: string, status?: string): Promise<ContentPlanListResult> {
  return api.get<ContentPlanListResult>('/api/v1/content-plans', { market, status });
}

export function getContentPlan(id: string): Promise<ContentPlanWithItems> {
  return api.get<ContentPlanWithItems>(`/api/v1/content-plans/${encodeURIComponent(id)}`);
}

export function activateContentPlan(id: string): Promise<ContentPlan> {
  return api.post<ContentPlan>(`/api/v1/content-plans/${encodeURIComponent(id)}/activate`);
}

export function archiveContentPlan(id: string): Promise<ContentPlan> {
  return api.post<ContentPlan>(`/api/v1/content-plans/${encodeURIComponent(id)}/archive`);
}

export function listContentPlanItems(id: string): Promise<ContentPlanItemsResult> {
  return api.get<ContentPlanItemsResult>(`/api/v1/content-plans/${encodeURIComponent(id)}/items`);
}

export interface MarkPlanItemInput {
  status: string;
  draftId?: string;
}

export function markPlanItem(itemId: string, input: MarkPlanItemInput): Promise<ContentPlanItem> {
  return api.post<ContentPlanItem>(
    `/api/v1/content-plans/items/${encodeURIComponent(itemId)}/mark`,
    input,
  );
}

// ---- Multi-format generation -----------------------------------------------

export function getFormats(): Promise<FormatsResult> {
  return api.get<FormatsResult>('/api/v1/generation/formats');
}

export interface MultiFormatInput {
  format: string;
  domainName: string;
  personaIds: string[];
  objective: string;
  market?: string;
  topic?: string;
  keyword?: string;
  seoKeywords?: string[];
  planItemId?: string;
}

/**
 * Generate format-specific content. Returns a 201 draft on success; throws an
 * ApiError with status 502 (code AI_NOT_CONFIGURED) when Gemini is unconfigured
 * — callers render that cleanly as "Chưa cấu hình AI (Gemini)".
 */
export function generateMultiFormat(input: MultiFormatInput): Promise<MultiFormatResult> {
  return api.post<MultiFormatResult>('/api/v1/generation/multi-format', input);
}

/** Callbacks for the streaming multi-format generator. */
export interface MultiFormatStreamHandlers {
  /** Invoked for each user-facing text chunk as it arrives. */
  onDelta: (text: string) => void;
  /** Invoked once with the persisted draft when generation completes. */
  onDone: (result: MultiFormatResult) => void;
  /** Invoked on an error (pre-stream envelope OR an in-stream `error` frame). */
  onError: (err: ApiError) => void;
}

/**
 * Streaming variant of {@link generateMultiFormat}. Opens an SSE-style POST to
 * `/api/v1/generation/multi-format/stream` and dispatches `delta` / `done` /
 * `error` frames to the handlers. The persisted draft is identical to the
 * non-streaming route; the only difference is the UI sees text as it is written.
 *
 * Returns an abort function the caller can invoke to cancel the stream (e.g. on
 * unmount). Auth is the stored Bearer token; a 401 is surfaced as onError (the
 * streaming path does not attempt the silent refresh-and-retry the JSON client
 * does, so a caller seeing 401 should re-trigger after a normal request).
 */
export function streamMultiFormat(
  input: MultiFormatInput,
  handlers: MultiFormatStreamHandlers,
): () => void {
  const controller = new AbortController();

  void (async () => {
    let res: Response;
    try {
      const token = getAccessToken();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      res = await fetch(apiUrl('/api/v1/generation/multi-format/stream'), {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch {
      handlers.onError(new ApiError(0, 'NETWORK_ERROR', 'Không kết nối được máy chủ'));
      return;
    }

    // A pre-stream failure (validation 400, auth 401, etc.) comes back as a
    // normal JSON envelope, NOT an event stream.
    if (!res.ok || !res.body) {
      let code = 'GENERATION_FAILED';
      let message = res.statusText || 'Tạo nội dung thất bại';
      try {
        const data = (await res.json()) as { error?: { code?: string; message?: string } };
        if (data.error) {
          code = data.error.code ?? code;
          message = data.error.message ?? message;
        }
      } catch {
        /* keep defaults */
      }
      handlers.onError(new ApiError(res.status, code, message));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let currentEvent = 'message';

    const dispatch = (event: string, dataLines: string[]): void => {
      const data = dataLines.join('\n');
      if (!data) return;
      if (event === 'delta') {
        try {
          const parsed = JSON.parse(data) as { text?: string };
          if (typeof parsed.text === 'string') handlers.onDelta(parsed.text);
        } catch {
          /* ignore malformed delta */
        }
      } else if (event === 'done') {
        try {
          handlers.onDone(JSON.parse(data) as MultiFormatResult);
        } catch {
          handlers.onError(new ApiError(500, 'BAD_RESPONSE', 'Phản hồi kết thúc không hợp lệ'));
        }
      } else if (event === 'error') {
        try {
          const parsed = JSON.parse(data) as {
            error?: { code?: string; message?: string; status?: number };
          };
          // Use the backend-provided status so the error is classified
          // correctly (e.g. a 404 GEN_PERSONA_NOT_FOUND must NOT render as the
          // 502 "AI unconfigured" notice). Default to 500 (a generic error-box),
          // never 502, when the frame omits a status.
          const status =
            typeof parsed.error?.status === 'number' ? parsed.error.status : 500;
          handlers.onError(
            new ApiError(
              status,
              parsed.error?.code ?? 'GENERATION_FAILED',
              parsed.error?.message ?? 'Tạo nội dung thất bại',
            ),
          );
        } catch {
          handlers.onError(new ApiError(500, 'GENERATION_FAILED', 'Tạo nội dung thất bại'));
        }
      }
    };

    // Parse the SSE byte stream frame-by-frame (frames separated by a blank line).
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line === '') {
            currentEvent = 'message';
            continue;
          }
          if (line.startsWith(':')) continue; // comment / heartbeat
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dispatch(currentEvent, [line.slice(5).replace(/^ /, '')]);
          }
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        handlers.onError(new ApiError(0, 'STREAM_INTERRUPTED', 'Luồng nội dung bị gián đoạn'));
      }
    }
  })();

  return () => controller.abort();
}

// ---- Brand templates -------------------------------------------------------

export function listBrandTemplates(kind?: string): Promise<BrandTemplateListResult> {
  return api.get<BrandTemplateListResult>('/api/v1/brand-templates', { kind });
}

export interface CreateBrandTemplateInput {
  name: string;
  kind: string;
  spec?: unknown;
  active?: boolean;
}

export function createBrandTemplate(input: CreateBrandTemplateInput): Promise<BrandTemplate> {
  return api.post<BrandTemplate>('/api/v1/brand-templates', input);
}

export interface UpdateBrandTemplateInput {
  name?: string;
  spec?: unknown;
  active?: boolean;
}

export function updateBrandTemplate(id: string, input: UpdateBrandTemplateInput): Promise<BrandTemplate> {
  return api.put<BrandTemplate>(`/api/v1/brand-templates/${encodeURIComponent(id)}`, input);
}

export function deactivateBrandTemplate(id: string): Promise<BrandTemplate> {
  return api.post<BrandTemplate>(`/api/v1/brand-templates/${encodeURIComponent(id)}/deactivate`);
}

// ---- Generated assets (render-ready SPECs) ---------------------------------

export interface AssetFromDraftInput {
  draftId: string;
  kind: string;
  templateId?: string;
}

export function createAssetFromDraft(input: AssetFromDraftInput): Promise<GeneratedAsset> {
  return api.post<GeneratedAsset>('/api/v1/assets/from-draft', input);
}

export interface StandaloneAssetInput {
  kind: string;
  title: string;
  body: string;
  ctas?: string[];
  market?: string;
  templateId?: string;
}

export function createStandaloneAsset(input: StandaloneAssetInput): Promise<GeneratedAsset> {
  return api.post<GeneratedAsset>('/api/v1/assets/standalone', input);
}

export function listAssets(draftId?: string): Promise<GeneratedAssetListResult> {
  return api.get<GeneratedAssetListResult>('/api/v1/assets', { draftId });
}

export function getAsset(id: string): Promise<GeneratedAsset> {
  return api.get<GeneratedAsset>(`/api/v1/assets/${encodeURIComponent(id)}`);
}
