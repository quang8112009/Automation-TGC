/**
 * Typed wrappers for the study-abroad-ai-advisor-suite endpoints:
 *  - Admissions: academic profile (read/upsert) + Reach/Match/Safety scoring.
 *  - Essays: SOP / motivation / CV drafts with the REVIEW MODE lifecycle.
 *  - Applications: program application cases + the merged due-item timeline.
 *  - Roadmap: study→career→PR ROI estimate, profile readiness, and REVIEW MODE
 *    roadmap narratives.
 *
 * Built on the shared `api` helper; every candidate-scoped path encodes the
 * candidate id and uses the /api/v1 gateway prefix (Bearer auth + the
 * { error: { code, message } } envelope are handled by apiClient). The pure
 * scoring cores surface the string 'INSUFFICIENT_DATA' instead of a misleading
 * number — callers render that as "Chưa đủ dữ liệu".
 */
import { api } from '../lib/apiClient';

// ---- Shared ----------------------------------------------------------------

/** A metric the backend may report as a number or the missing-data sentinel. */
export type NumericOrInsufficient = number | 'INSUFFICIENT_DATA';

/** REVIEW MODE lifecycle status shared by essays and roadmap narratives. */
export type ReviewStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'ARCHIVED';

// ---- Admissions ------------------------------------------------------------

/** Persisted 1–1 academic profile (mirrors Prisma AcademicProfile). */
export interface AcademicProfile {
  id: string;
  candidateId: string;
  gpa: number | null;
  gpaScale: number | null;
  ielts: number | null;
  toefl: number | null;
  jlpt: string | null;
  educationLevel: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Editable academic-profile fields (all optional/nullable). */
export interface AcademicProfileInput {
  gpa?: number | null;
  gpaScale?: number | null;
  ielts?: number | null;
  toefl?: number | null;
  jlpt?: string | null;
  educationLevel?: string | null;
}

/** Admission band assigned to a scored program. */
export type AdmissionBand = 'REACH' | 'MATCH' | 'SAFETY' | 'INSUFFICIENT_DATA';

/** A single unmet dimension with the program-published target + current value. */
export interface AdmissionGap {
  dimension: 'GPA' | 'IELTS' | 'TOEFL' | 'JLPT';
  target: number | string;
  current: number | string | null;
}

/** One (candidate, program) admission scoring result. */
export interface AdmissionResult {
  programId: string;
  name: string;
  country: string;
  score: NumericOrInsufficient;
  band: AdmissionBand;
  gaps: AdmissionGap[] | 'INSUFFICIENT_DATA';
}

/** PUT /api/v1/candidates/:id/academic-profile — upsert the academic profile. */
export function putAcademicProfile(
  candidateId: string,
  body: AcademicProfileInput,
): Promise<AcademicProfile> {
  return api.put<AcademicProfile>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/academic-profile`,
    body,
  );
}

/** GET /api/v1/candidates/:id/academic-profile — read it (null when unset). */
export function getAcademicProfile(candidateId: string): Promise<AcademicProfile | null> {
  return api.get<AcademicProfile | null>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/academic-profile`,
  );
}

/** POST /api/v1/candidates/:id/admissions/score — score the active catalogue. */
export function scoreAdmissions(candidateId: string): Promise<AdmissionResult[]> {
  return api.post<AdmissionResult[]>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/admissions/score`,
  );
}

// ---- Essays ----------------------------------------------------------------

/** Document kind handled by the essay writer/reviewer. */
export type EssayDocType = 'SOP' | 'MOTIVATION' | 'CV';

/** Explicit generation mode; defaults to 'AI' (Gemini-optional fallback). */
export type EssayGenMode = 'AI' | 'STRUCTURED';

/** A persisted essay draft (mirrors Prisma EssayDraft). */
export interface EssayDraft {
  id: string;
  candidateId: string;
  docType: EssayDocType;
  programId: string | null;
  content: string;
  aiGenerated: boolean;
  status: ReviewStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Result of reviewing an essay against a rubric (score ∈ [0,1]). */
export interface EssayReview {
  score: number;
  feedback: string[];
}

export interface CreateEssayInput {
  docType: EssayDocType;
  programId?: string;
  mode?: EssayGenMode;
}

/** GET /api/v1/candidates/:id/essays — list a candidate's drafts (newest first). */
export function listEssays(candidateId: string): Promise<EssayDraft[]> {
  return api.get<EssayDraft[]>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/essays`,
  );
}

/** POST /api/v1/candidates/:id/essays — create a draft (always starts DRAFT). */
export function createEssay(candidateId: string, body: CreateEssayInput): Promise<EssayDraft> {
  return api.post<EssayDraft>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/essays`,
    body,
  );
}

/** POST /api/v1/candidates/:id/essays/:essayId/review — rubric score + feedback. */
export function reviewEssay(candidateId: string, essayId: string): Promise<EssayReview> {
  return api.post<EssayReview>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/essays/${encodeURIComponent(essayId)}/review`,
  );
}

/** POST /api/v1/candidates/:id/essays/:essayId/transition — REVIEW MODE step. */
export function transitionEssay(
  candidateId: string,
  essayId: string,
  target: ReviewStatus,
): Promise<EssayDraft> {
  return api.post<EssayDraft>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/essays/${encodeURIComponent(essayId)}/transition`,
    { target },
  );
}

/** DELETE /api/v1/candidates/:id/essays/:essayId — remove a draft. */
export function deleteEssay(
  candidateId: string,
  essayId: string,
): Promise<{ status: string }> {
  return api.del<{ status: string }>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/essays/${encodeURIComponent(essayId)}`,
  );
}

// ---- Applications / timeline -----------------------------------------------

/** A single program application case with its due items. */
export interface ApplicationCase {
  id: string;
  candidateId: string;
  programId: string | null;
  intakeLabel: string;
  targetIntakeDate: string | null;
  status: string;
  visaCaseId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  dueItems: ApplicationDueItem[];
}

/** A due item belonging to an application case. */
export interface ApplicationDueItem {
  id: string;
  caseId: string;
  code: string;
  label: string;
  category: string;
  required: boolean;
  dueAt: string | null;
  status: string;
  done: boolean;
}

export interface ApplicationListResult {
  items: ApplicationCase[];
  total: number;
}

export interface CreateApplicationInput {
  programId?: string;
  intakeLabel: string;
  targetIntakeDate?: string;
  country?: string;
}

/** A merged timeline item across application cases + visa cases. */
export interface TimelineItem {
  id: string;
  caseId: string;
  caseType: 'APPLICATION' | 'VISA';
  code: string;
  label: string;
  dueAt: string | null;
  done: boolean;
}

/** GET /api/v1/candidates/:id/applications/timeline result. */
export interface TimelineResult {
  items: TimelineItem[];
  nextDue: TimelineItem | null;
}

/** GET /api/v1/candidates/:id/applications — list cases (newest first). */
export function listApplications(candidateId: string): Promise<ApplicationListResult> {
  return api.get<ApplicationListResult>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/applications`,
  );
}

/** POST /api/v1/candidates/:id/applications — create an application case. */
export function createApplication(
  candidateId: string,
  body: CreateApplicationInput,
): Promise<ApplicationCase> {
  return api.post<ApplicationCase>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/applications`,
    body,
  );
}

/** GET /api/v1/candidates/:id/applications/timeline — merged, ordered timeline. */
export function getTimeline(candidateId: string): Promise<TimelineResult> {
  return api.get<TimelineResult>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/applications/timeline`,
  );
}

// ---- Roadmap & readiness ---------------------------------------------------

/** Deterministic ROI estimate for a (candidate, program) pair. */
export interface RoadmapEstimate {
  netCostPerYearVndM: NumericOrInsufficient;
  totalCostVndM: NumericOrInsufficient;
  roi: NumericOrInsufficient;
  careerNotes: string[];
  prPathwayNotes: string[];
}

/** A single unmet/under-target dimension (reuses the admissions gap shape). */
export interface ReadinessGap {
  dimension: 'GPA' | 'IELTS' | 'TOEFL' | 'JLPT';
  target: number | string;
  current: number | string | null;
}

/** Profile-readiness score (∈ [0,1] or INSUFFICIENT_DATA) + grounded gaps. */
export interface ReadinessResult {
  score: NumericOrInsufficient;
  gaps: ReadinessGap[];
}

/** A persisted roadmap narrative (mirrors Prisma RoadmapNarrative). */
export interface RoadmapNarrative {
  id: string;
  candidateId: string;
  programId: string | null;
  estimate: RoadmapEstimate;
  narrative: string;
  aiGenerated: boolean;
  status: ReviewStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoadmapNarrativeInput {
  programId: string;
  mode?: EssayGenMode;
}

/** POST /api/v1/candidates/:id/roadmap — ROI estimate for a program. */
export function estimateRoadmap(candidateId: string, programId: string): Promise<RoadmapEstimate> {
  return api.post<RoadmapEstimate>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/roadmap`,
    { programId },
  );
}

/** GET /api/v1/candidates/:id/roadmap/readiness — readiness score + gaps. */
export function getReadiness(candidateId: string, programId?: string): Promise<ReadinessResult> {
  return api.get<ReadinessResult>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/roadmap/readiness`,
    { programId },
  );
}

/** POST /api/v1/candidates/:id/roadmap/narrative — create a DRAFT narrative. */
export function createRoadmapNarrative(
  candidateId: string,
  body: CreateRoadmapNarrativeInput,
): Promise<RoadmapNarrative> {
  return api.post<RoadmapNarrative>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/roadmap/narrative`,
    body,
  );
}

/** POST /api/v1/candidates/:id/roadmap/narrative/:nid/transition — REVIEW step. */
export function transitionRoadmapNarrative(
  candidateId: string,
  nid: string,
  target: ReviewStatus,
): Promise<RoadmapNarrative> {
  return api.post<RoadmapNarrative>(
    `/api/v1/candidates/${encodeURIComponent(candidateId)}/roadmap/narrative/${encodeURIComponent(nid)}/transition`,
    { target },
  );
}
