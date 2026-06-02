/**
 * Integration tests for oversight hook consistency (Requirements 7.1, 7.2, 7.3,
 * 7.5, 8.2).
 *
 * Each business service (Document/Candidate/Lead) accepts an OPTIONAL
 * OversightService as its last constructor arg and funnels supervised
 * Important_Action events through `oversight.record(...)` AFTER the business
 * action commits. These tests inject a FAKE OversightService that records every
 * `record()` call, drive each service over an in-memory Prisma fake, and assert:
 *
 *   - a successful Important_Action fires `record` EXACTLY once with matching
 *     actorUserId / targetType / targetId (Req 7.1, 7.2, 7.3);
 *   - an action that does not qualify, or is rejected/throws, fires NO `record`
 *     call (Req 7.5).
 *
 * The state machines are exercised for real (legal vs illegal transitions are
 * picked from `candidateStateMachine` / `statusMachine`), not mocked.
 *
 * Finally, Req 8.2 is checked directly: with a REAL NotificationService backed by
 * a fake EventBus and a real OversightService stack, one `record()` results in
 * exactly one `publish` on the `notification` topic.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../src/http/authMiddleware';
import type { DomainEvent, EventBus } from '../src/infra/events';
import type { OversightService, ImportantAction } from '../src/oversight/oversightService';
import { DocumentChecklistService } from '../src/recruitment/documents/documentChecklistService';
import { CandidateService } from '../src/recruitment/candidateService';
import { LeadService } from '../src/leads/leadService';
import { ActivityLogger } from '../src/oversight/activityLogger';
import { NotificationService } from '../src/oversight/notificationService';
import { OversightService as RealOversightService } from '../src/oversight/oversightService';

const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sess-1' };

/**
 * A fake OversightService that simply records every `record()` invocation. Cast
 * to OversightService where injected — the services only ever call `.record`.
 */
class RecordingOversight {
  readonly calls: ImportantAction[] = [];
  async record(action: ImportantAction): Promise<void> {
    this.calls.push(action);
  }
}

function recordingOversight(): { fake: RecordingOversight; injected: OversightService } {
  const fake = new RecordingOversight();
  return { fake, injected: fake as unknown as OversightService };
}

// ---------------------------------------------------------------------------
// Document: updateStatus -> VERIFIED fires DOCUMENT_VERIFIED exactly once.
// ---------------------------------------------------------------------------

interface DocRow {
  id: string;
  candidateId: string;
  type: string;
  status: string;
  submittedAt: Date | null;
}

/** In-memory Prisma fake for the single DocumentChecklistItem the test touches. */
function fakeDocPrisma(seed: DocRow): { prisma: PrismaClient; row: DocRow } {
  const row = { ...seed };
  const prisma = {
    documentChecklistItem: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === row.id ? { ...row } : null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (args.data.status !== undefined) row.status = String(args.data.status);
        if (args.data.submittedAt !== undefined) row.submittedAt = args.data.submittedAt as Date;
        return { ...row };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, row };
}

describe('DocumentChecklistService oversight hook (Req 7.1, 7.5)', () => {
  it("fires record once with DOCUMENT_VERIFIED on updateStatus -> 'VERIFIED'", async () => {
    const { prisma } = fakeDocPrisma({
      id: 'doc-1',
      candidateId: 'cand-1',
      type: 'PASSPORT',
      status: 'SUBMITTED',
      submittedAt: null,
    });
    const { fake, injected } = recordingOversight();
    const service = new DocumentChecklistService(prisma, injected);

    const updated = await service.updateStatus('doc-1', 'VERIFIED', ADMIN);

    expect(updated.status).toBe('VERIFIED');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.action).toBe('DOCUMENT_VERIFIED');
    expect(call.actorUserId).toBe(ADMIN.userId);
    expect(call.targetType).toBe('document');
    expect(call.targetId).toBe('doc-1');
  });

  it("does NOT fire record when transitioning to a non-verified status ('SUBMITTED') (Req 7.5)", async () => {
    const { prisma } = fakeDocPrisma({
      id: 'doc-2',
      candidateId: 'cand-1',
      type: 'PASSPORT',
      status: 'PENDING',
      submittedAt: null,
    });
    const { fake, injected } = recordingOversight();
    const service = new DocumentChecklistService(prisma, injected);

    const updated = await service.updateStatus('doc-2', 'SUBMITTED', ADMIN);

    expect(updated.status).toBe('SUBMITTED');
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Candidate: legal stage change fires CANDIDATE_STAGE_CHANGED exactly once;
// an illegal transition throws and fires nothing.
// ---------------------------------------------------------------------------

interface CandRow {
  id: string;
  stage: string;
  assignedTo: string | null;
  desiredMarket: string | null;
}

/** In-memory Prisma fake for CandidateProfile + CandidateStageHistory. */
function fakeCandPrisma(seed: CandRow): { prisma: PrismaClient; historyCount: () => number } {
  const row = { ...seed };
  const history: unknown[] = [];
  const prisma = {
    candidateProfile: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === row.id ? { ...row } : null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (args.data.stage !== undefined) row.stage = String(args.data.stage);
        return { ...row };
      },
    },
    candidateStageHistory: {
      create: async (args: { data: unknown }) => {
        history.push(args.data);
        return args.data;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, historyCount: () => history.length };
}

describe('CandidateService oversight hook (Req 7.2, 7.5)', () => {
  it('fires record once with CANDIDATE_STAGE_CHANGED on a legal stage change', async () => {
    // NEW -> CONSULTING is a legal forward transition.
    const { prisma } = fakeCandPrisma({
      id: 'cand-1',
      stage: 'NEW',
      assignedTo: null,
      desiredMarket: 'JAPAN',
    });
    const { fake, injected } = recordingOversight();
    const service = new CandidateService(prisma, undefined, injected);

    const updated = await service.update('cand-1', { stage: 'CONSULTING' }, ADMIN);

    expect(updated.stage).toBe('CONSULTING');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.action).toBe('CANDIDATE_STAGE_CHANGED');
    expect(call.actorUserId).toBe(ADMIN.userId);
    expect(call.targetType).toBe('candidate');
    expect(call.targetId).toBe('cand-1');
    expect(call.detail).toMatchObject({ previousStage: 'NEW', newStage: 'CONSULTING' });
  });

  it('does NOT fire record when an illegal transition throws (Req 7.5)', async () => {
    // NEW -> MATCHED is not an allowed edge; update() throws a 409 ConflictError.
    const { prisma } = fakeCandPrisma({
      id: 'cand-2',
      stage: 'NEW',
      assignedTo: null,
      desiredMarket: 'JAPAN',
    });
    const { fake, injected } = recordingOversight();
    const service = new CandidateService(prisma, undefined, injected);

    const err = await service.update('cand-2', { stage: 'MATCHED' }, ADMIN).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: number }).status).toBe(409);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lead: transition to QUALIFIED/CONVERTED fires LEAD_STATUS_CHANGED once; a
// legal but non-qualifying transition fires nothing.
// ---------------------------------------------------------------------------

interface LeadRow {
  leadId: string;
  status: string;
  assignedTo: string | null;
  source: string;
}

/** In-memory Prisma fake for Lead + LeadHistoryEntry. */
function fakeLeadPrisma(seed: LeadRow): { prisma: PrismaClient } {
  const row = { ...seed };
  const prisma = {
    lead: {
      findUnique: async (args: { where: { leadId: string } }) =>
        args.where.leadId === row.leadId ? { ...row } : null,
      update: async (args: { where: { leadId: string }; data: Record<string, unknown> }) => {
        if (args.data.status !== undefined) row.status = String(args.data.status);
        return { ...row };
      },
    },
    leadHistoryEntry: {
      create: async (args: { data: unknown }) => args.data,
    },
  } as unknown as PrismaClient;
  return { prisma };
}

describe('LeadService oversight hook (Req 7.3, 7.5)', () => {
  it('fires record once with LEAD_STATUS_CHANGED when transitioning to QUALIFIED', async () => {
    // CONTACTED -> QUALIFIED is a legal, qualifying transition.
    const { prisma } = fakeLeadPrisma({
      leadId: 'lead-1',
      status: 'CONTACTED',
      assignedTo: null,
      source: 'web',
    });
    const { fake, injected } = recordingOversight();
    const service = new LeadService(prisma, undefined, injected);

    const updated = await service.update('lead-1', { status: 'QUALIFIED' }, ADMIN);

    expect(updated.status).toBe('QUALIFIED');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.action).toBe('LEAD_STATUS_CHANGED');
    expect(call.actorUserId).toBe(ADMIN.userId);
    expect(call.targetType).toBe('lead');
    expect(call.targetId).toBe('lead-1');
    expect(call.detail).toMatchObject({ previousStatus: 'CONTACTED', newStatus: 'QUALIFIED' });
  });

  it('fires record once with LEAD_STATUS_CHANGED when transitioning to CONVERTED', async () => {
    // QUALIFIED -> CONVERTED is a legal, qualifying transition.
    const { prisma } = fakeLeadPrisma({
      leadId: 'lead-2',
      status: 'QUALIFIED',
      assignedTo: null,
      source: 'web',
    });
    const { fake, injected } = recordingOversight();
    const service = new LeadService(prisma, undefined, injected);

    const updated = await service.update('lead-2', { status: 'CONVERTED' }, ADMIN);

    expect(updated.status).toBe('CONVERTED');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].action).toBe('LEAD_STATUS_CHANGED');
    expect(fake.calls[0].targetId).toBe('lead-2');
  });

  it('does NOT fire record for a legal but non-qualifying transition (NEW -> CONTACTED) (Req 7.5)', async () => {
    const { prisma } = fakeLeadPrisma({
      leadId: 'lead-3',
      status: 'NEW',
      assignedTo: null,
      source: 'web',
    });
    const { fake, injected } = recordingOversight();
    const service = new LeadService(prisma, undefined, injected);

    const updated = await service.update('lead-3', { status: 'CONTACTED' }, ADMIN);

    expect(updated.status).toBe('CONTACTED');
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Req 8.2: a record() through the REAL oversight stack publishes exactly one
// 'notification' event via the (fake) EventBus.
// ---------------------------------------------------------------------------

/** A fake EventBus that captures every published event. */
class CapturingEventBus implements EventBus {
  readonly published: Array<Omit<DomainEvent, 'at'>> = [];
  async publish(event: Omit<DomainEvent, 'at'>): Promise<void> {
    this.published.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

/** In-memory Prisma fake for the real oversight stack: ADMIN lookup + writes. */
function fakeOversightPrisma(admins: Array<{ id: string; role: 'ADMIN' | 'SALES' }>): {
  prisma: PrismaClient;
  notificationCount: () => number;
  activityCount: () => number;
} {
  const notifications: unknown[] = [];
  const activity: unknown[] = [];
  const prisma = {
    activityLog: {
      create: async (args: { data: unknown }) => {
        activity.push(args.data);
        return { id: `act-${activity.length}`, ...(args.data as object), createdAt: new Date() };
      },
    },
    userAccount: {
      findMany: async (args: { where?: { role?: string } }) =>
        admins.filter((u) => (args.where?.role ? u.role === args.where.role : true)),
    },
    notification: {
      createMany: async (args: { data: unknown[] }) => {
        notifications.push(...args.data);
        return { count: args.data.length };
      },
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    notificationCount: () => notifications.length,
    activityCount: () => activity.length,
  };
}

describe('OversightService.record realtime publish (Req 8.2)', () => {
  it('publishes exactly one event on the notification topic per record()', async () => {
    const { prisma, notificationCount, activityCount } = fakeOversightPrisma([
      { id: 'admin-1', role: 'ADMIN' },
      { id: 'admin-2', role: 'ADMIN' },
      { id: 'sales-1', role: 'SALES' },
    ]);
    const bus = new CapturingEventBus();
    const activityLogger = new ActivityLogger(prisma);
    const notifications = new NotificationService(prisma, bus);
    const oversight = new RealOversightService(prisma, activityLogger, notifications);

    await oversight.record({
      actorUserId: 'sales-1',
      action: 'DOCUMENT_VERIFIED',
      targetType: 'document',
      targetId: 'doc-1',
      detail: { candidateId: 'cand-1' },
    });

    // Exactly one realtime publish, on the 'notification' topic.
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].topic).toBe('notification');

    // One ActivityLog and one Notification per distinct ADMIN (2), none for SALES.
    expect(activityCount()).toBe(1);
    expect(notificationCount()).toBe(2);
  });
});
