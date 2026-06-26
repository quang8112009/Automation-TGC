/**
 * ConversationService — persistence for the grounded assistant's multi-turn
 * memory (long-term across requests, short-term within the prompt window).
 *
 * Ownership is the security contract: every conversation is PRIVATE to its
 * owner `userId`. Read/append helpers re-derive ownership from the caller's
 * userId and treat a missing OR foreign conversation identically as a
 * `NotFoundError` (404), so a SALES/ADMIN user can neither read nor probe the
 * existence of another user's threads. The route layer still applies
 * `requireAuth` + `rbacGuard`; this is the second, owner-scoped line of defence.
 *
 * `recentHistory` returns a BOUNDED, chronological slice mapped to the agent
 * loop's `ChatMessage` shape, so the assistant carries recent context without
 * letting an ever-growing thread blow up the prompt.
 */
import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from './errors';
import type { ChatMessage } from './aiAgentLoop';

/** How many of the most-recent turns are loaded into the prompt window. */
export const DEFAULT_HISTORY_LIMIT = 10;
/** Hard ceiling on history turns regardless of a caller-supplied limit. */
export const HISTORY_LIMIT_CEILING = 50;
/** Max characters of the seed question used to derive a conversation title. */
const TITLE_MAX = 80;

export type StoredRole = 'USER' | 'ASSISTANT';

export interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredMessage {
  id: string;
  role: StoredRole;
  content: string;
  aiGenerated: boolean;
  createdAt: Date;
}

/** Derive a short, single-line conversation title from the first question. */
export function deriveTitle(seed: string): string {
  const oneLine = seed.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return 'Hội thoại mới';
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX)}…` : oneLine;
}

/** Clamp a requested history limit into [1, HISTORY_LIMIT_CEILING]. */
export function clampHistoryLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_HISTORY_LIMIT;
  const floored = Math.floor(raw);
  if (floored < 1) return 1;
  if (floored > HISTORY_LIMIT_CEILING) return HISTORY_LIMIT_CEILING;
  return floored;
}

export class ConversationService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Create a new, empty conversation owned by `userId`. */
  async create(userId: string, title?: string): Promise<ConversationSummary> {
    const row = await this.prisma.assistantConversation.create({
      data: { userId, title: title && title.trim().length > 0 ? title.trim() : null },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    return row;
  }

  /** List the caller's conversations, most-recently-updated first. */
  async list(userId: string): Promise<ConversationSummary[]> {
    return this.prisma.assistantConversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  /**
   * Resolve a conversation the caller OWNS, or throw 404. A foreign or missing
   * id is indistinguishable to the caller (no existence leak).
   */
  async getOwned(userId: string, conversationId: string): Promise<ConversationSummary> {
    const row = await this.prisma.assistantConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    if (!row) {
      throw new NotFoundError('Conversation not found', 'CONVERSATION_NOT_FOUND');
    }
    return row;
  }

  /** Read all messages of an owned conversation in chronological order. */
  async getMessages(userId: string, conversationId: string): Promise<StoredMessage[]> {
    await this.getOwned(userId, conversationId); // ownership gate (404 otherwise)
    const rows = await this.prisma.assistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, aiGenerated: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      role: r.role as StoredRole,
      content: r.content,
      aiGenerated: r.aiGenerated,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Append a message to an owned conversation and bump its `updatedAt`. Throws
   * 404 when the conversation is missing or not owned by the caller.
   */
  async append(
    userId: string,
    conversationId: string,
    role: StoredRole,
    content: string,
    aiGenerated: boolean,
  ): Promise<void> {
    await this.getOwned(userId, conversationId); // ownership gate
    await this.prisma.assistantMessage.create({
      data: { conversationId, role, content, aiGenerated },
    });
    await this.prisma.assistantConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  }

  /**
   * Persist ONE full turn (the user question + the assistant answer) atomically
   * and bump `updatedAt`, in a single transaction. Atomicity prevents a
   * half-written turn (a USER message with no ASSISTANT reply) that would skew
   * the history fed into later prompts. Throws 404 when the conversation is
   * missing or not owned by the caller (ownership gate runs first).
   */
  async appendTurn(
    userId: string,
    conversationId: string,
    userContent: string,
    assistantContent: string,
    assistantAiGenerated: boolean,
  ): Promise<void> {
    await this.getOwned(userId, conversationId); // ownership gate
    await this.prisma.$transaction([
      this.prisma.assistantMessage.create({
        data: { conversationId, role: 'USER', content: userContent, aiGenerated: false },
      }),
      this.prisma.assistantMessage.create({
        data: {
          conversationId,
          role: 'ASSISTANT',
          content: assistantContent,
          aiGenerated: assistantAiGenerated,
        },
      }),
      this.prisma.assistantConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      }),
    ]);
  }

  /**
   * Load the most-recent turns of an owned conversation as agent-loop
   * `ChatMessage`s (chronological), bounded by `limit`. USER → 'user',
   * ASSISTANT → 'assistant'. Returns [] for an empty thread.
   */
  async recentHistory(
    userId: string,
    conversationId: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<ChatMessage[]> {
    await this.getOwned(userId, conversationId); // ownership gate
    const take = clampHistoryLimit(limit);
    // Fetch the newest `take` rows, then restore chronological order.
    const rows = await this.prisma.assistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { role: true, content: true },
    });
    return rows
      .reverse()
      .map((r) => ({
        role: (r.role as StoredRole) === 'ASSISTANT' ? 'assistant' : 'user',
        content: r.content,
      }));
  }
}
