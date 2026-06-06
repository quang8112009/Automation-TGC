/**
 * Unit tests for the privacy services that previously had NO direct coverage:
 *
 *  - RetentionPurgeService.purge — boundary timing of the retention cutoff
 *    (records exactly AT the cutoff are retained; only strictly-older rows are
 *    deleted/anonymized/redacted) and the COUNTS-ONLY summary it returns.
 *  - ErasureService.erase — 404 for a missing subject of every subject type,
 *    validation (400) for an unknown subjectType / empty subjectId, and the
 *    counts-only summary + Prisma.DbNull raw-redaction on success.
 *
 * Both are exercised against faithful in-memory Prisma fakes that actually apply
 * the `lt` / OR / NOT predicates, so the boundary assertions are meaningful.
 * No network, no real Prisma — fully deterministic.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import {
  RetentionPurgeService,
  DEFAULT_RETENTION_CONFIG,
} from '../src/privacy/retentionPurgeService';
import { ErasureService } from '../src/privacy/erasureService';
import { NotFoundError, ValidationError } from '../src/infra/errors';

// ---------------------------------------------------------------------------
// Helpers: month arithmetic mirrors retentionCutoff (setMonth(-months)).
// ---------------------------------------------------------------------------
const NOW = new Date(Date.UTC(2025, 5, 15, 12, 0, 0)); // 2025-06-15T12:00:00Z

/** A date exactly `months` before NOW (the inclusive retention boundary). */
function monthsBefore(months: number): Date {
  const d = new Date(NOW.getTime());
  d.setMonth(d.getMonth() - months);
  return d;
}

// ===========================================================================
// RetentionPurgeService.purge — boundary + counts
// ===========================================================================

interface PurgeStore {
  analyticsRecord: Array<{ collectedAt: Date }>;
  performanceRecord: Array<{ scoredAt: Date }>;
  lead: Array<{ createdAt: Date; name: string | null; phone: string | null; email: string | null; note: string | null }>;
  intakeConversation: Array<{ createdAt: Date; displayName: string | null; collected: unknown }>;
  intakeMessage: Array<{ createdAt: Date; text: string; raw: unknown }>;
  auditEntry: Array<{ recordedAt: Date; detail: unknown }>;
  activityLog: Array<{ createdAt: Date; detail: unknown }>;
}

const ERASED = '[EXPIRED]';

function purgePrisma(store: PurgeStore): PrismaClient {
  return {
    analyticsRecord: {
      deleteMany: async (args: { where: { collectedAt: { lt: Date } } }) => {
        const lt = args.where.collectedAt.lt.getTime();
        const before = store.analyticsRecord.length;
        store.analyticsRecord = store.analyticsRecord.filter((r) => !(r.collectedAt.getTime() < lt));
        return { count: before - store.analyticsRecord.length };
      },
    },
    performanceRecord: {
      deleteMany: async (args: { where: { scoredAt: { lt: Date } } }) => {
        const lt = args.where.scoredAt.lt.getTime();
        const before = store.performanceRecord.length;
        store.performanceRecord = store.performanceRecord.filter((r) => !(r.scoredAt.getTime() < lt));
        return { count: before - store.performanceRecord.length };
      },
    },
    lead: {
      updateMany: async (args: {
        where: { createdAt: { lt: Date } };
        data: Record<string, unknown>;
      }) => {
        const lt = args.where.createdAt.lt.getTime();
        let count = 0;
        for (const r of store.lead) {
          const carriesPii = r.name !== null || r.phone !== null || r.email !== null;
          if (r.createdAt.getTime() < lt && carriesPii) {
            r.name = null;
            r.phone = null;
            r.email = null;
            r.note = null;
            count += 1;
          }
        }
        return { count };
      },
    },
    intakeConversation: {
      updateMany: async (args: { where: { createdAt: { lt: Date } } }) => {
        const lt = args.where.createdAt.lt.getTime();
        let count = 0;
        for (const r of store.intakeConversation) {
          if (r.createdAt.getTime() < lt && r.displayName !== null) {
            r.displayName = null;
            r.collected = {};
            count += 1;
          }
        }
        return { count };
      },
    },
    intakeMessage: {
      updateMany: async (args: { where: { createdAt: { lt: Date } }; data: Record<string, unknown> }) => {
        const lt = args.where.createdAt.lt.getTime();
        let count = 0;
        for (const r of store.intakeMessage) {
          if (r.createdAt.getTime() < lt && r.text !== ERASED) {
            r.text = ERASED;
            r.raw = args.data.raw;
            count += 1;
          }
        }
        return { count };
      },
    },
    auditEntry: {
      updateMany: async (args: { where: { recordedAt: { lt: Date } }; data: Record<string, unknown> }) => {
        const lt = args.where.recordedAt.lt.getTime();
        let count = 0;
        for (const r of store.auditEntry) {
          if (r.recordedAt.getTime() < lt) {
            r.detail = args.data.detail;
            count += 1;
          }
        }
        return { count };
      },
    },
    activityLog: {
      updateMany: async (args: { where: { createdAt: { lt: Date } }; data: Record<string, unknown> }) => {
        const lt = args.where.createdAt.lt.getTime();
        let count = 0;
        for (const r of store.activityLog) {
          if (r.createdAt.getTime() < lt) {
            r.detail = args.data.detail;
            count += 1;
          }
        }
        return { count };
      },
    },
  } as unknown as PrismaClient;
}

function emptyStore(): PurgeStore {
  return {
    analyticsRecord: [],
    performanceRecord: [],
    lead: [],
    intakeConversation: [],
    intakeMessage: [],
    auditEntry: [],
    activityLog: [],
  };
}

describe('RetentionPurgeService.purge — boundary timing + counts', () => {
  it('deletes analytics strictly OLDER than the cutoff, retains rows AT the boundary', async () => {
    const store = emptyStore();
    // analyticsMonths = 12 by default.
    const justInside = new Date(monthsBefore(12).getTime() + 1); // 1ms newer than cutoff -> retained
    const exactlyAtCutoff = monthsBefore(12); // == cutoff -> retained (lt is strict)
    const olderThanCutoff = new Date(monthsBefore(12).getTime() - 1); // older -> deleted
    store.analyticsRecord = [
      { collectedAt: justInside },
      { collectedAt: exactlyAtCutoff },
      { collectedAt: olderThanCutoff },
    ];
    store.performanceRecord = [
      { scoredAt: exactlyAtCutoff },
      { scoredAt: olderThanCutoff },
    ];

    const svc = new RetentionPurgeService(purgePrisma(store));
    const summary = await svc.purge(NOW);

    expect(summary.analyticsRecords).toBe(1); // only the strictly-older row
    expect(summary.performanceRecords).toBe(1);
    // The boundary + newer rows survive.
    expect(store.analyticsRecord).toHaveLength(2);
    expect(store.performanceRecord).toHaveLength(1);
  });

  it('anonymizes only PII-carrying leads older than the PII window (idempotent on already-clean rows)', async () => {
    const store = emptyStore();
    const old = new Date(monthsBefore(24).getTime() - 1000);
    store.lead = [
      { createdAt: old, name: 'A', phone: '1', email: 'a@b.co', note: 'x' }, // anonymized
      { createdAt: old, name: null, phone: null, email: null, note: null }, // already clean -> skipped
      { createdAt: monthsBefore(24), name: 'AT', phone: null, email: null, note: null }, // AT boundary -> retained
    ];

    const svc = new RetentionPurgeService(purgePrisma(store));
    const summary = await svc.purge(NOW);

    expect(summary.leadsAnonymized).toBe(1);
    expect(store.lead[0].name).toBeNull();
    expect(store.lead[0].email).toBeNull();
    // The boundary lead keeps its PII (lt is strict).
    expect(store.lead[2].name).toBe('AT');
  });

  it('redacts intake message raw with Prisma.DbNull and is a no-op on already-redacted rows', async () => {
    const store = emptyStore();
    const old = new Date(monthsBefore(24).getTime() - 1000);
    store.intakeMessage = [
      { createdAt: old, text: 'hello', raw: { foo: 'bar' } },
      { createdAt: old, text: ERASED, raw: Prisma.DbNull }, // already redacted -> skipped
    ];
    store.intakeConversation = [
      { createdAt: old, displayName: 'Nguyen', collected: { a: 1 } },
    ];

    const svc = new RetentionPurgeService(purgePrisma(store));
    const summary = await svc.purge(NOW);

    expect(summary.intakeMessagesRedacted).toBe(1);
    expect(summary.intakeConversationsAnonymized).toBe(1);
    expect(store.intakeMessage[0].text).toBe(ERASED);
    expect(store.intakeMessage[0].raw).toBe(Prisma.DbNull);
    expect(store.intakeConversation[0].displayName).toBeNull();
  });

  it('redacts audit/activity log detail older than the log window', async () => {
    const store = emptyStore();
    const old = new Date(monthsBefore(24).getTime() - 1000);
    store.auditEntry = [
      { recordedAt: old, detail: { pii: 'secret' } },
      { recordedAt: monthsBefore(24), detail: { keep: true } }, // boundary -> retained
    ];
    store.activityLog = [{ createdAt: old, detail: { pii: 'secret' } }];

    const svc = new RetentionPurgeService(purgePrisma(store));
    const summary = await svc.purge(NOW);

    expect(summary.auditEntriesRedacted).toBe(1);
    expect(summary.activityLogsRedacted).toBe(1);
    expect(store.auditEntry[0].detail).toEqual({ redacted: true });
    expect(store.auditEntry[1].detail).toEqual({ keep: true });
  });

  it('an empty database yields an all-zero summary (cheap no-op)', async () => {
    const svc = new RetentionPurgeService(purgePrisma(emptyStore()), DEFAULT_RETENTION_CONFIG);
    const summary = await svc.purge(NOW);
    expect(summary).toEqual({
      analyticsRecords: 0,
      performanceRecords: 0,
      leadsAnonymized: 0,
      intakeConversationsAnonymized: 0,
      intakeMessagesRedacted: 0,
      auditEntriesRedacted: 0,
      activityLogsRedacted: 0,
    });
  });
});

// ===========================================================================
// ErasureService.erase — 404, validation, counts-only summary, raw redaction
// ===========================================================================

interface ErasureStore {
  lead: Map<string, { leadId: string; name: string | null; phone: string | null; email: string | null; note: string | null }>;
  leadHistory: Array<{ leadId: string; note: string | null }>;
  intakeConversation: Map<string, { id: string; displayName: string | null; collected: unknown }>;
  intakeMessage: Array<{ conversationId: string; text: string; raw: unknown }>;
  candidate: Map<string, { id: string; fullName: string; phone: string | null; email: string | null; note: string | null }>;
  erasureRequests: Array<Record<string, unknown>>;
}

function erasurePrisma(store: ErasureStore): PrismaClient {
  let seq = 0;
  return {
    lead: {
      findUnique: async (args: { where: { leadId: string } }) =>
        store.lead.get(args.where.leadId) ?? null,
      update: async (args: { where: { leadId: string }; data: Record<string, unknown> }) => {
        const row = store.lead.get(args.where.leadId)!;
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    leadHistoryEntry: {
      updateMany: async (args: { where: { leadId: string }; data: { note: string } }) => {
        let count = 0;
        for (const h of store.leadHistory) {
          if (h.leadId === args.where.leadId && h.note !== null) {
            h.note = args.data.note;
            count += 1;
          }
        }
        return { count };
      },
    },
    intakeConversation: {
      findUnique: async (args: { where: { id: string } }) =>
        store.intakeConversation.get(args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.intakeConversation.get(args.where.id)!;
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    intakeMessage: {
      updateMany: async (args: { where: { conversationId: string }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const m of store.intakeMessage) {
          if (m.conversationId === args.where.conversationId) {
            m.text = args.data.text as string;
            m.raw = args.data.raw;
            count += 1;
          }
        }
        return { count };
      },
    },
    candidateProfile: {
      findUnique: async (args: { where: { id: string } }) =>
        store.candidate.get(args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.candidate.get(args.where.id)!;
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    erasureRequest: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `er-${(seq += 1)}`, ...args.data };
        store.erasureRequests.push(row);
        return row;
      },
    },
  } as unknown as PrismaClient;
}

function emptyErasureStore(): ErasureStore {
  return {
    lead: new Map(),
    leadHistory: [],
    intakeConversation: new Map(),
    intakeMessage: [],
    candidate: new Map(),
    erasureRequests: [],
  };
}

describe('ErasureService.erase — validation + 404 + counts-only', () => {
  it('rejects an unknown subjectType with 400 ERASURE_SUBJECT_TYPE_INVALID', async () => {
    const svc = new ErasureService(erasurePrisma(emptyErasureStore()));
    await expect(
      svc.erase({ subjectType: 'ACCOUNT', subjectId: 'x', requestedBy: 'admin' }),
    ).rejects.toMatchObject({ status: 400, code: 'ERASURE_SUBJECT_TYPE_INVALID' });
  });

  it('rejects an empty subjectId with 400 ERASURE_SUBJECT_REQUIRED', async () => {
    const svc = new ErasureService(erasurePrisma(emptyErasureStore()));
    await expect(
      svc.erase({ subjectType: 'LEAD', subjectId: '   ', requestedBy: 'admin' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ['LEAD', 'LEAD_NOT_FOUND'],
    ['INTAKE', 'INTAKE_NOT_FOUND'],
    ['CANDIDATE', 'CANDIDATE_NOT_FOUND'],
  ])('404s when a %s subject does not exist (code %s) and records nothing', async (subjectType, code) => {
    const store = emptyErasureStore();
    const svc = new ErasureService(erasurePrisma(store));
    let err: unknown;
    try {
      await svc.erase({ subjectType, subjectId: 'missing-id', requestedBy: 'admin' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).status).toBe(404);
    expect((err as NotFoundError).code).toBe(code);
    // No ErasureRequest is created when the subject is missing.
    expect(store.erasureRequests).toHaveLength(0);
  });

  it('erases a LEAD: clears PII, redacts history notes, returns counts only, records the request', async () => {
    const store = emptyErasureStore();
    store.lead.set('lead-1', { leadId: 'lead-1', name: 'A', phone: '1', email: 'a@b.co', note: 'x' });
    store.leadHistory = [
      { leadId: 'lead-1', note: 'sensitive' },
      { leadId: 'lead-1', note: null }, // already clean -> not counted
      { leadId: 'lead-2', note: 'other' }, // different lead -> untouched
    ];
    const svc = new ErasureService(erasurePrisma(store));

    const result = await svc.erase({ subjectType: 'LEAD', subjectId: 'lead-1', requestedBy: 'admin', reason: 'gdpr' });

    expect(result.status).toBe('COMPLETED');
    expect(result.erasedSummary).toEqual({ lead: 1, leadHistoryNotes: 1 });
    expect(store.lead.get('lead-1')).toMatchObject({ name: null, phone: null, email: null, note: null });
    // The summary contains only counts (numbers), never PII values.
    for (const v of Object.values(result.erasedSummary)) expect(typeof v).toBe('number');
    expect(store.erasureRequests).toHaveLength(1);
    expect(store.erasureRequests[0]).toMatchObject({ subjectType: 'LEAD', subjectId: 'lead-1', status: 'COMPLETED' });
  });

  it('erases an INTAKE conversation: redacts message bodies with Prisma.DbNull raw', async () => {
    const store = emptyErasureStore();
    store.intakeConversation.set('c-1', { id: 'c-1', displayName: 'Nguyen', collected: { a: 1 } });
    store.intakeMessage = [
      { conversationId: 'c-1', text: 'hi', raw: { foo: 1 } },
      { conversationId: 'c-1', text: 'there', raw: { bar: 2 } },
    ];
    const svc = new ErasureService(erasurePrisma(store));

    const result = await svc.erase({ subjectType: 'INTAKE', subjectId: 'c-1', requestedBy: 'admin' });

    expect(result.erasedSummary).toEqual({ conversation: 1, messages: 2 });
    expect(store.intakeConversation.get('c-1')).toMatchObject({ displayName: null, collected: {} });
    expect(store.intakeMessage.every((m) => m.text === '[ERASED]')).toBe(true);
    expect(store.intakeMessage.every((m) => m.raw === Prisma.DbNull)).toBe(true);
  });

  it('erases a CANDIDATE: clears contact fields, sets sentinel fullName', async () => {
    const store = emptyErasureStore();
    store.candidate.set('cand-1', { id: 'cand-1', fullName: 'Tran', phone: '9', email: 'c@d.co', note: 'n' });
    const svc = new ErasureService(erasurePrisma(store));

    const result = await svc.erase({ subjectType: 'CANDIDATE', subjectId: 'cand-1', requestedBy: 'admin' });

    expect(result.erasedSummary).toEqual({ candidate: 1 });
    expect(store.candidate.get('cand-1')).toMatchObject({ fullName: '[ERASED]', phone: null, email: null, note: null });
  });
});
