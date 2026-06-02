/**
 * FollowUp_Engine — pure behavior-based nurture logic. Framework-free +
 * deterministic so it is property-testable; the service/agent does the Prisma
 * reads/writes and channel sending.
 *
 * `isDropOff` decides whether a conversation has gone quiet long enough to
 * warrant a nudge. `buildFollowUpMessage` composes a personalized Vietnamese
 * message grounded ONLY in known facts (name + last topic) — it invents no
 * deadlines or claims.
 */

export interface DropOffInput {
  status: string; // IntakeConversation.status
  lastInboundAt: Date | null;
  /** Whether a follow-up is already pending/sent for this conversation. */
  hasOpenFollowUp: boolean;
}

/** Days of silence after the last inbound before a follow-up is due. */
export const DROP_OFF_DAYS = 3;

/**
 * True when a conversation is a drop-off candidate: it is still ACTIVE (not
 * completed/handed-off/abandoned), the contact has been silent for >= the
 * threshold, and there is no open follow-up already queued.
 */
export function isDropOff(input: DropOffInput, now: Date, thresholdDays = DROP_OFF_DAYS): boolean {
  if (input.status !== 'ACTIVE') return false;
  if (input.hasOpenFollowUp) return false;
  if (!input.lastInboundAt) return false;
  const ageMs = now.getTime() - input.lastInboundAt.getTime();
  return ageMs >= thresholdDays * 86_400_000;
}

export interface FollowUpContext {
  /** Contact display name (falls back to a neutral greeting). */
  name?: string | null;
  /** Last-known interest/topic (e.g. "ĐH Tokyo"), if any. */
  topic?: string | null;
}

/**
 * Compose a personalized, grounded Vietnamese nurture message. It references
 * the contact's name and last topic when available, and gently offers help —
 * without fabricating specific deadlines (the consultant can add specifics).
 */
export function buildFollowUpMessage(ctx: FollowUpContext): string {
  const name = typeof ctx.name === 'string' && ctx.name.trim().length > 0 ? ctx.name.trim() : 'bạn';
  const topic = typeof ctx.topic === 'string' && ctx.topic.trim().length > 0 ? ctx.topic.trim() : '';

  if (topic) {
    return (
      `Chào ${name}, trước đó bạn có quan tâm tới "${topic}". ` +
      'Bên mình vẫn đang hỗ trợ và có thể cập nhật thông tin mới nhất cho bạn. ' +
      'Bạn đã chuẩn bị hồ sơ tới đâu rồi, cần mình hỗ trợ gì thêm không ạ?'
    );
  }
  return (
    `Chào ${name}, mình là tư vấn viên của Thanh Giang. ` +
    'Trước đó bạn có để lại thông tin quan tâm tới chương trình của bên mình. ' +
    'Bạn cần mình tư vấn thêm hay hỗ trợ chuẩn bị hồ sơ không ạ?'
  );
}
