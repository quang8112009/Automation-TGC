/**
 * Property-based tests for the Work_Assistant (Trợ lý Công việc TGC) — task 5.1.
 *
 * These cover the design's canonical Properties 9, 10, 11 for
 * `ai-reporting-and-ops-enhancements`. They live in a SEPARATE file from the
 * shared `ai-reporting-and-ops.properties.test.ts` to avoid collisions with
 * other parallel work; each test is tagged with its canonical property number
 * and runs >= 100 generated cases on fast-check.
 *
 * The KnowledgeService is backed by a tiny in-memory Prisma fake (only the one
 * `knowledgeEntry.findMany` method it uses), and the Gemini seam is stubbed as
 * either ABSENT (undefined) or THROWING so we exercise the deterministic
 * grounded-fallback path without any network or API key.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { KnowledgeEntry, PrismaClient } from '@prisma/client';

import {
  WorkAssistant,
  scopeBusinessData,
} from '../src/recruitment/agent/workAssistant';
import type { ContentGenerator } from '../src/strategy/personaService';
import {
  KnowledgeService,
  rankRows,
  scoreEntry,
  toRankable,
} from '../src/recruitment/knowledge/knowledgeService';

// CONSULT_RETRIEVAL_LIMIT (the agent grounds answers with the top-5 entries).
const RETRIEVAL_LIMIT = 5;

// A small vocabulary so generated queries actually overlap entry text/tags and
// produce meaningful (score > 0) rankings rather than mostly-empty results.
const VOCAB = ['nhat', 'duc', 'han', 'visa', 'luong', 'hoso', 'phi', 'tuyen', 'xkld', 'chieu'];

// --- in-memory KnowledgeEntry fixtures + Prisma fake -------------------------

function makeEntry(over: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
  return {
    id: over.id,
    category: over.category ?? 'faq',
    title: over.title ?? 'title',
    content: over.content ?? 'content',
    tags: (over.tags ?? []) as KnowledgeEntry['tags'],
    market: over.market ?? null,
    active: over.active ?? true,
    createdAt: over.createdAt ?? new Date(0),
    updatedAt: over.updatedAt ?? new Date(0),
  };
}

/** Prisma fake exposing only `knowledgeEntry.findMany`, filtering by active. */
function makeKnowledgeService(rows: readonly KnowledgeEntry[]): KnowledgeService {
  const prisma = {
    knowledgeEntry: {
      findMany: async (args?: { where?: { active?: boolean } }) => {
        const wantActive = args?.where?.active;
        if (wantActive === undefined) return [...rows];
        return rows.filter((r) => r.active === wantActive);
      },
    },
  } as unknown as PrismaClient;
  return new KnowledgeService(prisma);
}

// Gemini seam that always throws (simulates a configured-but-failing service).
const throwingGemini: ContentGenerator = {
  generateContent: async () => {
    throw new Error('gemini down');
  },
};

// --- generators --------------------------------------------------------------

const wordsGen = (min: number, max: number): fc.Arbitrary<string[]> =>
  fc.array(fc.constantFrom(...VOCAB), { minLength: min, maxLength: max });

const entryGen = (id: string): fc.Arbitrary<KnowledgeEntry> =>
  fc.record({
    title: wordsGen(1, 3).map((w) => w.join(' ')),
    content: wordsGen(1, 5).map((w) => w.join(' ')),
    tags: wordsGen(0, 3),
    active: fc.boolean(),
  }).map((r) =>
    makeEntry({ id, title: `${r.title} ${id}`, content: r.content, tags: r.tags, active: r.active }),
  );

const entriesGen = fc
  .integer({ min: 0, max: 8 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => entryGen(`k${i}`))))
  .map((arr) => arr as KnowledgeEntry[]);

// A non-empty (after trim) question built from the shared vocabulary.
const questionGen = wordsGen(1, 3).map((w) => w.join(' '));

// =============================================================================

describe('work-assistant properties (grounding ranking)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 9: Xếp hạng grounding chỉ dùng entry active, ổn định và xác định
  // For any set of KnowledgeEntry (active + inactive) and any question, the
  // assistant's retrieved grounding contains only active entries, ordered by
  // non-increasing relevance score with a stable title tie-break, equals the
  // returned `sources`, and is deterministic for identical inputs.
  // Validates: Requirements 6.1, 6.4, 8.3
  it('Property 9: grounding uses only active entries, ordered by descending relevance, deterministic', async () => {
    await fc.assert(
      fc.asyncProperty(entriesGen, questionGen, async (rows, question) => {
        const service = makeKnowledgeService(rows);
        const assistant = new WorkAssistant(service); // Gemini absent

        const first = await assistant.ask({ question, role: 'ADMIN', userId: 'u1' });

        // Oracle: pure ranking over the ACTIVE rows only, same retrieval limit.
        const activeRows = rows.filter((r) => r.active);
        const oracle = rankRows(activeRows, question, RETRIEVAL_LIMIT);

        // sources exactly equal the ranked oracle (same order, same rows).
        expect(first.sources.map((s) => s.id)).toEqual(oracle.map((s) => s.id));
        // never exceeds the retrieval limit.
        expect(first.sources.length).toBeLessThanOrEqual(RETRIEVAL_LIMIT);

        // Only active entries are ever used for grounding.
        for (const s of first.sources) {
          expect(s.active).toBe(true);
        }

        // Ordering: non-increasing score, stable title tie-break.
        for (let i = 1; i < first.sources.length; i++) {
          const prev = first.sources[i - 1];
          const cur = first.sources[i];
          const sPrev = scoreEntry(toRankable(prev), question);
          const sCur = scoreEntry(toRankable(cur), question);
          expect(sPrev).toBeGreaterThanOrEqual(sCur);
          if (sPrev === sCur) {
            expect(prev.title.localeCompare(cur.title)).toBeLessThanOrEqual(0);
          }
        }

        // Determinism: identical inputs -> identical sources and answer.
        const second = await assistant.ask({ question, role: 'ADMIN', userId: 'u1' });
        expect(second.sources.map((s) => s.id)).toEqual(first.sources.map((s) => s.id));
        expect(second.answer).toBe(first.answer);
      }),
      { numRuns: 200 },
    );
  });
});

describe('work-assistant properties (Gemini-absent fallback)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 10: Trợ lý không ném lỗi khi vắng Gemini
  // For any valid (non-empty) question, when Gemini is not configured OR throws,
  // `WorkAssistant.ask` always resolves to an Assistant_Answer with
  // aiGenerated = false (it never rejects and never surfaces a 502).
  // Validates: Requirements 6.3
  it('Property 10: with Gemini absent or throwing, ask never rejects and aiGenerated is false', async () => {
    await fc.assert(
      fc.asyncProperty(entriesGen, questionGen, async (rows, question) => {
        const service = makeKnowledgeService(rows);

        // (a) Gemini absent.
        const absent = new WorkAssistant(service);
        const a = await absent.ask({ question, role: 'SALES', userId: 'u1' });
        expect(a.aiGenerated).toBe(false);
        expect(typeof a.answer).toBe('string');
        expect(a.answer.length).toBeGreaterThan(0);

        // (b) Gemini configured but throwing.
        const failing = new WorkAssistant(service, throwingGemini);
        const b = await failing.ask({ question, role: 'ADMIN', userId: 'u2' });
        expect(b.aiGenerated).toBe(false);
        expect(typeof b.answer).toBe('string');
        expect(b.answer.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});

describe('work-assistant properties (role-based scoping)', () => {
  // Feature: ai-reporting-and-ops-enhancements, Property 11: Phạm vi dữ liệu nghiệp vụ theo vai trò
  // For any set of candidate/lead rows, `scopeBusinessData` returns every row
  // unfiltered for ADMIN, and for SALES returns exactly the rows whose
  // `assignedTo === userId` (no out-of-scope row ever leaks through).
  // Validates: Requirements 7.1, 7.2, 7.3
  it('Property 11: ADMIN sees all rows; SALES sees only its assigned rows', () => {
    const userPool = ['u1', 'u2', 'u3'];
    const rowGen = fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }),
      assignedTo: fc.option(fc.constantFrom(...userPool), { nil: null }),
    });

    fc.assert(
      fc.property(
        fc.array(rowGen, { maxLength: 30 }),
        fc.constantFrom(...userPool),
        (rows, userId) => {
          // ADMIN: identical set and order, nothing dropped or added.
          const adminScoped = scopeBusinessData(rows, { role: 'ADMIN', userId });
          expect(adminScoped).toEqual(rows);

          // SALES: only rows assigned to this user.
          const salesScoped = scopeBusinessData(rows, { role: 'SALES', userId });
          for (const row of salesScoped) {
            expect(row.assignedTo).toBe(userId);
          }
          // Completeness: every in-scope row is present (count matches the oracle).
          const expected = rows.filter((r) => r.assignedTo != null && r.assignedTo === userId);
          expect(salesScoped).toEqual(expected);
          // No unassigned / other-user row leaks in.
          expect(salesScoped.some((r) => r.assignedTo == null)).toBe(false);
          expect(salesScoped.some((r) => r.assignedTo != null && r.assignedTo !== userId)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
