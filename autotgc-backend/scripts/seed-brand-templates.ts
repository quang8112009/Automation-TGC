/**
 * Idempotently seed the default BRAND TEMPLATES (one per template kind:
 * thumbnail, infographic, poster, short_video) used to resolve visual/video
 * render specs for the customer Thanh Giang (XKLĐ).
 *
 * Run with:
 *   npx ts-node scripts/seed-brand-templates.ts
 * or compile and run the emitted JS.
 *
 * Re-running is safe: templates are keyed by the stable unique name
 * `default-<kind>`, so existing ones are left untouched. Only counts are logged.
 *
 * HONESTY NOTE: a brand template only describes HOW an asset should look
 * (palette/fonts/logo/layout). It does not generate any image or video.
 */
import { getPrisma } from '../src/infra/prisma';
import { BrandTemplateService } from '../src/marketing/assets/brandTemplateService';

async function main(): Promise<void> {
  const prisma = getPrisma();
  const service = new BrandTemplateService(prisma);

  try {
    const result = await service.seedDefaults();
    const all = await service.list();
    const byKind: Record<string, number> = {};
    for (const tpl of all) {
      byKind[tpl.kind] = (byKind[tpl.kind] ?? 0) + 1;
    }
    const summary = Object.entries(byKind)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, n]) => `${kind}=${n}`)
      .join(', ');

    // eslint-disable-next-line no-console
    console.log(
      `Brand templates seeded: created=${result.created}, existing=${result.existing}, ` +
        `defaults=${result.total}. Templates by kind: ${summary || '(none)'}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`Brand template seeding failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
