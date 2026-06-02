/**
 * NoteAnalysisService — the background-style reader for proposal 3.3.
 *
 * Loads a lead's note + recent LeadHistoryEntry notes and runs the pure
 * `scoreNotes` heuristic to produce an intent ("độ nóng") signal and a suggested
 * next status. This service ONLY reads from Prisma and enforces the SAME SALES
 * assigned-only scoping as `LeadService.get`; all scoring logic lives in the
 * pure `noteIntentScoring` module. It never writes to the database — callers
 * decide whether to act on a suggestion (the lead status machine still guards
 * any actual transition).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../http/authMiddleware';
import { ForbiddenError, NotFoundError } from '../infra/errors';
import { scoreNotes } from './noteIntentScoring';
import type { IntentSignal } from './noteIntentScoring';
import type { LeadStatus } from './statusMachine';

/** How many recent history notes to consider (most recent first). */
const HISTORY_NOTE_LIMIT = 20;

/** Default number of leads scanned by the background `analyzeRecent` helper. */
const DEFAULT_RECENT_LIMIT = 50;

export interface LeadIntentResult {
  leadId: string;
  signal: IntentSignal;
}

export class NoteAnalysisService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Analyze a single lead's notes. 404 when missing; SALES may only analyze a
   * lead assigned to them (else 403), mirroring LeadService.get. Read-only.
   */
  async analyzeLead(leadId: string, actor: AuthInfo): Promise<IntentSignal> {
    const lead = await this.prisma.lead.findUnique({
      where: { leadId },
      select: { leadId: true, status: true, note: true, assignedTo: true },
    });
    if (!lead) {
      throw new NotFoundError('Lead not found', 'LEAD_NOT_FOUND');
    }
    if (actor.role === 'SALES' && lead.assignedTo !== actor.userId) {
      throw new ForbiddenError();
    }

    const history = await this.prisma.leadHistoryEntry.findMany({
      where: { leadId },
      orderBy: { changedAt: 'desc' },
      take: HISTORY_NOTE_LIMIT,
      select: { note: true },
    });

    const notes = this.collectNotes(lead.note, history);
    return scoreNotes(notes, lead.status as LeadStatus);
  }

  /**
   * Background helper: score the most-recently-updated leads. ADMIN sees all;
   * a SALES actor (if ever passed) is scoped to its assigned leads. Read-only.
   */
  async analyzeRecent(limit = DEFAULT_RECENT_LIMIT, actor?: AuthInfo): Promise<LeadIntentResult[]> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : DEFAULT_RECENT_LIMIT;

    const where: Prisma.LeadWhereInput = {};
    if (actor?.role === 'SALES') {
      where.assignedTo = actor.userId;
    }

    const leads = await this.prisma.lead.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: safeLimit,
      select: { leadId: true, status: true, note: true },
    });

    const results: LeadIntentResult[] = [];
    for (const lead of leads) {
      const history = await this.prisma.leadHistoryEntry.findMany({
        where: { leadId: lead.leadId },
        orderBy: { changedAt: 'desc' },
        take: HISTORY_NOTE_LIMIT,
        select: { note: true },
      });
      const notes = this.collectNotes(lead.note, history);
      results.push({ leadId: lead.leadId, signal: scoreNotes(notes, lead.status as LeadStatus) });
    }
    return results;
  }

  /** Merge the lead's own note with recent history notes into a string list. */
  private collectNotes(
    leadNote: string | null,
    history: Array<{ note: string | null }>,
  ): string[] {
    const notes: string[] = [];
    if (typeof leadNote === 'string' && leadNote.trim().length > 0) notes.push(leadNote);
    for (const h of history) {
      if (typeof h.note === 'string' && h.note.trim().length > 0) notes.push(h.note);
    }
    return notes;
  }
}
