/**
 * Idempotently seed the internal SERVICE ACCOUNT identities (Foundation Req 8).
 *
 * Run with:
 *   npx ts-node scripts/seed-service-accounts.ts
 * or compile and run the emitted JS. Credentials are read from the Secret_Store
 * (process.env) when present; otherwise a random credential is generated. Only
 * account NAMES are logged — never credential values.
 */
import { createSecretLoader } from '../src/infra/secrets';
import { getPrisma } from '../src/infra/prisma';
import { ServiceAccountService } from '../src/auth/serviceAccountService';

async function main(): Promise<void> {
  const secrets = createSecretLoader(process.env);
  const prisma = getPrisma();
  const service = new ServiceAccountService(prisma);

  try {
    await service.ensureSeeded(secrets);
    const accounts = await prisma.serviceAccount.findMany({ select: { name: true } });
    const names = accounts.map((a) => a.name).sort();
    // Names only — never credential values.
    // eslint-disable-next-line no-console
    console.log(`Seeded service accounts: ${names.join(', ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`Service account seeding failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
