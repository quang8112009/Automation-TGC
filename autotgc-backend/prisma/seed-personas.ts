/**
 * Persona database seed (idempotent) — "khởi tạo database cho personas".
 *
 * Seeds a small, on-brand set of Content_Strategy personas for Thanh Giang
 * (Vietnamese labor-export / XKLĐ) so the Strategy page and the content
 * generator have real personas to work with out of the box. Each persona is
 * created under an (upserted) DomainContext.
 *
 * Idempotent: re-running upserts the domains and only creates personas that are
 * not already present (matched by domainName + personaName). It NEVER deletes or
 * overwrites edited personas, so it is safe to run on an existing database.
 *
 * Run:  npm run seed:personas
 *       (uses DATABASE_URL from the environment / .env — same as Prisma)
 */
import { PrismaClient } from '@prisma/client';

interface SeedDomain {
  domainName: string;
  contextDescription: string;
  defaultToneOfVoice: string;
  personas: SeedPersona[];
}

interface SeedPersona {
  personaName: string;
  age: string;
  interests: string;
  targetNeeds: string;
  painPoints: string;
  toneOfVoice: string;
  recommendedTone?: string;
}

/**
 * On-brand seed personas grounded in the real XKLĐ audience (candidates +
 * their families) across the company's primary markets. Kept concise and
 * factual — no invented numbers.
 */
export const PERSONA_SEED: readonly SeedDomain[] = [
  {
    domainName: 'xkld-nhat-ban',
    contextDescription:
      'Xuất khẩu lao động Nhật Bản (TTS, kỹ năng đặc định, kỹ sư) cho Thanh Giang Conincon.',
    defaultToneOfVoice: 'thân thiện, đáng tin cậy',
    personas: [
      {
        personaName: 'Nam – Thực tập sinh tương lai',
        age: '20-26',
        interests: 'thu nhập tại Nhật, ngành xây dựng/cơ khí, học tiếng Nhật cơ bản',
        targetNeeds:
          'tìm đơn hàng phù hợp, hiểu chi phí và lộ trình, mức lương thực nhận, thời gian xuất cảnh',
        painPoints:
          'lo sợ lừa đảo/chi phí ẩn, chưa biết tiếng, thông tin đơn hàng thiếu minh bạch',
        toneOfVoice: 'thân thiện, trấn an, rõ ràng',
        recommendedTone: 'thân thiện, trấn an, rõ ràng',
      },
      {
        personaName: 'Chị Hương – Phụ huynh ứng viên',
        age: '45-55',
        interests: 'sự an toàn của con, uy tín công ty phái cử, hỗ trợ sau xuất cảnh',
        targetNeeds: 'bằng chứng uy tín, cam kết rõ ràng, kênh liên hệ trực tiếp khi cần',
        painPoints: 'sợ con bị bỏ rơi nơi xa, nhiều công ty mập mờ, sợ mất tiền oan',
        toneOfVoice: 'trang trọng, ân cần, đáng tin',
      },
    ],
  },
  {
    domainName: 'xkld-duc',
    contextDescription:
      'Chương trình điều dưỡng và nghề tại Đức (Ausbildung) — thu nhập cao, định cư lâu dài.',
    defaultToneOfVoice: 'chuyên nghiệp, truyền cảm hứng',
    personas: [
      {
        personaName: 'Linh – Điều dưỡng viên',
        age: '22-30',
        interests: 'ngành điều dưỡng tại Đức, học tiếng Đức B1/B2, cơ hội định cư',
        targetNeeds: 'lộ trình học nghề, hỗ trợ visa, cam kết việc làm sau tốt nghiệp',
        painPoints: 'rào cản tiếng Đức, thời gian đào tạo dài, chi phí ban đầu',
        toneOfVoice: 'truyền cảm hứng, chuyên nghiệp',
        recommendedTone: 'truyền cảm hứng, chuyên nghiệp',
      },
    ],
  },
  {
    domainName: 'xkld-dai-loan',
    contextDescription: 'Lao động Đài Loan (nhà máy, công xưởng, giúp việc) — chi phí thấp, đi nhanh.',
    defaultToneOfVoice: 'gần gũi, thực tế',
    personas: [
      {
        personaName: 'Tuấn – Lao động phổ thông',
        age: '25-40',
        interests: 'đơn hàng nhà máy, đi nhanh, chi phí thấp, tăng ca nhiều',
        targetNeeds: 'đơn hàng chi phí thấp, xuất cảnh nhanh, thu nhập ổn định',
        painPoints: 'cần đi sớm để lo kinh tế gia đình, ngại thủ tục phức tạp',
        toneOfVoice: 'gần gũi, thực tế, động viên',
      },
    ],
  },
];

/**
 * Seed personas idempotently. Returns a summary of how many domains were
 * upserted and how many personas were newly created vs already present.
 */
export async function seedPersonas(
  prisma: Pick<PrismaClient, 'domainContext' | 'contentPersona'>,
  seed: readonly SeedDomain[] = PERSONA_SEED,
): Promise<{ domains: number; personasCreated: number; personasSkipped: number }> {
  let personasCreated = 0;
  let personasSkipped = 0;

  for (const d of seed) {
    const domain = await prisma.domainContext.upsert({
      where: { domainName: d.domainName },
      create: {
        domainName: d.domainName,
        contextDescription: d.contextDescription,
        defaultToneOfVoice: d.defaultToneOfVoice,
      },
      update: {
        // Keep context fresh without touching personas.
        contextDescription: d.contextDescription,
        defaultToneOfVoice: d.defaultToneOfVoice,
      },
    });

    for (const p of d.personas) {
      const existing = await prisma.contentPersona.findFirst({
        where: { domainId: domain.id, personaName: p.personaName },
        select: { id: true },
      });
      if (existing) {
        personasSkipped += 1;
        continue;
      }
      await prisma.contentPersona.create({
        data: {
          domainId: domain.id,
          personaName: p.personaName,
          age: p.age,
          interests: p.interests,
          targetNeeds: p.targetNeeds,
          painPoints: p.painPoints,
          toneOfVoice: p.toneOfVoice,
          recommendedTone: p.recommendedTone ?? null,
        },
      });
      personasCreated += 1;
    }
  }

  return { domains: seed.length, personasCreated, personasSkipped };
}

/** CLI entrypoint: connect with the ambient DATABASE_URL and seed. */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const summary = await seedPersonas(prisma);
    // eslint-disable-next-line no-console
    console.log(
      `Persona seed complete: ${summary.domains} domain(s), ` +
        `${summary.personasCreated} persona(s) created, ${summary.personasSkipped} already present.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly (not when imported by tests).
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Persona seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
