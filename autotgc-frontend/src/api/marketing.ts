/**
 * Typed wrappers for the AI Marketing Autopilot endpoints (customer: Thanh
 * Giang — XKLĐ): trend research, content planning, multi-format generation,
 * brand templates, and render-spec assets. Built on the shared `api` helper;
 * all paths use the /api/v1 gateway prefix and inherit Bearer auth + the
 * { error: { code, message } } envelope handling (ApiError).
 */
import { api } from '../lib/apiClient';
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
