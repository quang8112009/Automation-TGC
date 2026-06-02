/**
 * Oversight domain — action & notification kinds.
 *
 * The string-literal union types that identify the kinds of supervised
 * Important_Action events the oversight layer records, and the kind of
 * Notification fanned out to ADMIN recipients (Req 2.1, 8.3). Framework-free.
 */

/** Supervised Important_Action kinds recorded by the oversight layer (Req 2.1). */
export type ActivityAction = 'DOCUMENT_VERIFIED' | 'CANDIDATE_STAGE_CHANGED' | 'LEAD_STATUS_CHANGED';

/** Notification kind fanned out to ADMIN recipients (Req 8.3). */
export type NotificationKind = 'ACTIVITY';
