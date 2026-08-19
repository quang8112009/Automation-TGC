/**
 * DSAR (Data Subject Access Request) — tests.
 *
 * Tests the GDPR Article 15 compliance endpoint that collects and returns
 * all personal data held about a data subject.
 */
import { describe, it, expect } from 'vitest';
import { DSARService } from '../src/privacy/dsarService';

// ── Mock Prisma ─────────────────────────────────────────────────────────────

function createMockPrisma() {
  const leads: Record<string, {
    leadId: string; name: string | null; phone: string | null; email: string | null;
    note: string | null; source: string; status: string; market: string | null;
    assignedTo: string | null; createdAt: Date; updatedAt: Date;
    historyEntries: Array<{
      id: string; status: string; note: string | null; actorUserId: string; createdAt: Date;
    }>;
  }> = {
    'lead-1': {
      leadId: 'lead-1', name: 'Nguyen Van A', phone: '0912345678',
      email: 'nguyen@example.com', note: 'Interested in Japan market',
      source: 'website', status: 'NEW', market: 'JAPAN',
      assignedTo: 'admin-1', createdAt: new Date('2024-01-15'),
      updatedAt: new Date('2024-06-20'),
      historyEntries: [
        { id: 'h1', status: 'NEW', note: 'Created from website form', actorUserId: 'system', createdAt: new Date('2024-01-15') },
        { id: 'h2', status: 'CONTACTED', note: 'Called to confirm interest', actorUserId: 'admin-1', createdAt: new Date('2024-02-01') },
      ],
    },
  };

  const consentRecords: Array<{
    id: string; subjectType: string; subjectId: string; scope: string;
    action: string; recordedAt: Date;
  }> = [
    { id: 'c1', subjectType: 'LEAD', subjectId: 'lead-1', scope: 'DATA_PROCESSING', action: 'GRANTED', recordedAt: new Date('2024-01-15') },
    { id: 'c2', subjectType: 'LEAD', subjectId: 'lead-1', scope: 'MARKETING', action: 'GRANTED', recordedAt: new Date('2024-01-15') },
  ];

  const activityLogs: Array<{
    id: string; action: string; actorUserId: string; targetType: string; targetId: string; createdAt: Date;
  }> = [
    { id: 'a1', action: 'DATA_ACCESS', actorUserId: 'admin-1', targetType: 'lead', targetId: 'lead-1', createdAt: new Date('2024-06-01') },
  ];

  return {
    lead: {
      findUnique: async (args: { where: { leadId: string } }) => leads[args.where.leadId] ?? null,
    },
    candidateProfile: {
      findUnique: async () => null,
    },
    intakeConversation: {
      findUnique: async () => null,
    },
    consentRecord: {
      findMany: async (args: { where: { subjectType: string; subjectId: string } }) =>
        consentRecords.filter(
          (c) => c.subjectType === args.where.subjectType && c.subjectId === args.where.subjectId,
        ),
    },
    activityLog: {
      findMany: async (args: { where: { targetType: string; targetId: string } }) =>
        activityLogs.filter(
          (a) => a.targetType === args.where.targetType && a.targetId === args.where.targetId,
        ),
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DSAR Service', () => {
  const prisma = createMockPrisma() as never;
  const dsar = new DSARService(prisma);

  it('processes a DSAR request for a LEAD', async () => {
    const result = await dsar.processRequest({
      subjectType: 'LEAD',
      subjectId: 'lead-1',
      requestedBy: 'admin-1',
    });

    expect(result.requestId).toMatch(/^DSAR-/);
    expect(result.processedAt).toBeTruthy();
    expect(result.subject.type).toBe('LEAD');
    expect(result.subject.id).toBe('lead-1');
    expect(result.confirmation.dataProcessed).toBe(true);
    expect(result.confirmation.categories.length).toBeGreaterThan(0);
    expect(result.confirmation.purposes.length).toBeGreaterThan(0);
    expect(result.confirmation.retentionPeriods.length).toBe(1);
    expect(result.confirmation.thirdPartyRecipients.length).toBeGreaterThan(0);
    expect(result.confirmation.automatedDecisionMaking).toBe(false);
  });

  it('returns the actual personal data (unmasked)', async () => {
    const result = await dsar.processRequest({
      subjectType: 'LEAD',
      subjectId: 'lead-1',
      requestedBy: 'admin-1',
    });

    const data = result.personalData as { lead: { name: string; email: string; phone: string } };
    expect(data.lead.name).toBe('Nguyen Van A');
    expect(data.lead.email).toBe('nguyen@example.com');
    expect(data.lead.phone).toBe('0912345678');
  });

  it('includes consent records', async () => {
    const result = await dsar.processRequest({
      subjectType: 'LEAD',
      subjectId: 'lead-1',
      requestedBy: 'admin-1',
    });

    expect(result.consentRecords.length).toBe(2);
    expect(result.consentRecords.some((c) => c.scope === 'DATA_PROCESSING')).toBe(true);
    expect(result.consentRecords.some((c) => c.scope === 'MARKETING')).toBe(true);
  });

  it('includes access history', async () => {
    const result = await dsar.processRequest({
      subjectType: 'LEAD',
      subjectId: 'lead-1',
      requestedBy: 'admin-1',
    });

    expect(result.accessHistory.length).toBe(1);
    expect(result.accessHistory[0].action).toBe('DATA_ACCESS');
    expect(result.accessHistory[0].actor).toBe('admin-1');
  });

  it('classifies the exported data', async () => {
    const result = await dsar.processRequest({
      subjectType: 'LEAD',
      subjectId: 'lead-1',
      requestedBy: 'admin-1',
    });

    expect(result.classification.level).toBe('CONFIDENTIAL');
    expect(result.classification.encryptionRequired).toBe(false);
  });

  it('lists available actions', async () => {
    const result = await dsar.processRequest({
      subjectType: 'LEAD',
      subjectId: 'lead-1',
      requestedBy: 'admin-1',
    });

    expect(result.availableActions.length).toBeGreaterThan(0);
    expect(result.availableActions.some((a) => a.includes('erasure'))).toBe(true);
    expect(result.availableActions.some((a) => a.includes('rectification'))).toBe(true);
  });

  it('throws 404 for non-existent subject', async () => {
    await expect(
      dsar.processRequest({
        subjectType: 'LEAD',
        subjectId: 'non-existent',
        requestedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'DSAR_SUBJECT_NOT_FOUND' });
  });

  it('throws 400 for invalid subject type', async () => {
    await expect(
      dsar.processRequest({
        subjectType: 'INVALID',
        subjectId: 'lead-1',
        requestedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'DSAR_SUBJECT_TYPE_INVALID' });
  });

  it('throws 400 for empty subjectId', async () => {
    await expect(
      dsar.processRequest({
        subjectType: 'LEAD',
        subjectId: '',
        requestedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'DSAR_SUBJECT_REQUIRED' });
  });
});
