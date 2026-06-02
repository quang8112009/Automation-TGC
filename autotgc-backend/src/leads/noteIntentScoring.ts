/**
 * Note_Intent_Scoring — pure heuristic "độ nóng" (intent) scoring over a lead's
 * notes (proposal 3.3). Framework-free (no Prisma/Fastify/Gemini) so it is
 * deterministic and property-testable, mirroring `analytics/scoring.ts` and the
 * guarded `leads/statusMachine.ts`.
 *
 * It reads recent note text (the `note` field on Lead + LeadHistoryEntry),
 * tallies positive vs negative intent keywords (Vietnamese + English), and
 * derives a 0..100 score, a label, and a SUGGESTED next status that is ALWAYS a
 * legal `leadTransition` from the current status (or null) — it never proposes a
 * transition the state machine would reject.
 */
import { leadTransition } from './statusMachine';
import type { LeadStatus } from './statusMachine';

export type IntentLabel = 'HOT' | 'WARM' | 'COLD' | 'AT_RISK';

export interface IntentSignal {
  /** Intent score in [0, 100]. */
  score: number;
  label: IntentLabel;
  /** A legal next status per the state machine, or null when none applies. */
  suggestedStatus: LeadStatus | null;
  /** Human-readable reasons (matched keywords / conditions), stable order. */
  reasons: string[];
  /** True when there is no usable note text (score is not meaningful). */
  insufficient: boolean;
}

/** Positive-intent keywords (candidate is warming up / ready to proceed). */
export const POSITIVE_KEYWORDS: readonly string[] = [
  'đồng ý',
  'chốt',
  'quan tâm',
  'muốn đi',
  'muốn tham gia',
  'đăng ký',
  'sẵn sàng',
  'cọc',
  'đặt cọc',
  'ký hợp đồng',
  'hẹn phỏng vấn',
  'phỏng vấn',
  'nộp hồ sơ',
  'interested',
  'sign',
  'deposit',
  'ready',
  'enroll',
  'schedule interview',
];

/** Negative / rejection keywords (candidate is cooling / dropping out). */
export const NEGATIVE_KEYWORDS: readonly string[] = [
  'từ chối',
  'không quan tâm',
  'không đi',
  'hủy',
  'bận',
  'suy nghĩ thêm',
  'cân nhắc',
  'đắt',
  'chi phí cao',
  'sợ',
  'lo lắng',
  'để sau',
  'not interested',
  'reject',
  'decline',
  'cancel',
  'later',
  'expensive',
  'too high',
];

/** Points awarded/deducted per matched keyword (capped by clamping). */
const POSITIVE_WEIGHT = 18;
const NEGATIVE_WEIGHT = 22;
const BASE_SCORE = 40;

/** Score thresholds for labelling. */
export const HOT_THRESHOLD = 70;
export const WARM_THRESHOLD = 45;

/** Count distinct keyword hits across the joined note text (case-insensitive). */
function countHits(haystack: string, keywords: readonly string[]): string[] {
  const hits: string[] = [];
  for (const kw of keywords) {
    if (haystack.includes(kw.toLowerCase())) hits.push(kw);
  }
  return hits;
}

/** Clamp a number into [0, 100]; non-finite -> 0. */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Resolve a suggested next status from the label, but ONLY if it is a legal
 * transition from `currentStatus`. Returns null otherwise.
 *
 * - HOT  -> advance one step (NEW->CONTACTED, CONTACTED->QUALIFIED,
 *           QUALIFIED->CONVERTED) when legal.
 * - AT_RISK -> drop to LOST when legal (active statuses only).
 * - WARM/COLD -> no suggestion.
 */
function suggestStatus(label: IntentLabel, currentStatus: LeadStatus): LeadStatus | null {
  const tryTargets = (targets: readonly LeadStatus[]): LeadStatus | null => {
    for (const t of targets) {
      if (leadTransition(currentStatus, t).ok) return t;
    }
    return null;
  };

  if (label === 'HOT') {
    // Preferred forward target by current status; fall back to any legal advance.
    return tryTargets(['QUALIFIED', 'CONVERTED', 'CONTACTED']);
  }
  if (label === 'AT_RISK') {
    return tryTargets(['LOST']);
  }
  return null;
}

/**
 * Score a lead's notes. Empty/whitespace-only input => insufficient (score 0,
 * COLD, no suggestion). Never returns NaN; score is clamped to [0, 100].
 */
export function scoreNotes(notes: readonly string[], currentStatus: LeadStatus): IntentSignal {
  const joined = (notes ?? [])
    .filter((n): n is string => typeof n === 'string')
    .join('\n')
    .trim()
    .toLowerCase();

  if (joined.length === 0) {
    return {
      score: 0,
      label: 'COLD',
      suggestedStatus: null,
      reasons: [],
      insufficient: true,
    };
  }

  const positives = countHits(joined, POSITIVE_KEYWORDS);
  const negatives = countHits(joined, NEGATIVE_KEYWORDS);

  const score = clampScore(
    BASE_SCORE + positives.length * POSITIVE_WEIGHT - negatives.length * NEGATIVE_WEIGHT,
  );

  // Label: an explicit rejection signal with net-negative sentiment => AT_RISK.
  let label: IntentLabel;
  if (negatives.length > positives.length && negatives.length > 0) {
    label = 'AT_RISK';
  } else if (score >= HOT_THRESHOLD) {
    label = 'HOT';
  } else if (score >= WARM_THRESHOLD) {
    label = 'WARM';
  } else {
    label = 'COLD';
  }

  const reasons: string[] = [];
  if (positives.length > 0) reasons.push(`Tín hiệu tích cực: ${positives.join(', ')}`);
  if (negatives.length > 0) reasons.push(`Tín hiệu tiêu cực: ${negatives.join(', ')}`);
  if (reasons.length === 0) reasons.push('Không có từ khóa ý định rõ ràng trong ghi chú.');

  const suggestedStatus = suggestStatus(label, currentStatus);
  if (suggestedStatus) {
    reasons.push(`Đề xuất chuyển trạng thái: ${currentStatus} -> ${suggestedStatus}`);
  }

  return { score, label, suggestedStatus, reasons, insufficient: false };
}
