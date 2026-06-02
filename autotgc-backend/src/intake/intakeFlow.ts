/**
 * Intake_Flow — pure conversational dossier-collection engine (chatbot brain).
 *
 * Framework-free (no Prisma / Fastify / network): given a flow definition, the
 * already-collected answers, and an inbound message, it decides the next
 * question to ask, validates/normalizes answers, and reports when the dossier is
 * complete. This keeps the chatbot logic deterministic and property-testable;
 * the channel adapters (Facebook/Zalo) and the service only do I/O.
 *
 * A "flow" is an ordered list of fields, each with a Vietnamese prompt, a type,
 * optional choices, and whether it is required. The engine asks required fields
 * first (in order), skipping ones already answered, then optional fields.
 */

export type IntakeFieldType = 'text' | 'phone' | 'email' | 'number' | 'date' | 'choice';

export interface IntakeField {
  /** Stable key stored in `collected` (e.g. 'fullName', 'desiredMarket'). */
  key: string;
  /** Vietnamese question prompt shown to the contact. */
  prompt: string;
  type: IntakeFieldType;
  required: boolean;
  /** Allowed values for `choice` fields (case-insensitive match). */
  choices?: readonly string[];
  /** Optional mapping onto a Lead/Candidate column for downstream promotion. */
  mapsTo?: string;
}

export interface IntakeFlow {
  key: string;
  /** Opening line sent before the first question. */
  greeting: string;
  /** Closing line sent once all required fields are collected. */
  completion: string;
  fields: readonly IntakeField[];
}

export type CollectedAnswers = Record<string, string | number>;

/** Result of validating/normalizing a raw answer for a field. */
export type AnswerParse =
  | { ok: true; value: string | number }
  | { ok: false; reason: string };

/** What the engine wants the channel to do next. */
export interface IntakeStep {
  /** 'ask' -> send `prompt` for `fieldKey`; 'complete' -> dossier finished. */
  kind: 'ask' | 'complete';
  fieldKey?: string;
  prompt?: string;
  /** True when the just-received answer was rejected and we re-ask. */
  reAsk?: boolean;
}

const PHONE_RE = /^[+]?[0-9][0-9\s.\-()]{6,17}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize a string for comparison: trimmed, lowercased. */
function norm(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * Validate + normalize a raw inbound answer against a field's type/choices.
 * Returns the value to store, or a rejection reason (Vietnamese) to re-ask.
 */
export function parseAnswer(field: IntakeField, raw: string): AnswerParse {
  const text = (raw ?? '').trim();
  if (text.length === 0) {
    return { ok: false, reason: 'Bạn vui lòng nhập thông tin nhé.' };
  }

  switch (field.type) {
    case 'phone':
      return PHONE_RE.test(text)
        ? { ok: true, value: text }
        : { ok: false, reason: 'Số điện thoại chưa hợp lệ, bạn nhập lại giúp mình nhé (VD: 0901234567).' };
    case 'email':
      return EMAIL_RE.test(text)
        ? { ok: true, value: text }
        : { ok: false, reason: 'Email chưa hợp lệ, bạn kiểm tra lại giúp mình nhé.' };
    case 'number': {
      const n = Number(text.replace(/[^\d.]/g, ''));
      return Number.isFinite(n) && n > 0
        ? { ok: true, value: Math.floor(n) }
        : { ok: false, reason: 'Bạn vui lòng nhập một con số hợp lệ nhé.' };
    }
    case 'date': {
      const d = new Date(text);
      return Number.isNaN(d.getTime())
        ? { ok: false, reason: 'Ngày chưa hợp lệ, bạn nhập theo dạng YYYY-MM-DD giúp mình nhé.' }
        : { ok: true, value: d.toISOString().slice(0, 10) };
    }
    case 'choice': {
      const choices = field.choices ?? [];
      const match = choices.find((c) => norm(c) === norm(text));
      if (match) return { ok: true, value: match };
      return {
        ok: false,
        reason: `Bạn vui lòng chọn một trong các lựa chọn: ${choices.join(', ')}.`,
      };
    }
    case 'text':
    default:
      return { ok: true, value: text };
  }
}

/**
 * The next field the bot should ask: the first REQUIRED field with no answer,
 * else the first OPTIONAL field with no answer, else null (dossier complete).
 */
export function nextField(flow: IntakeFlow, collected: CollectedAnswers): IntakeField | null {
  const unanswered = (f: IntakeField): boolean =>
    collected[f.key] === undefined || collected[f.key] === '';
  const requiredNext = flow.fields.find((f) => f.required && unanswered(f));
  if (requiredNext) return requiredNext;
  const optionalNext = flow.fields.find((f) => !f.required && unanswered(f));
  return optionalNext ?? null;
}

/** True when every REQUIRED field has a non-empty answer. */
export function isComplete(flow: IntakeFlow, collected: CollectedAnswers): boolean {
  return flow.fields.every(
    (f) => !f.required || (collected[f.key] !== undefined && collected[f.key] !== ''),
  );
}

/**
 * Advance the conversation by one inbound message.
 *
 * - If `currentFieldKey` is set, the inbound text is treated as that field's
 *   answer: validated, and on success merged into `collected`; on failure the
 *   same field is re-asked with the rejection reason.
 * - Then the next unanswered field (required-first) is chosen. If none remain,
 *   the step is 'complete'.
 *
 * Pure: returns the updated answers + the next step; performs no I/O.
 */
export function advance(
  flow: IntakeFlow,
  collected: CollectedAnswers,
  currentFieldKey: string | null,
  inboundText: string,
): { collected: CollectedAnswers; step: IntakeStep } {
  let next: CollectedAnswers = { ...collected };

  if (currentFieldKey) {
    const field = flow.fields.find((f) => f.key === currentFieldKey);
    if (field) {
      const parsed = parseAnswer(field, inboundText);
      if (!parsed.ok) {
        // Re-ask the SAME field with the reason prepended.
        return {
          collected: next,
          step: { kind: 'ask', fieldKey: field.key, prompt: `${parsed.reason}\n\n${field.prompt}`, reAsk: true },
        };
      }
      next = { ...next, [field.key]: parsed.value };
    }
  }

  const upcoming = nextField(flow, next);
  if (!upcoming) {
    return { collected: next, step: { kind: 'complete' } };
  }
  return { collected: next, step: { kind: 'ask', fieldKey: upcoming.key, prompt: upcoming.prompt } };
}

/** The very first step for a fresh conversation: greeting + the first question. */
export function firstStep(flow: IntakeFlow, collected: CollectedAnswers = {}): IntakeStep {
  const upcoming = nextField(flow, collected);
  if (!upcoming) return { kind: 'complete' };
  return { kind: 'ask', fieldKey: upcoming.key, prompt: upcoming.prompt };
}
