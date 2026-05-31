/**
 * Idempotently seed the recruitment KNOWLEDGE BASE used to ground the AI
 * recruitment-consultant agent (customer: Thanh Giang Conincon).
 *
 * Run with:
 *   npx ts-node scripts/seed-knowledge.ts
 * or compile and run the emitted JS.
 *
 * This is retrieval grounding (curated public company/market/visa/industry/FAQ
 * content) — NOT model fine-tuning. Re-running is safe: entries are upserted by
 * the stable key (category + title). Only counts and categories are logged.
 */
import { getPrisma } from '../src/infra/prisma';
import { KnowledgeService } from '../src/recruitment/knowledge/knowledgeService';
import { KNOWLEDGE_BASE } from '../src/recruitment/knowledge/knowledgeBase';

async function main(): Promise<void> {
  const prisma = getPrisma();
  const service = new KnowledgeService(prisma);

  try {
    const result = await service.seed();

    // Summarize how many entries exist per category (active only).
    const all = await service.list();
    const byCategory: Record<string, number> = {};
    for (const entry of all) {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    }
    const summary = Object.entries(byCategory)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cat, n]) => `${cat}=${n}`)
      .join(', ');

    // eslint-disable-next-line no-console
    console.log(
      `Knowledge base seeded: created=${result.created}, updated=${result.updated}, ` +
        `total curated=${KNOWLEDGE_BASE.length}. Active by category: ${summary}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`Knowledge seeding failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
