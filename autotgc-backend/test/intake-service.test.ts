/**
 * Integration test for IntakeService: a full chatbot conversation over a fake
 * channel drives the pure flow, logs messages, and promotes the completed
 * dossier into a Lead in the central system.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { IntakeService } from '../src/intake/intakeService';
import type { ChannelSender, IntakeChannelValue } from '../src/intake/intakeService';
import { XKLD_DEFAULT_FLOW } from '../src/intake/flows';

interface ConvoRow {
  id: string;
  channel: string;
  externalUserId: string;
  displayName: string | null;
  flowKey: string;
  status: string;
  currentFieldKey: string | null;
  collected: Record<string, unknown>;
  leadId: string | null;
  candidateId: string | null;
}

/** In-memory Prisma fake covering intakeConversation, intakeMessage, lead. */
function makePrisma(): { prisma: PrismaClient; leads: Array<Record<string, unknown>>; convos: ConvoRow[] } {
  const convos: ConvoRow[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const leads: Array<Record<string, unknown>> = [];
  let seq = 0;

  const prisma = {
    intakeConversation: {
      findUnique: async (args: { where: { channel_externalUserId?: { channel: string; externalUserId: string }; id?: string } }) => {
        const k = args.where.channel_externalUserId;
        if (k) return convos.find((c) => c.channel === k.channel && c.externalUserId === k.externalUserId) ?? null;
        return convos.find((c) => c.id === args.where.id) ?? null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row: ConvoRow = {
          id: `convo-${++seq}`,
          channel: args.data.channel as string,
          externalUserId: args.data.externalUserId as string,
          displayName: (args.data.displayName as string | null) ?? null,
          flowKey: (args.data.flowKey as string) ?? 'xkld_default',
          status: (args.data.status as string) ?? 'ACTIVE',
          currentFieldKey: (args.data.currentFieldKey as string | null) ?? null,
          collected: (args.data.collected as Record<string, unknown>) ?? {},
          leadId: (args.data.leadId as string | null) ?? null,
          candidateId: null,
        };
        convos.push(row);
        return row;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const c = convos.find((x) => x.id === args.where.id)!;
        Object.assign(c, args.data);
        return c;
      },
      count: async () => convos.length,
      findMany: async () => convos,
    },
    intakeMessage: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `msg-${++seq}`, ...args.data };
        messages.push(row);
        return row;
      },
    },
    lead: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { leadId: `lead-${++seq}`, ...args.data };
        leads.push(row);
        return row;
      },
    },
  } as unknown as PrismaClient;

  return { prisma, leads, convos };
}

class RecordingSender implements ChannelSender {
  sent: Array<{ channel: string; to: string; text: string }> = [];
  async send(channel: IntakeChannelValue, externalUserId: string, text: string): Promise<void> {
    this.sent.push({ channel, to: externalUserId, text });
  }
}

describe('IntakeService — full conversation', () => {
  it('greets, collects required fields, completes, and creates a Lead', async () => {
    const { prisma, leads } = makePrisma();
    const sender = new RecordingSender();
    const service = new IntakeService(prisma, sender);

    const channel: IntakeChannelValue = 'FACEBOOK';
    const user = 'psid-123';

    // 1) First inbound: greeting + first question (fullName).
    let res = await service.handleInbound({ channel, externalUserId: user, text: 'Xin chào' });
    expect(res.completed).toBe(false);
    expect(res.reply).toContain(XKLD_DEFAULT_FLOW.greeting);

    // 2) Walk through every REQUIRED field with valid answers.
    const answers: Record<string, string> = {
      fullName: 'Nguyễn Văn A',
      phone: '0901234567',
      age: '25',
      gender: 'Nam',
      desiredMarket: 'Nhật Bản',
      desiredIndustry: 'Cơ khí',
    };

    // Drive until completion: feed the answer for whatever field is being asked.
    let guard = 0;
    while (!res.completed && guard < 30) {
      guard += 1;
      // Find current field from the conversation state via a fresh inbound.
      const convoId = res.conversationId;
      const convo = (await service.getConversation(convoId)) as { currentFieldKey: string | null } | null;
      const key = convo?.currentFieldKey;
      if (!key) break;
      const value = answers[key] ?? 'skip';
      res = await service.handleInbound({ channel, externalUserId: user, text: value });
    }

    expect(res.completed).toBe(true);
    expect(res.leadId).toBeTruthy();
    expect(leads).toHaveLength(1);

    const lead = leads[0] as { name: string; phone: string; source: string; platform: string };
    expect(lead.name).toBe('Nguyễn Văn A');
    expect(lead.phone).toBe('0901234567');
    expect(lead.source).toBe('chatbot');
    expect(lead.platform).toBe('facebook');

    // The completion line was sent back over the channel.
    expect(sender.sent.some((m) => m.text === XKLD_DEFAULT_FLOW.completion)).toBe(true);
  });

  it('re-asks on an invalid phone and does not advance', async () => {
    const { prisma } = makePrisma();
    const service = new IntakeService(prisma, new RecordingSender());
    const channel: IntakeChannelValue = 'WEBSITE';
    const user = 'web-1';

    await service.handleInbound({ channel, externalUserId: user, text: 'hi' }); // greeting + fullName
    await service.handleInbound({ channel, externalUserId: user, text: 'Trần B' }); // fullName -> phone
    const res = await service.handleInbound({ channel, externalUserId: user, text: 'khong-phai-sdt' });

    expect(res.completed).toBe(false);
    // Still awaiting phone (re-asked).
    const convo = (await service.getConversation(res.conversationId)) as { currentFieldKey: string | null };
    expect(convo.currentFieldKey).toBe('phone');
  });
});
