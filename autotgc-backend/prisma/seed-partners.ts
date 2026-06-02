/**
 * Partners + Destination programs seed (idempotent) — gives the destination
 * matcher real "nơi đã hợp tác / nơi có thể đưa đi XKLĐ + điều kiện" to work
 * with out of the box. Re-running upserts by a natural key (partner name,
 * destination name) and never deletes edited rows.
 *
 * Run:  npm run seed:partners   (uses DATABASE_URL from the environment / .env)
 */
import { PrismaClient } from '@prisma/client';

interface SeedPartner {
  name: string;
  type: 'EMPLOYER' | 'SCHOOL' | 'BROKER' | 'SERVICE';
  country: string;
  programs: SeedProgram[];
}

interface SeedProgram {
  name: string;
  country: string;
  visaType?: string;
  minAge?: number;
  maxAge?: number;
  gender?: string;
  requiredLanguage?: string;
  minLanguageLevel?: string;
  budgetMinVndM?: number;
  budgetMaxVndM?: number;
  industries?: string[];
  conditions?: string[];
}

export const PARTNER_SEED: readonly SeedPartner[] = [
  {
    name: 'Nghiệp đoàn Kanto (Nhật Bản)',
    type: 'EMPLOYER',
    country: 'JAPAN',
    programs: [
      {
        name: 'Kỹ năng đặc định - Cơ khí (Nhật)',
        country: 'JAPAN',
        visaType: 'TOKUTEI',
        minAge: 18,
        maxAge: 35,
        gender: 'ANY',
        requiredLanguage: 'japanese',
        minLanguageLevel: 'N4',
        budgetMinVndM: 100,
        budgetMaxVndM: 160,
        industries: ['Cơ khí', 'Chế tạo'],
        conditions: ['Tốt nghiệp THPT trở lên', 'Sức khỏe loại 1-2', 'Không hình xăm lớn'],
      },
      {
        name: 'Thực tập sinh - Xây dựng (Nhật)',
        country: 'JAPAN',
        visaType: 'TRAINEE',
        minAge: 18,
        maxAge: 30,
        gender: 'MALE',
        requiredLanguage: 'japanese',
        minLanguageLevel: 'N5',
        budgetMinVndM: 120,
        budgetMaxVndM: 180,
        industries: ['Xây dựng'],
        conditions: ['Nam giới', 'Chịu được công việc ngoài trời'],
      },
    ],
  },
  {
    name: 'Trường Điều dưỡng Bayern (Đức)',
    type: 'SCHOOL',
    country: 'GERMANY',
    programs: [
      {
        name: 'Ausbildung Điều dưỡng (Đức)',
        country: 'GERMANY',
        visaType: 'GERMANY_PROGRAM',
        minAge: 18,
        maxAge: 32,
        gender: 'ANY',
        requiredLanguage: 'german',
        minLanguageLevel: 'B1',
        budgetMinVndM: 200,
        budgetMaxVndM: 300,
        industries: ['Điều dưỡng', 'Y tế'],
        conditions: ['Tốt nghiệp THPT', 'Tiếng Đức B1 trở lên', 'Cam kết học nghề 3 năm'],
      },
    ],
  },
  {
    name: 'Đối tác tuyển dụng Đài Bắc',
    type: 'EMPLOYER',
    country: 'TAIWAN',
    programs: [
      {
        name: 'Lao động nhà máy điện tử (Đài Loan)',
        country: 'TAIWAN',
        visaType: 'OTHER',
        minAge: 18,
        maxAge: 40,
        gender: 'ANY',
        requiredLanguage: '',
        minLanguageLevel: '',
        budgetMinVndM: 60,
        budgetMaxVndM: 90,
        industries: ['Điện tử', 'Nhà máy'],
        conditions: ['Sức khỏe tốt', 'Đi nhanh trong 2-3 tháng'],
      },
    ],
  },
  {
    name: 'Đại học Melbourne Pathway (Úc)',
    type: 'SCHOOL',
    country: 'AUSTRALIA',
    programs: [
      {
        name: 'Du học nghề - Hospitality (Úc)',
        country: 'AUSTRALIA',
        visaType: 'STUDENT',
        minAge: 18,
        maxAge: 35,
        gender: 'ANY',
        requiredLanguage: 'english',
        minLanguageLevel: 'IELTS5.5',
        budgetMinVndM: 350,
        budgetMaxVndM: 500,
        industries: ['Nhà hàng - Khách sạn', 'Dịch vụ'],
        conditions: ['IELTS 5.5+', 'Chứng minh tài chính', 'Mua bảo hiểm OSHC'],
      },
    ],
  },
];

export async function seedPartners(
  prisma: Pick<PrismaClient, 'partnerOrg' | 'destinationProgram'>,
  seed: readonly SeedPartner[] = PARTNER_SEED,
): Promise<{ partners: number; programsCreated: number; programsSkipped: number }> {
  let programsCreated = 0;
  let programsSkipped = 0;

  for (const p of seed) {
    const existingPartner = await prisma.partnerOrg.findFirst({
      where: { name: p.name },
      select: { id: true },
    });
    const partnerId = existingPartner
      ? existingPartner.id
      : (await prisma.partnerOrg.create({ data: { name: p.name, type: p.type, country: p.country } })).id;

    for (const prog of p.programs) {
      const existingProgram = await prisma.destinationProgram.findFirst({
        where: { name: prog.name },
        select: { id: true },
      });
      if (existingProgram) {
        programsSkipped += 1;
        continue;
      }
      await prisma.destinationProgram.create({
        data: {
          name: prog.name,
          country: prog.country,
          visaType: prog.visaType ?? '',
          partnerId,
          minAge: prog.minAge ?? null,
          maxAge: prog.maxAge ?? null,
          gender: prog.gender ?? 'ANY',
          requiredLanguage: prog.requiredLanguage ?? '',
          minLanguageLevel: prog.minLanguageLevel ?? '',
          budgetMinVndM: prog.budgetMinVndM ?? null,
          budgetMaxVndM: prog.budgetMaxVndM ?? null,
          industries: (prog.industries ?? []) as unknown as object,
          conditions: (prog.conditions ?? []) as unknown as object,
        },
      });
      programsCreated += 1;
    }
  }

  return { partners: seed.length, programsCreated, programsSkipped };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const summary = await seedPartners(prisma);
    // eslint-disable-next-line no-console
    console.log(
      `Partner seed complete: ${summary.partners} partner(s), ` +
        `${summary.programsCreated} program(s) created, ${summary.programsSkipped} already present.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Partner seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
