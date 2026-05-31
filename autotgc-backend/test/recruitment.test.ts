import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';
import type { AuthInfo } from '../src/http/authMiddleware';
import {
  candidateTransition,
  ALLOWED_TRANSITIONS,
  CANDIDATE_STAGES,
  TERMINAL_STAGES,
} from '../src/recruitment/candidateStateMachine';
import type { CandidateStage } from '../src/recruitment/candidateStateMachine';
import {
  isRecruitmentMarket,
  isVisaType,
  isJobOrderStatus,
  isCandidateStage,
  blank,
  RECRUITMENT_MARKETS,
  VISA_TYPES,
  JOB_ORDER_STATUSES,
  CANDIDATE_STAGE_VALUES,
} from '../src/recruitment/validation';
import { CandidateService } from '../src/recruitment/candidateService';

// ---- Test doubles -----------------------------------------------------------

const ADMIN: AuthInfo = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sess-1' };

/** Minimal Prisma fake for CandidateService.create validation. */
function fakeCreatePrisma(): { prisma: PrismaClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    candidateProfile: {
      findMany: async () => [],
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'cand-1', ...args.data };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, created };
}

/**
 * Prisma fake for promoteFromLead with a configurable stored lead and an
 * optional pre-existing candidate (to exercise the conflict path).
 */
function fakePromotePrisma(
  lead: { leadId: string; name: string | null; phone: string | null; email: string | null; source: string; assignedTo: string | null } | null,
  existingCandidate: { id: string } | null,
): { prisma: PrismaClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    lead: {
      findUnique: async () => lead,
    },
    candidateProfile: {
      findUnique: async () => existingCandidate,
      findMany: async () => [],
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'cand-1', ...args.data };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, created };
}

// ---- State machine property -------------------------------------------------

describe('recruitment candidate state machine', () => {
  // Feature: recruitment-crm, Property 1: candidate stage transition closure
  it('Property 1: candidateTransition succeeds iff pair is allowed, else 409; terminals never source', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CANDIDATE_STAGES),
        fc.constantFrom(...CANDIDATE_STAGES),
        (a: CandidateStage, b: CandidateStage) => {
          const r = candidateTransition(a, b);
          const allowed = ALLOWED_TRANSITIONS.some(([x, y]) => x === a && y === b);
          expect(r.ok).toBe(allowed);
          if (!r.ok) {
            expect(r.status).toBe(409);
          } else {
            expect(r.status).toBe(b);
          }
          // Terminal stages are never a valid source.
          if (TERMINAL_STAGES.includes(a)) {
            expect(r.ok).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('forward lifecycle + re-work edges are accepted', () => {
    expect(candidateTransition('NEW', 'CONSULTING').ok).toBe(true);
    expect(candidateTransition('CONSULTING', 'PROFILE_COLLECTED').ok).toBe(true);
    expect(candidateTransition('PROFILE_COLLECTED', 'MATCHED').ok).toBe(true);
    expect(candidateTransition('MATCHED', 'INTERVIEW_SCHEDULED').ok).toBe(true);
    expect(candidateTransition('INTERVIEW_SCHEDULED', 'INTERVIEW_PASSED').ok).toBe(true);
    expect(candidateTransition('INTERVIEW_PASSED', 'COE_VISA').ok).toBe(true);
    expect(candidateTransition('COE_VISA', 'DEPARTED').ok).toBe(true);
    // re-work edges
    expect(candidateTransition('MATCHED', 'CONSULTING').ok).toBe(true);
    expect(candidateTransition('INTERVIEW_SCHEDULED', 'MATCHED').ok).toBe(true);
    // any non-terminal -> WITHDRAWN / REJECTED
    expect(candidateTransition('NEW', 'WITHDRAWN').ok).toBe(true);
    expect(candidateTransition('COE_VISA', 'REJECTED').ok).toBe(true);
    // skipping ahead is rejected
    expect(candidateTransition('NEW', 'MATCHED').ok).toBe(false);
    expect(candidateTransition('NEW', 'MATCHED').status).toBe(409);
  });
});

// ---- Enum validation property -----------------------------------------------

describe('recruitment validation helpers', () => {
  // Feature: recruitment-crm, Property 2: enum membership helpers
  it('Property 2: enum helpers accept iff the value is a member of the canonical set', () => {
    const known = [
      ...RECRUITMENT_MARKETS,
      ...VISA_TYPES,
      ...JOB_ORDER_STATUSES,
      ...CANDIDATE_STAGE_VALUES,
    ];
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(...known),
          fc.string(),
          fc.constantFrom('japan', 'tokutei', 'open', 'new', '', 'BOGUS'),
        ),
        (v) => {
          expect(isRecruitmentMarket(v)).toBe((RECRUITMENT_MARKETS as readonly string[]).includes(v));
          expect(isVisaType(v)).toBe((VISA_TYPES as readonly string[]).includes(v));
          expect(isJobOrderStatus(v)).toBe((JOB_ORDER_STATUSES as readonly string[]).includes(v));
          expect(isCandidateStage(v)).toBe((CANDIDATE_STAGE_VALUES as readonly string[]).includes(v));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 2: non-string inputs are never enum members', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (v) => {
          expect(isRecruitmentMarket(v)).toBe(false);
          expect(isVisaType(v)).toBe(false);
          expect(isJobOrderStatus(v)).toBe(false);
          expect(isCandidateStage(v)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('blank() detects empty / whitespace-only strings', () => {
    expect(blank(undefined)).toBe(true);
    expect(blank(null)).toBe(true);
    expect(blank('')).toBe(true);
    expect(blank('   ')).toBe(true);
    expect(blank('x')).toBe(false);
  });
});

// ---- CandidateService unit tests (fake Prisma) ------------------------------

describe('CandidateService.create validation', () => {
  it('rejects a blank fullName', async () => {
    const { prisma, created } = fakeCreatePrisma();
    const service = new CandidateService(prisma);
    await expect(
      service.create({ fullName: '   ', phone: '0900000000' }, ADMIN),
    ).rejects.toMatchObject({ status: 400, code: 'FULL_NAME_REQUIRED' });
    expect(created).toHaveLength(0);
  });

  it('rejects when neither phone nor email is supplied', async () => {
    const { prisma, created } = fakeCreatePrisma();
    const service = new CandidateService(prisma);
    await expect(
      service.create({ fullName: 'Nguyen Van A' }, ADMIN),
    ).rejects.toMatchObject({ status: 400, code: 'CONTACT_REQUIRED' });
    expect(created).toHaveLength(0);
  });

  it('rejects an invalid desiredMarket enum', async () => {
    const { prisma } = fakeCreatePrisma();
    const service = new CandidateService(prisma);
    await expect(
      service.create({ fullName: 'A', phone: '09', desiredMarket: 'MARS' }, ADMIN),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_DESIRED_MARKET' });
  });

  it('creates a NEW-stage candidate with a phone contact', async () => {
    const { prisma, created } = fakeCreatePrisma();
    const service = new CandidateService(prisma);
    const candidate = await service.create(
      { fullName: 'Nguyen Van A', phone: '0900000000', desiredMarket: 'JAPAN', desiredVisaType: 'TOKUTEI' },
      ADMIN,
    );
    expect(candidate).toBeTruthy();
    expect(created).toHaveLength(1);
    expect(created[0].stage).toBe('NEW');
    expect(created[0].fullName).toBe('Nguyen Van A');
  });
});

describe('CandidateService.promoteFromLead', () => {
  const lead = {
    leadId: 'lead-1',
    name: 'Tran Thi B',
    phone: '0911111111',
    email: 'b@example.com',
    source: 'facebook_leadgen',
    assignedTo: 'sales-1',
  };

  it('promotes a lead into a NEW candidate carrying name/phone/email/source', async () => {
    const { prisma, created } = fakePromotePrisma(lead, null);
    const service = new CandidateService(prisma);
    const candidate = await service.promoteFromLead('lead-1', {}, ADMIN);
    expect(candidate).toBeTruthy();
    expect(created).toHaveLength(1);
    expect(created[0].leadId).toBe('lead-1');
    expect(created[0].fullName).toBe('Tran Thi B');
    expect(created[0].phone).toBe('0911111111');
    expect(created[0].email).toBe('b@example.com');
    expect(created[0].source).toBe('facebook_leadgen');
    expect(created[0].stage).toBe('NEW');
  });

  it('returns 404 when the lead does not exist', async () => {
    const { prisma } = fakePromotePrisma(null, null);
    const service = new CandidateService(prisma);
    await expect(service.promoteFromLead('missing', {}, ADMIN)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('returns 409 when a candidate already exists for that lead', async () => {
    const { prisma, created } = fakePromotePrisma(lead, { id: 'existing-cand' });
    const service = new CandidateService(prisma);
    await expect(service.promoteFromLead('lead-1', {}, ADMIN)).rejects.toMatchObject({
      status: 409,
      code: 'CANDIDATE_ALREADY_EXISTS',
    });
    expect(created).toHaveLength(0);
  });
});
