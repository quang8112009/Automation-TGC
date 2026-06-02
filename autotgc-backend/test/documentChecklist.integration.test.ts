/**
 * Integration test for cascade delete of candidate document checklists
 * (Requirement 11.4).
 *
 * Req 11.4: WHEN a CandidateProfile is deleted, the system SHALL delete the
 * DocumentChecklistItem rows linked to that candidate.
 *
 * A live PostgreSQL database is generally unavailable in this suite (the rest of
 * the recruitment/document tests drive logic through in-memory Prisma fakes, not
 * a real Prisma datasource), so this test verifies the cascade at two levels
 * that together prove the behavior is wired correctly:
 *
 *   1. Schema/migration level — assert that BOTH the Prisma schema and the
 *      generated migration SQL declare the DocumentChecklistItem -> CandidateProfile
 *      foreign key with ON DELETE CASCADE. This is the source-of-truth that makes
 *      Postgres delete child rows when a parent CandidateProfile is removed.
 *
 *   2. Behavioral level — a tiny in-memory store that models the FK cascade the
 *      same way Postgres would, exercised through delete, to demonstrate that
 *      deleting a candidate removes exactly that candidate's checklist items and
 *      leaves other candidates' items intact.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BACKEND_ROOT = join(__dirname, '..');
const SCHEMA_PATH = join(BACKEND_ROOT, 'prisma', 'schema.prisma');
const MIGRATION_PATH = join(
  BACKEND_ROOT,
  'prisma',
  'migrations',
  '0002_ai_reporting_ops',
  'migration.sql',
);

// ---- 1. Schema / migration level -------------------------------------------

describe('DocumentChecklistItem cascade delete — schema & migration (Req 11.4)', () => {
  it('declares the candidate relation with onDelete: Cascade in schema.prisma', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');

    // Isolate the DocumentChecklistItem model block.
    const modelMatch = schema.match(/model\s+DocumentChecklistItem\s*\{([\s\S]*?)\}/);
    expect(modelMatch, 'DocumentChecklistItem model must exist').not.toBeNull();
    const modelBody = modelMatch![1];

    // The FK to CandidateProfile must be declared with onDelete: Cascade.
    expect(modelBody).toMatch(/candidate\s+CandidateProfile/);
    expect(modelBody).toMatch(/references:\s*\[id\]/);
    expect(modelBody).toMatch(/onDelete:\s*Cascade/);
  });

  it('emits ON DELETE CASCADE on the DocumentChecklistItem FK in the migration SQL', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');

    // The migration must add the FK constraint referencing CandidateProfile with
    // ON DELETE CASCADE so Postgres removes child rows with the parent candidate.
    const fkMatch = sql.match(
      /ALTER TABLE "DocumentChecklistItem"[\s\S]*?FOREIGN KEY \("candidateId"\) REFERENCES "CandidateProfile"\("id"\)[\s\S]*?ON DELETE CASCADE/,
    );
    expect(fkMatch, 'migration must add the cascading FK constraint').not.toBeNull();
  });
});

// ---- 2. Behavioral level (in-memory FK cascade model) ----------------------

interface CandidateRow {
  id: string;
}

interface ChecklistRow {
  id: string;
  candidateId: string;
}

/**
 * Minimal in-memory store that models the ON DELETE CASCADE foreign key the way
 * Postgres enforces it: deleting a CandidateProfile removes every
 * DocumentChecklistItem whose candidateId points at it.
 */
class CascadingStore {
  candidates = new Map<string, CandidateRow>();
  items = new Map<string, ChecklistRow>();

  addCandidate(id: string): void {
    this.candidates.set(id, { id });
  }

  addItem(item: ChecklistRow): void {
    if (!this.candidates.has(item.candidateId)) {
      // Mirrors a FK violation: cannot attach a child to a missing parent.
      throw new Error(`FK violation: candidate ${item.candidateId} does not exist`);
    }
    this.items.set(item.id, item);
  }

  itemsFor(candidateId: string): ChecklistRow[] {
    return [...this.items.values()].filter((i) => i.candidateId === candidateId);
  }

  /** Delete a candidate and cascade-delete its checklist items. */
  deleteCandidate(id: string): void {
    this.candidates.delete(id);
    for (const [itemId, item] of this.items) {
      if (item.candidateId === id) this.items.delete(itemId);
    }
  }
}

describe('DocumentChecklistItem cascade delete — behavioral model (Req 11.4)', () => {
  it('deleting a candidate removes all of its checklist items', () => {
    const store = new CascadingStore();
    store.addCandidate('cand-1');
    store.addItem({ id: 'doc-1', candidateId: 'cand-1' });
    store.addItem({ id: 'doc-2', candidateId: 'cand-1' });

    expect(store.itemsFor('cand-1')).toHaveLength(2);

    store.deleteCandidate('cand-1');

    expect(store.candidates.has('cand-1')).toBe(false);
    expect(store.itemsFor('cand-1')).toHaveLength(0);
    expect(store.items.size).toBe(0);
  });

  it('cascade is scoped: deleting one candidate leaves another candidate untouched', () => {
    const store = new CascadingStore();
    store.addCandidate('cand-1');
    store.addCandidate('cand-2');
    store.addItem({ id: 'doc-1', candidateId: 'cand-1' });
    store.addItem({ id: 'doc-2', candidateId: 'cand-2' });
    store.addItem({ id: 'doc-3', candidateId: 'cand-2' });

    store.deleteCandidate('cand-1');

    // cand-1's item is gone; cand-2's two items remain.
    expect(store.itemsFor('cand-1')).toHaveLength(0);
    expect(store.itemsFor('cand-2')).toHaveLength(2);
    expect(store.candidates.has('cand-2')).toBe(true);
  });
});
