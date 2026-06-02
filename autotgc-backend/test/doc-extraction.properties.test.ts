/**
 * Property + example tests for AI Document OCR & Verification (Feature 1).
 *
 * Tests the SERVICE (`DocExtractionService`) with an in-memory Prisma fake (the
 * pattern from `reportingRoutes.test.ts`) plus a fake `OcrProvider`, and adds a
 * couple of pure property checks that call the engine (`parseDocumentText` /
 * `verifyExtraction`) directly.
 *
 * Coverage:
 *   - IELTS "Overall Band Score 6.5" + {minScore:6.0} → VERIFIED, score===6.5.
 *   - IELTS 6.5 vs {minScore:7.0} → FAILED with 'below_requirement'.
 *   - Empty text / NoopOcrProvider → NEEDS_RESEND.
 *   - SALES not owner → ForbiddenError; missing candidate → NotFoundError.
 *   - Pure props: IELTS score always within 0..9; engine never throws on
 *     arbitrary strings.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PrismaClient } from '@prisma/client';

import { DocExtractionService } from '../src/documents/docExtractionService';
import type { SubmitDocInput } from '../src/documents/docExtractionService';
import { NoopOcrProvider } from '../src/documents/ocrProvider';
import type { OcrProvider, OcrInput, OcrResult } from '../src/documents/ocrProvider';
import { parseDocumentText, verifyExtraction } from '../src/documents/docExtraction';
import type { DocType } from '../src/documents/docExtraction';
import { ForbiddenError, NotFoundError } from '../src/infra/errors';
import type { AuthInfo } from '../src/http/authMiddleware';

// ===========================================================================
// In-memory Prisma fake — only the methods DocExtractionService touches.
// ===========================================================================

interface CandidateRow {
  id: string;
  assignedTo: string | null;
}

interface ExtractionRow {
  id: string;
  candidateId: string;
  checklistItemId: string | null;
  docType: string;
  status: string;
  storageKey: string;
  extractedFields: unknown;
  confidence: number;
  issues: unknown;
  rawText: string;
  provider: string;
  verifiedAgainst: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const NOW = new Date('2025-06-09T00:00:00.000Z');

function makePrismaFake(candidates: CandidateRow[] = []): {
  prisma: PrismaClient;
  extractions: ExtractionRow[];
} {
  const candStore = [...candidates];
  const extractions: ExtractionRow[] = [];
  let seq = 0;

  const prisma = {
    candidateProfile: {
      findUnique: async (args: { where: { id: string }; select?: unknown }) =>
        candStore.find((c) => c.id === args.where.id) ?? null,
    },
    documentExtraction: {
      create: async (args: { data: Record<string, unknown> }) => {
        const d = args.data as Partial<ExtractionRow>;
        const row: ExtractionRow = {
          id: `ext-${++seq}`,
          candidateId: d.candidateId as string,
          checklistItemId: (d.checklistItemId as string | null) ?? null,
          docType: d.docType as string,
          status: d.status as string,
          storageKey: (d.storageKey as string) ?? '',
          extractedFields: d.extractedFields ?? {},
          confidence: (d.confidence as number) ?? 0,
          issues: d.issues ?? [],
          rawText: (d.rawText as string) ?? '',
          provider: (d.provider as string) ?? 'none',
          verifiedAgainst: d.verifiedAgainst ?? null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        extractions.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) =>
        extractions.find((r) => r.id === args.where.id) ?? null,
      findMany: async (args?: { where?: { candidateId?: string } }) => {
        const cid = args?.where?.candidateId;
        const rows = cid === undefined ? [...extractions] : extractions.filter((r) => r.candidateId === cid);
        // newest first (createdAt desc) — all share NOW, so reverse insertion.
        return [...rows].reverse();
      },
    },
  } as unknown as PrismaClient;

  return { prisma, extractions };
}

// A fake OCR provider that returns a fixed transcription + confidence.
function fakeOcr(text: string, confidence: number, name = 'fake-vision'): OcrProvider {
  return {
    name,
    async extractText(_input: OcrInput): Promise<OcrResult> {
      return { text, confidence };
    },
  };
}

const ADMIN: AuthInfo = { userId: 'admin', role: 'ADMIN', sessionId: 's1' };
const SALES_OWNER: AuthInfo = { userId: 'sales-1', role: 'SALES', sessionId: 's2' };
const SALES_OTHER: AuthInfo = { userId: 'sales-2', role: 'SALES', sessionId: 's3' };

function baseInput(over: Partial<SubmitDocInput> = {}): SubmitDocInput {
  return {
    candidateId: 'cand-1',
    docType: 'IELTS',
    ...over,
  };
}

// ===========================================================================
// Service example tests
// ===========================================================================

describe('DocExtractionService.submit — verification outcomes', () => {
  it('IELTS "Overall Band Score 6.5" with minScore 6.0 → VERIFIED, score 6.5', async () => {
    const { prisma } = makePrismaFake([{ id: 'cand-1', assignedTo: 'sales-1' }]);
    const service = new DocExtractionService(prisma);

    const row = await service.submit(
      baseInput({ rawText: 'Overall Band Score 6.5', requirement: { minScore: 6.0 } }),
      ADMIN,
    );

    expect(row.status).toBe('VERIFIED');
    expect((row.extractedFields as { score?: number }).score).toBe(6.5);
    expect(row.provider).toBe('provided');
  });

  it('IELTS 6.5 below minScore 7.0 → FAILED with below_requirement', async () => {
    const { prisma } = makePrismaFake([{ id: 'cand-1', assignedTo: 'sales-1' }]);
    const service = new DocExtractionService(prisma);

    const row = await service.submit(
      baseInput({ rawText: 'Overall Band Score 6.5', requirement: { minScore: 7.0 } }),
      ADMIN,
    );

    expect(row.status).toBe('FAILED');
    expect(row.issues as string[]).toContain('below_requirement');
  });

  it('empty rawText → NEEDS_RESEND (missing key field)', async () => {
    const { prisma } = makePrismaFake([{ id: 'cand-1', assignedTo: 'sales-1' }]);
    const service = new DocExtractionService(prisma);

    const row = await service.submit(
      baseInput({ rawText: '', requirement: { minScore: 6.0 } }),
      ADMIN,
    );

    expect(row.status).toBe('NEEDS_RESEND');
    expect(row.issues as string[]).toContain('missing_key_field');
  });

  it('NoopOcrProvider (no provider wired, no rawText) → NEEDS_RESEND, provider none', async () => {
    const { prisma } = makePrismaFake([{ id: 'cand-1', assignedTo: 'sales-1' }]);
    const service = new DocExtractionService(prisma); // defaults to NoopOcrProvider

    const row = await service.submit(
      baseInput({ imageBase64: 'AAAA', mimeType: 'image/jpeg', requirement: { minScore: 6.0 } }),
      ADMIN,
    );

    expect(row.status).toBe('NEEDS_RESEND');
    expect(row.provider).toBe('none');
    expect(row.confidence).toBe(0);
    // confirm the Noop never fabricates text
    expect(await new NoopOcrProvider().extractText({})).toEqual({ text: '', confidence: 0 });
  });

  it('uses a wired OCR provider when no rawText is provided', async () => {
    const { prisma } = makePrismaFake([{ id: 'cand-1', assignedTo: 'sales-1' }]);
    const service = new DocExtractionService(prisma, fakeOcr('Overall Band Score 8.0', 0.95));

    const row = await service.submit(
      baseInput({ imageBase64: 'AAAA', mimeType: 'image/jpeg', requirement: { minScore: 7.0 } }),
      ADMIN,
    );

    expect(row.status).toBe('VERIFIED');
    expect((row.extractedFields as { score?: number }).score).toBe(8.0);
    expect(row.provider).toBe('fake-vision');
    expect(row.confidence).toBe(0.95);
  });
});

describe('DocExtractionService — SALES assigned-only scoping', () => {
  it('SALES owner can submit for their assigned candidate', async () => {
    const { prisma } = makePrismaFake([{ id: 'cand-1', assignedTo: 'sales-1' }]);
    const service = new DocExtractionService(prisma);

    const row = await service.submit(
      baseInput({ rawText: 'Overall Band Score 6.5', requirement: { minScore: 6.0 } }),
      SALES_OWNER,
    );
    expect(row.status).toBe('VERIFIED');
  });

  it('SALES not owner → ForbiddenError on submit', async () => {
    const { prisma } = makePrismaFake([{ id: 'cand-1', assignedTo: 'sales-1' }]);
    const service = new DocExtractionService(prisma);

    await expect(
      service.submit(baseInput({ rawText: 'Overall Band Score 6.5' }), SALES_OTHER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('missing candidate → NotFoundError on submit', async () => {
    const { prisma } = makePrismaFake([]); // no candidates
    const service = new DocExtractionService(prisma);

    await expect(
      service.submit(baseInput({ rawText: 'Overall Band Score 6.5' }), ADMIN),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('list scopes to candidate + denies SALES non-owner; get resolves from row', async () => {
    const { prisma } = makePrismaFake([{ id: 'cand-1', assignedTo: 'sales-1' }]);
    const service = new DocExtractionService(prisma);

    const created = await service.submit(
      baseInput({ rawText: 'Overall Band Score 6.5', requirement: { minScore: 6.0 } }),
      ADMIN,
    );

    const list = await service.list('cand-1', SALES_OWNER);
    expect(list).toHaveLength(1);

    await expect(service.list('cand-1', SALES_OTHER)).rejects.toBeInstanceOf(ForbiddenError);

    const fetched = await service.get(created.id, SALES_OWNER);
    expect(fetched.id).toBe(created.id);
    await expect(service.get(created.id, SALES_OTHER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.get('missing', ADMIN)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ===========================================================================
// Pure property checks — engine directly
// ===========================================================================

describe('pure engine properties', () => {
  it('parseDocumentText never throws on arbitrary strings + doc types', () => {
    const docTypes: DocType[] = ['IELTS', 'TOEFL', 'TRANSCRIPT', 'FINANCIAL', 'PASSPORT', 'OTHER'];
    fc.assert(
      fc.property(fc.constantFrom(...docTypes), fc.string(), (docType, text) => {
        expect(() => parseDocumentText(docType, text)).not.toThrow();
      }),
    );
  });

  it('verifyExtraction never throws on arbitrary fields/requirements/confidence', () => {
    const docTypes: DocType[] = ['IELTS', 'TOEFL', 'TRANSCRIPT', 'FINANCIAL', 'PASSPORT', 'OTHER'];
    fc.assert(
      fc.property(
        fc.constantFrom(...docTypes),
        fc.record({
          score: fc.option(fc.double({ noNaN: true }), { nil: undefined }),
          gpa: fc.option(fc.double({ noNaN: true }), { nil: undefined }),
          amountVndM: fc.option(fc.double({ noNaN: true }), { nil: undefined }),
        }),
        fc.record({
          minScore: fc.option(fc.double({ noNaN: true }), { nil: undefined }),
          minGpa: fc.option(fc.double({ noNaN: true }), { nil: undefined }),
          minAmountVndM: fc.option(fc.double({ noNaN: true }), { nil: undefined }),
        }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (docType, fields, requirement, confidence) => {
          expect(() => verifyExtraction(docType, fields, requirement, confidence)).not.toThrow();
        },
      ),
    );
  });

  it('parsed IELTS score is always within band 0..9', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 9, noNaN: true }), (raw) => {
        const band = Math.round(raw * 2) / 2; // valid IELTS half-bands
        const fields = parseDocumentText('IELTS', `Overall Band Score ${band.toFixed(1)}`);
        if (fields.score !== undefined) {
          expect(fields.score).toBeGreaterThanOrEqual(0);
          expect(fields.score).toBeLessThanOrEqual(9);
        }
      }),
    );
  });

  it('parsed TOEFL score is always within 0..120', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 120 }), (total) => {
        const fields = parseDocumentText('TOEFL', `Total Score ${total}`);
        if (fields.score !== undefined) {
          expect(fields.score).toBeGreaterThanOrEqual(0);
          expect(fields.score).toBeLessThanOrEqual(120);
        }
      }),
    );
  });
});
