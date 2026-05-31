/**
 * Shared API types mirroring the backend contract. These describe response
 * shapes returned by the AutoTGC backend services (see autotgc-backend/src).
 */

export type Role = 'ADMIN' | 'SALES';

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

/** Backend error envelope: { error: { code, message } }. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

// ---- Dashboard --------------------------------------------------------------

export interface UpcomingPost {
  id: string;
  platform: string;
  scheduledAt: string;
  status: string;
}

export interface FailedPost {
  id: string;
  platform: string;
  errorCode: string | null;
  failureReason: string | null;
  retryCount: number;
}

export interface DashboardOverview {
  approvalQueue: {
    draftCount: number;
    pendingInsightCount: number;
    total: number;
  };
  upcomingPosts: UpcomingPost[];
  alerts: {
    failedPosts: FailedPost[];
  };
  kpis: {
    totalLeads: number;
    leadsByStatus: Record<string, number>;
  };
  dataSync: {
    lastSync: string | null;
    stale: boolean;
    status: string;
    thresholdHours: number;
  };
}

export interface DashboardNotification {
  type: string;
  refId: string;
  message: string;
  at: string;
}

// ---- Leads ------------------------------------------------------------------

export interface Lead {
  leadId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  platform: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  contentPostId: string;
  domainCategory: string | null;
  contentTopic: string | null;
  status: string;
  assignedTo: string | null;
  unattributed: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadHistoryEntry {
  id: string;
  leadId: string;
  previousStatus: string;
  newStatus: string;
  note: string | null;
  assignedTo: string | null;
  actor: string;
  changedAt: string;
}

export type LeadDetail = Lead & { history: LeadHistoryEntry[] };

export interface LeadListResult {
  items: Lead[];
  total: number;
  page: number;
  limit: number;
}

export interface LeadStats {
  groupBy: 'source' | 'platform' | 'date';
  buckets: Array<{ key: string; count: number }>;
}

// ---- Strategy / Personas ----------------------------------------------------

export interface ContentPersona {
  id: string;
  domainId: string;
  personaName: string;
  age: string;
  interests: string;
  targetNeeds: string;
  painPoints: string;
  toneOfVoice: string;
  recommendedTone: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface PersonaRecommendation {
  personaName?: string;
  age?: string;
  interests?: string;
  targetNeeds?: string;
  painPoints?: string;
  toneOfVoice?: string;
  recommendedTone?: string;
}

export interface CalendarDraftItem {
  id: string;
  title: string;
  status: string;
  color: string;
}

export interface CalendarScheduledItem {
  id: string;
  draftId: string;
  platform: string;
  platformLabel: string;
  scheduledAt: string;
  status: string;
  color: string;
}

export interface CalendarResult {
  view: 'month' | 'week' | 'day';
  from: string;
  to: string;
  drafts: CalendarDraftItem[];
  scheduledPosts: CalendarScheduledItem[];
  unavailable: string[];
}

// ---- Drafts / Generation ----------------------------------------------------

export interface DraftListItem {
  id: string;
  title: string;
  status: string;
}

export interface DraftListResult {
  items: DraftListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface DraftDetail {
  id: string;
  title: string;
  body: string;
  status: string;
  ctas: string[];
}

// ---- Insights / Feedback ----------------------------------------------------

export interface LearningInsightView {
  insightId: string;
  insightType: string;
  insightStatus: string;
  subject: Record<string, unknown>;
  metrics: Record<string, unknown>;
  recommendedChange: Record<string, unknown>;
  modifiedChange: Record<string, unknown> | null;
  confidenceScore: number;
  sampleSize: number;
  analysisPeriod: string;
  generatedAt: string;
}

export interface InsightListResult {
  items: LearningInsightView[];
  total: number;
}

export interface InsightDetail {
  insight: LearningInsightView;
  supportingRecords: Array<{
    postId: string;
    contentTopic: string;
    performanceLabel: string;
    conversionRate: number;
  }>;
}

// ---- Platform tokens --------------------------------------------------------

export interface PublicTokenView {
  platform: string;
  type: string;
  expiresAt: string | null;
  valid: boolean;
}

// ---- Workflows --------------------------------------------------------------

export interface WorkflowStep {
  id: string;
  runId: string;
  name: string;
  status: string;
  orderIndex: number;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowRun {
  id: string;
  type: string;
  status: string;
  currentStep: string | null;
  context: unknown;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStep[];
}

export interface WorkflowStartResult {
  runId: string;
  status: string;
  currentStep: string | null;
}

// ---- Realtime ---------------------------------------------------------------

export type RealtimeTopic =
  | 'draft'
  | 'scheduled_post'
  | 'insight'
  | 'lead'
  | 'token_alert'
  | 'workflow'
  | 'notification';

export interface RealtimeEvent {
  topic: RealtimeTopic;
  type: string;
  payload: unknown;
  at: string;
}

// ---- Recruitment CRM (XKLĐ — Thanh Giang Conincon) -------------------------

export type RecruitmentMarket =
  | 'JAPAN'
  | 'GERMANY'
  | 'KOREA'
  | 'TAIWAN'
  | 'DOMESTIC'
  | 'OTHER';

export type VisaType =
  | 'TOKUTEI'
  | 'ENGINEER'
  | 'TRAINEE'
  | 'STUDENT'
  | 'GERMANY_PROGRAM'
  | 'KOREA_EPS'
  | 'DOMESTIC_JOB'
  | 'OTHER';

export type JobOrderStatus = 'OPEN' | 'PAUSED' | 'CLOSED' | 'FILLED';

export type CandidateStage =
  | 'NEW'
  | 'CONSULTING'
  | 'PROFILE_COLLECTED'
  | 'MATCHED'
  | 'INTERVIEW_SCHEDULED'
  | 'INTERVIEW_PASSED'
  | 'COE_VISA'
  | 'DEPARTED'
  | 'WITHDRAWN'
  | 'REJECTED';

export type JapaneseLevel = 'NONE' | 'N5' | 'N4' | 'N3' | 'N2' | 'N1';

/** A recruitment job order (đơn hàng tuyển dụng). Mirrors the Prisma JobOrder. */
export interface JobOrder {
  id: string;
  code: string;
  title: string;
  industry: string;
  visaType: VisaType;
  market: RecruitmentMarket;
  workLocation: string;
  salaryText: string;
  salaryMinVndM: number | null;
  salaryMaxVndM: number | null;
  quantity: number;
  gender: string;
  nationalityReq: string;
  status: JobOrderStatus;
  deadline: string | null;
  description: string;
  sourcePostId: string | null;
  branchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobOrderListResult {
  items: JobOrder[];
  total: number;
  page: number;
  limit: number;
}

/** A recruitment candidate (ứng viên). Mirrors the Prisma CandidateProfile. */
export interface Candidate {
  id: string;
  leadId: string | null;
  fullName: string;
  phone: string | null;
  email: string | null;
  dob: string | null;
  gender: string;
  hometown: string;
  education: string;
  currentJob: string;
  desiredMarket: RecruitmentMarket | null;
  desiredIndustry: string;
  desiredVisaType: VisaType | null;
  japaneseLevel: string;
  otherLanguage: string;
  stage: CandidateStage;
  matchedJobOrderId: string | null;
  branchId: string | null;
  assignedTo: string | null;
  note: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateStageHistoryEntry {
  id: string;
  candidateId: string;
  previousStage: string;
  newStage: string;
  note: string | null;
  actor: string;
  changedAt: string;
}

export type CandidateDetail = Candidate & { history: CandidateStageHistoryEntry[] };

export interface CandidateListResult {
  items: Candidate[];
  total: number;
  page: number;
  limit: number;
}

export interface CandidateStats {
  groupBy: 'stage' | 'desiredMarket' | 'branchId';
  buckets: Array<{ key: string; count: number }>;
}

// ---- AI consultant + knowledge ---------------------------------------------

export interface KnowledgeEntry {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  market: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * AI consult result. `aiGenerated` is false when the answer is a deterministic,
 * knowledge-grounded fallback (no Gemini call) — still a valid answer, not a
 * failure.
 */
export interface AiConsultResult {
  answer: string;
  sources: KnowledgeEntry[];
  aiGenerated: boolean;
}

/** One ranked job-order suggestion as returned by /api/v1/ai/suggest-job-orders. */
export interface JobOrderSuggestion {
  jobOrderId: string;
  code: string;
  title: string;
  score: number;
  reasons: string[];
}

export interface SuggestJobOrdersResult {
  candidateId: string;
  suggestions: JobOrderSuggestion[];
}

/** AI outreach draft. `aiGenerated` false => grounded template fallback. */
export interface AiOutreachResult {
  message: string;
  aiGenerated: boolean;
}

// ---- AI Marketing Autopilot (Thanh Giang — XKLĐ) ---------------------------
//
// Mirrors the additive marketing backend (src/marketing/*): trend research,
// content planning, multi-format generation, brand templates + render-spec
// assets, and the autopilot orchestration loop. `market`/`format`/`channel`
// are free-form Strings in Prisma but constrained to these unions in the UI.

/** Canonical marketing market codes (mirrors src/marketing/markets.ts). */
export type MarketingMarket =
  | 'JAPAN'
  | 'KOREA'
  | 'GERMANY'
  | 'TAIWAN'
  | 'AUSTRALIA'
  | 'LITHUANIA'
  | 'EUROPE'
  | 'DOMESTIC'
  | 'OTHER';

/** Content-format codes (mirrors src/marketing/content/formats.ts). */
export type ContentFormatCode =
  | 'GENERIC'
  | 'SEO_ARTICLE'
  | 'FANPAGE_CAPTION'
  | 'VIDEO_SCRIPT'
  | 'EMAIL'
  | 'CARE_MESSAGE'
  | 'CHATBOT_FAQ';

/** Distribution channels a plan item / autopilot run spans. */
export type MarketingChannel =
  | 'facebook'
  | 'tiktok'
  | 'youtube'
  | 'website'
  | 'zalo'
  | 'email';

/** Plan-level / item-level objective. */
export type MarketingObjective = 'Lead' | 'View' | 'Follow';

// ---- Trends ----------------------------------------------------------------

export type TrendStatus = 'DISCOVERED' | 'REVIEWED' | 'ADOPTED' | 'DISMISSED';

export interface TrendSignal {
  id: string;
  market: string;
  keyword: string;
  topic: string;
  intent: string;
  demandScore: number;
  rationale: string;
  sources: unknown;
  status: TrendStatus;
  discoveredAt: string;
}

/** POST /api/v1/trends/research result. */
export interface TrendResearchResult {
  created: TrendSignal[];
  aiGenerated: boolean;
}

/** GET /api/v1/trends result. */
export interface TrendListResult {
  trends: TrendSignal[];
}

// ---- Content plans ---------------------------------------------------------

export type PlanStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type PlanItemStatus = 'PLANNED' | 'GENERATED' | 'SCHEDULED' | 'PUBLISHED' | 'SKIPPED';

export interface ContentPlanItem {
  id: string;
  planId: string;
  market: string;
  channel: string;
  format: string;
  topic: string;
  keyword: string;
  objective: string;
  targetDate: string | null;
  status: string;
  draftId: string | null;
  trendId: string | null;
  orderIndex: number;
  createdAt: string;
}

export interface ContentPlan {
  id: string;
  market: string;
  title: string;
  objective: string;
  periodFrom: string;
  periodTo: string;
  status: PlanStatus;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ContentPlanWithItems = ContentPlan & { items: ContentPlanItem[] };

/** GET /api/v1/content-plans result. */
export interface ContentPlanListResult {
  plans: ContentPlan[];
}

/** GET /api/v1/content-plans/:id/items result. */
export interface ContentPlanItemsResult {
  items: ContentPlanItem[];
}

// ---- Multi-format generation -----------------------------------------------

export interface FormatMetaView {
  label: string;
  ctasRequired: boolean;
  lengthHint: string;
}

/** GET /api/v1/generation/formats result. */
export interface FormatsResult {
  formats: string[];
  meta: Record<string, FormatMetaView>;
}

export interface MarketingDraftCta {
  id: string;
  draftId: string;
  ctaText: string;
}

/** A ContentDraft as returned by multi-format generation (with ctas eagerly loaded). */
export interface MarketingContentDraft {
  id: string;
  title: string;
  body: string;
  status: string;
  objective: string;
  format: string;
  market: string | null;
  language: string;
  planItemId: string | null;
  seoKeywords: unknown;
  generatedWithoutFeedback: boolean;
  ctas: MarketingDraftCta[];
  createdAt?: string;
  updatedAt?: string;
}

/** POST /api/v1/generation/multi-format result (201). */
export interface MultiFormatResult {
  draft: MarketingContentDraft;
  format: string;
  aiGenerated: boolean;
  generatedWithoutFeedback: boolean;
}

// ---- Brand templates + render-spec assets ----------------------------------

export type AssetKind = 'thumbnail' | 'infographic' | 'poster' | 'short_video' | 'image';
export type TemplateKind = 'thumbnail' | 'infographic' | 'poster' | 'short_video';

export interface BrandTemplate {
  id: string;
  name: string;
  kind: string;
  spec: unknown;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BrandTemplateListResult {
  items: BrandTemplate[];
}

/** A resolved layout slot (name + the concrete text the renderer would draw). */
export interface ResolvedSlot {
  name: string;
  text: string;
}

export interface RenderSpecPalette {
  primary: string;
  secondary: string;
  bg: string;
  text: string;
}

export interface RenderSpecFonts {
  heading: string;
  body: string;
}

export interface RenderSpecLogo {
  url?: string;
  position: string;
}

/** The render-ready blueprint persisted on GeneratedAsset.spec (SPEC_READY). */
export interface ResolvedRenderSpec {
  kind: string;
  dimensions: { width: number; height: number };
  palette: RenderSpecPalette;
  fonts: RenderSpecFonts;
  logo: RenderSpecLogo;
  slots: ResolvedSlot[];
}

export interface GeneratedAsset {
  id: string;
  draftId: string | null;
  kind: string;
  templateId: string | null;
  prompt: string;
  /** A ResolvedRenderSpec when status is SPEC_READY (no render provider). */
  spec: unknown;
  status: string;
  storageKey: string | null;
  mimeType: string | null;
  provider: string;
  createdAt: string;
  updatedAt: string;
}

export interface GeneratedAssetListResult {
  items: GeneratedAsset[];
}

// ---- Autopilot -------------------------------------------------------------

/** POST /api/v1/autopilot/run + approve/cancel result. */
export interface AutopilotStartResult {
  runId: string;
  status: string;
  currentStep: string | null;
}

// NOTE: GET /api/v1/autopilot/runs/:id returns a WorkflowRun (with steps) —
// reuse the existing WorkflowRun / WorkflowStep types above.

/** Shape of the autopilot summary step output (best-effort; fields optional). */
export interface AutopilotSummary {
  market: string | null;
  planId: string | null;
  generated: number;
  scheduled: number;
  skipped: number;
}
