/**
 * IntakeService — orchestrates a chatbot conversation over a messaging channel.
 *
 * It is the I/O shell around the pure `intakeFlow` engine: it loads/creates the
 * IntakeConversation, appends inbound/outbound IntakeMessage rows, advances the
 * flow, and — when the dossier is complete — promotes the collected answers into
 * a Lead (central system) so the rest of the platform (analytics, candidate
 * promotion, destination matching) can use it. Sending the outbound text back to
 * the platform is delegated to an injected `ChannelSender` so this service stays
 * testable and transport-agnostic.
 *
 * Pure decisions live in `intakeFlow`; this class only persists + emits.
 */
import type { PrismaClient } from '@prisma/client';
import type { EventBus } from '../infra/events';
import { getFlow } from './flows';
import { advance, firstStep, isComplete } from './intakeFlow';
import type { CollectedAnswers, IntakeFlow } from './intakeFlow';

export type IntakeChannelValue = 'FACEBOOK' | 'ZALO' | 'WEBSITE';

/** Transport seam: send an outbound text to a contact on a channel. */
export interface ChannelSender {
  send(channel: IntakeChannelValue, externalUserId: string, text: string): Promise<void>;
}

/** A no-op sender used when no real channel transport is wired (dev/tests). */
export const NOOP_SENDER: ChannelSender = {
  async send(): Promise<void> {
    /* intentionally does nothing */
  },
};

export interface InboundMessage {
  channel: IntakeChannelValue;
  externalUserId: string;
  text: string;
  displayName?: string;
  raw?: unknown;
}

export interface IntakeResult {
  conversationId: string;
  status: string;
  /** The outbound text the bot sent (prompt or completion), if any. */
  reply: string | null;
  completed: boolean;
  collected: CollectedAnswers;
  leadId: string | null;
}

/** Minimal conversation row shape this service relies on. */
interface ConversationRow {
  id: string;
  channel: string;
  externalUserId: string;
  flowKey: string;
  status: string;
  currentFieldKey: string | null;
  collected: unknown;
  leadId: string | null;
  candidateId: string | null;
}

export class IntakeService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sender: ChannelSender = NOOP_SENDER,
    private readonly eventBus?: EventBus,
  ) {}

  /**
   * Handle one inbound message: upsert the conversation, log it, advance the
   * flow, send the next prompt (or completion), and promote to a Lead when the
   * required dossier fields are all collected.
   */
  async handleInbound(msg: InboundMessage): Promise<IntakeResult> {
    const convo = await this.upsertConversation(msg);
    const flow = getFlow(convo.flowKey);
    const collected = this.readCollected(convo.collected);

    // Log the inbound message.
    await this.prisma.intakeMessage.create({
      data: {
        conversationId: convo.id,
        direction: 'INBOUND',
        text: msg.text,
        fieldKey: convo.currentFieldKey ?? null,
        raw: this.safeRaw(msg.raw),
      },
    });

    // A brand-new conversation with no current field: greet + ask first.
    if (!convo.currentFieldKey && Object.keys(collected).length === 0) {
      const step = firstStep(flow, collected);
      if (step.kind === 'complete') {
        return this.complete(convo, flow, collected, msg);
      }
      const reply = `${flow.greeting}\n\n${step.prompt ?? ''}`.trim();
      await this.sendOutbound(convo, msg, reply, step.fieldKey ?? null);
      await this.prisma.intakeConversation.update({
        where: { id: convo.id },
        data: { currentFieldKey: step.fieldKey ?? null, lastInboundAt: new Date() },
      });
      return {
        conversationId: convo.id,
        status: 'ACTIVE',
        reply,
        completed: false,
        collected,
        leadId: convo.leadId,
      };
    }

    // Advance the flow with this answer.
    const { collected: nextCollected, step } = advance(
      flow,
      collected,
      convo.currentFieldKey,
      msg.text,
    );

    if (step.kind === 'complete' || isComplete(flow, nextCollected)) {
      await this.prisma.intakeConversation.update({
        where: { id: convo.id },
        data: { collected: nextCollected as object, currentFieldKey: null, lastInboundAt: new Date() },
      });
      return this.complete({ ...convo, collected: nextCollected }, flow, nextCollected, msg);
    }

    // Ask the next question.
    const reply = step.prompt ?? '';
    await this.sendOutbound(convo, msg, reply, step.fieldKey ?? null);
    await this.prisma.intakeConversation.update({
      where: { id: convo.id },
      data: {
        collected: nextCollected as object,
        currentFieldKey: step.fieldKey ?? null,
        lastInboundAt: new Date(),
      },
    });

    return {
      conversationId: convo.id,
      status: 'ACTIVE',
      reply,
      completed: false,
      collected: nextCollected,
      leadId: convo.leadId,
    };
  }

  /** Read a conversation + its messages (for the consultant UI). */
  async getConversation(id: string): Promise<unknown> {
    const convo = await this.prisma.intakeConversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return convo;
  }

  /** List conversations, newest activity first (optional status filter). */
  async list(status: string | undefined, page = 1, limit = 20): Promise<unknown> {
    const where = status ? { status: status as never } : {};
    const safePage = page > 0 ? page : 1;
    const safeLimit = limit > 0 ? limit : 20;
    const [items, total] = await Promise.all([
      this.prisma.intakeConversation.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.intakeConversation.count({ where }),
    ]);
    return { items, total, page: safePage, limit: safeLimit };
  }

  // --- internals -------------------------------------------------------------

  private async upsertConversation(msg: InboundMessage): Promise<ConversationRow> {
    const existing = await this.prisma.intakeConversation.findUnique({
      where: { channel_externalUserId: { channel: msg.channel, externalUserId: msg.externalUserId } },
    });
    if (existing) return existing as unknown as ConversationRow;

    const created = await this.prisma.intakeConversation.create({
      data: {
        channel: msg.channel,
        externalUserId: msg.externalUserId,
        displayName: msg.displayName ?? null,
        status: 'ACTIVE',
        collected: {},
      },
    });
    return created as unknown as ConversationRow;
  }

  private async sendOutbound(
    convo: ConversationRow,
    msg: InboundMessage,
    text: string,
    fieldKey: string | null,
  ): Promise<void> {
    await this.prisma.intakeMessage.create({
      data: { conversationId: convo.id, direction: 'OUTBOUND', text, fieldKey },
    });
    await this.prisma.intakeConversation.update({
      where: { id: convo.id },
      data: { lastOutboundAt: new Date() },
    });
    try {
      await this.sender.send(msg.channel, msg.externalUserId, text);
    } catch {
      // Transport failure is non-fatal to the intake state; the message row is
      // already persisted and can be retried by an out-of-band worker.
    }
  }

  /** Finalize a completed dossier: persist, promote to a Lead, notify. */
  private async complete(
    convo: ConversationRow,
    flow: IntakeFlow,
    collected: CollectedAnswers,
    msg: InboundMessage,
  ): Promise<IntakeResult> {
    // Create a Lead in the central system if not already linked.
    let leadId = convo.leadId;
    if (!leadId) {
      const lead = await this.prisma.lead.create({
        data: {
          name: this.str(collected.fullName) ?? msg.displayName ?? null,
          phone: this.str(collected.phone) ?? null,
          email: this.str(collected.email) ?? null,
          source: 'chatbot',
          platform: msg.channel.toLowerCase(),
          contentPostId: 'UNATTRIBUTED',
          domainCategory: this.str(collected.desiredMarket) ?? null,
          contentTopic: this.str(collected.desiredIndustry) ?? null,
          status: 'NEW',
          note: `Intake qua ${msg.channel}. Dossier: ${JSON.stringify(collected)}`,
          unattributed: true,
        },
      });
      leadId = lead.leadId;
    }

    await this.prisma.intakeConversation.update({
      where: { id: convo.id },
      data: { status: 'COMPLETED', currentFieldKey: null, leadId, collected: collected as object },
    });

    await this.sendOutbound(convo, msg, flow.completion, null);

    if (this.eventBus) {
      try {
        await this.eventBus.publish({
          topic: 'lead',
          type: 'intake_completed',
          payload: { id: leadId, channel: msg.channel, conversationId: convo.id },
        });
      } catch {
        /* non-critical */
      }
    }

    return {
      conversationId: convo.id,
      status: 'COMPLETED',
      reply: flow.completion,
      completed: true,
      collected,
      leadId,
    };
  }

  private readCollected(value: unknown): CollectedAnswers {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as CollectedAnswers;
    }
    return {};
  }

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  }

  private safeRaw(raw: unknown): object | undefined {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as object;
    return undefined;
  }
}
