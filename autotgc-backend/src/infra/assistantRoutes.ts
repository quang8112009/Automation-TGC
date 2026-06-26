/**
 * Grounded-assistant routes — the HTTP surface of the reusable "grounded
 * assistant with tools" use-case, now with conversational MEMORY and SSE
 * STREAMING.
 *
 *   POST /api/v1/assistant/conversations                 -> dashboard/read  (create a thread)
 *   GET  /api/v1/assistant/conversations                 -> dashboard/read  (list own threads)
 *   GET  /api/v1/assistant/conversations/:id/messages    -> dashboard/read  (own thread only)
 *   POST /api/v1/assistant/ask                           -> dashboard/read  (buffered answer)
 *   POST /api/v1/assistant/ask/stream                    -> dashboard/read  (SSE streamed answer)
 *   POST /api/v1/assistant/knowledge/reindex             -> settings/update (ADMIN-only)
 *
 * Memory: when a request carries `conversationId`, the user's question and the
 * answer are persisted, and the recent (bounded) history is fed back into the
 * prompt so the assistant carries context across turns. Conversations are
 * PRIVATE to their owner (ConversationService enforces 404 on foreign ids).
 *
 * Retrieval: grounding is assembled by the HYBRID KnowledgeRetriever (keyword +
 * optional semantic). Both the AI text path and the embedding path are
 * AI-OPTIONAL — absent a provider the assistant returns a deterministic grounded
 * answer and retrieval degrades to keyword ranking.
 *
 * Streaming: reuses the proven SSE pattern (validate BEFORE hijack so a 400/404
 * is a normal envelope; deltas then a terminal `done`). The streamed answer is a
 * single grounded completion (no tools); on ANY streaming failure it falls back
 * to the deterministic grounded answer as `delta` + `done` (aiGenerated:false),
 * so the client always receives a usable result — never a mid-stream 502.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import { ValidationError } from './errors';
import { assertNoSecrets } from './secretGuard';
import type { ChatCompleter, ChatMessage } from './aiAgentLoop';
import { ToolRegistry } from './aiToolCalls';
import { GroundedAssistant } from './groundedAssistant';
import type { AssistantRequest } from './groundedAssistant';
import { buildKnowledgeSearchTool } from './knowledgeSearchTool';
import { KnowledgeService } from '../recruitment/knowledge/knowledgeService';
import { KnowledgeRetriever } from '../recruitment/knowledge/knowledgeRetriever';
import type { KnowledgeEntry } from '@prisma/client';
import type { Embedder } from './embeddingClient';
import { ConversationService } from './conversationService';
import { asString } from '../platforms/narrow';
import { ASSISTANT_RATE_LIMIT } from '../http/security';

/** Minimal streaming seam (AiTextClient satisfies it). */
export interface TextStreamer {
  streamContent(prompt: string, onDelta: (chunk: string) => void): Promise<string>;
}

/** Max accepted length of a user question (cost-DoS / prompt-bloat guard). */
const MAX_QUESTION_LEN = 4000;
/** Max accepted length of a conversation title. */
const MAX_TITLE_LEN = 200;
/** Max characters of each knowledge entry included in the grounding context. */
const GROUNDING_SNIPPET_MAX = 500;

export interface AssistantRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /**
   * Pre-built ChatCompleter (DeepSeek) from composeServices, or `undefined`
   * when AI text is not configured — the assistant then runs the deterministic
   * fallback path (still tool-governed).
   */
  completer?: ChatCompleter;
  /**
   * Optional streaming text client (DeepSeek) for the SSE endpoint. `undefined`
   * when AI text is not configured — the stream then emits the deterministic
   * fallback answer.
   */
  streamer?: TextStreamer;
  /**
   * Optional embedder enabling hybrid semantic retrieval. `undefined` → keyword
   * retrieval only (default).
   */
  embedder?: Embedder;
}

/** Narrow an unknown request body to a non-empty, bounded `question` (400 on failure). */
function readQuestion(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body is required', 'ASSISTANT_BODY_REQUIRED');
  }
  const q = (body as Record<string, unknown>).question;
  if (typeof q !== 'string' || q.trim().length === 0) {
    throw new ValidationError('A non-empty "question" is required', 'ASSISTANT_QUESTION_REQUIRED');
  }
  const trimmed = q.trim();
  if (trimmed.length > MAX_QUESTION_LEN) {
    throw new ValidationError(
      `Question exceeds the ${MAX_QUESTION_LEN}-character limit`,
      'ASSISTANT_QUESTION_TOO_LONG',
    );
  }
  return trimmed;
}

/** Optional, bounded conversation title (undefined when absent/blank). */
function readTitle(body: unknown): string | undefined {
  const raw = asString((body as Record<string, unknown> | null)?.title);
  if (raw === undefined) return undefined;
  if (raw.length > MAX_TITLE_LEN) {
    throw new ValidationError(
      `Title exceeds the ${MAX_TITLE_LEN}-character limit`,
      'ASSISTANT_TITLE_TOO_LONG',
    );
  }
  return raw;
}

/** Optional conversation id from a body (undefined when absent/blank). */
function readConversationId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  return asString((body as Record<string, unknown>).conversationId);
}

/** Default role/policy framing for the general grounded assistant. */
const SYSTEM_PROMPT =
  'Bạn là trợ lý AI nội bộ của AutoTGC. Chỉ trả lời dựa trên ngữ cảnh được cung cấp và ' +
  'kết quả công cụ; không bịa thông tin. Nếu thiếu dữ kiện, hãy nói rõ là chưa đủ dữ liệu.';

/**
 * Assemble a single grounded prompt for the STREAMING path (which has no tool
 * loop). Pure & exported for testing. Lays out: policy → grounding → bounded
 * history → current question, in Vietnamese section headers.
 */
export function buildAssistantPrompt(
  systemPrompt: string,
  groundingContext: string,
  history: readonly ChatMessage[],
  question: string,
): string {
  const parts: string[] = [systemPrompt, '', '[Ngữ cảnh nền]', groundingContext];
  if (history.length > 0) {
    parts.push('', '[Lịch sử hội thoại]');
    for (const m of history) {
      const who = m.role === 'assistant' ? 'Trợ lý' : 'Người dùng';
      parts.push(`${who}: ${m.content}`);
    }
  }
  parts.push('', `Người dùng: ${question}`, 'Trợ lý:');
  const prompt = parts.join('\n');
  assertNoSecrets(prompt, 'ASSISTANT_PROMPT_SECRET_DETECTED');
  return prompt;
}

export async function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDeps): Promise<void> {
  const { prisma, jwt, completer, streamer, embedder } = deps;
  const auth = requireAuth({ prisma, jwt });
  const readGuard = rbacGuard(() => ({ module: 'dashboard', action: 'read' }));
  // Reindex recomputes embeddings (provider cost + rewrites all rows): ADMIN-only.
  // `settings/update` is denied to SALES by the RBAC policy, so this is ADMIN-gated.
  const adminGuard = rbacGuard(() => ({ module: 'settings', action: 'update' }));
  // Per-route rate limit for the cost-heavy AI endpoints (embedding + LLM).
  const aiRateLimit = { rateLimit: ASSISTANT_RATE_LIMIT };

  const knowledge = new KnowledgeService(prisma);
  const retriever = new KnowledgeRetriever(knowledge, embedder);
  const conversations = new ConversationService(prisma);

  // Governed allow-list: only the read-only knowledge_search tool is offered.
  const registry = new ToolRegistry().register(buildKnowledgeSearchTool(knowledge));

  /**
   * Assemble grounding for a question via the hybrid retriever. Returns the
   * ranked hits AND the rendered context text (each entry truncated to
   * GROUNDING_SNIPPET_MAX so one long entry cannot bloat the prompt / latency).
   * `hits.length` is the authoritative "has grounding" signal — callers must NOT
   * sniff the text string.
   */
  const buildGrounding = async (
    question: string,
  ): Promise<{ hits: KnowledgeEntry[]; text: string }> => {
    const hits = await retriever.retrieve(question, 5);
    if (hits.length === 0) {
      return { hits, text: 'Không tìm thấy tri thức nền liên quan.' };
    }
    const text = hits
      .map((h, i) => {
        const content =
          h.content.length > GROUNDING_SNIPPET_MAX
            ? `${h.content.slice(0, GROUNDING_SNIPPET_MAX)}…`
            : h.content;
        return `(${i + 1}) [${h.category}] ${h.title}: ${content}`;
      })
      .join('\n');
    return { hits, text };
  };

  /** Deterministic fallback builder shared by buffered + streamed paths. */
  const makeFallback =
    (hasHits: boolean) =>
    (req: AssistantRequest): string =>
      hasHits
        ? `Dựa trên tri thức nền hiện có:\n${req.groundingContext}`
        : 'Hiện chưa có đủ dữ liệu nền để trả lời câu hỏi này. Vui lòng bổ sung thông tin hoặc liên hệ chuyên viên.';

  // --- Conversation memory CRUD ----------------------------------------------

  // POST /api/v1/assistant/conversations  — create a new thread for the caller.
  app.post('/api/v1/assistant/conversations', { preHandler: [auth, readGuard] }, async (request, reply) => {
    const { userId } = getAuth(request);
    const title = readTitle(request.body);
    const summary = await conversations.create(userId, title);
    return reply.code(201).send(summary);
  });

  // GET /api/v1/assistant/conversations  — list the caller's threads.
  app.get('/api/v1/assistant/conversations', { preHandler: [auth, readGuard] }, async (request, reply) => {
    const { userId } = getAuth(request);
    const list = await conversations.list(userId);
    return reply.code(200).send({ conversations: list });
  });

  // GET /api/v1/assistant/conversations/:id/messages  — own thread only (404 otherwise).
  app.get(
    '/api/v1/assistant/conversations/:id/messages',
    { preHandler: [auth, readGuard] },
    async (request, reply) => {
      const { userId } = getAuth(request);
      const id = (request.params as { id: string }).id;
      const messages = await conversations.getMessages(userId, id);
      return reply.code(200).send({ messages });
    },
  );

  // --- Buffered grounded answer (tool-using agent loop) ----------------------

  // POST /api/v1/assistant/ask  — optional `conversationId` enables memory.
  app.post('/api/v1/assistant/ask', { preHandler: [auth, readGuard], config: aiRateLimit }, async (request, reply) => {
    const { userId } = getAuth(request);
    const question = readQuestion(request.body);
    const conversationId = readConversationId(request.body);

    // Resolve history (ownership-gated, 404 on foreign id) and grounding in
    // PARALLEL — they are independent and each does I/O, so this trims latency.
    const [history, grounding] = await Promise.all([
      conversationId
        ? conversations.recentHistory(userId, conversationId)
        : Promise.resolve<ChatMessage[]>([]),
      buildGrounding(question),
    ]);
    const hasHits = grounding.hits.length > 0;

    const assistantRequest: AssistantRequest = {
      systemPrompt: SYSTEM_PROMPT,
      groundingContext: grounding.text,
      userMessage: question,
      history,
    };

    const assistant = new GroundedAssistant(completer, registry, makeFallback(hasHits), {
      maxIterations: 4,
    });
    const result = await assistant.run(assistantRequest);

    // Persist the turn atomically (user + assistant) when a conversation is in play.
    if (conversationId) {
      await conversations.appendTurn(userId, conversationId, question, result.answer, result.aiGenerated);
    }

    return reply.code(200).send({ ...result, conversationId: conversationId ?? null });
  });

  // --- Streaming grounded answer (SSE) ---------------------------------------

  // POST /api/v1/assistant/ask/stream
  app.post('/api/v1/assistant/ask/stream', { preHandler: [auth, readGuard], config: aiRateLimit }, async (request, reply) => {
    const { userId } = getAuth(request);
    // Validate + ownership/history/grounding resolve BEFORE hijack so 400/404 are
    // normal envelopes via the global error handler (not SSE frames). History +
    // grounding run in PARALLEL (independent I/O) to trim time-to-first-token.
    const question = readQuestion(request.body);
    const conversationId = readConversationId(request.body);
    const [history, grounding] = await Promise.all([
      conversationId
        ? conversations.recentHistory(userId, conversationId)
        : Promise.resolve<ChatMessage[]>([]),
      buildGrounding(question),
    ]);
    const hasHits = grounding.hits.length > 0;
    const groundingContext = grounding.text;
    const fallbackText = makeFallback(hasHits)({
      systemPrompt: SYSTEM_PROMPT,
      groundingContext,
      userMessage: question,
    });

    // Switch into SSE mode.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write(': connected\n\n');

    let clientGone = false;
    raw.on('close', () => {
      clientGone = true;
    });
    const send = (event: string, data: unknown): void => {
      if (clientGone || raw.writableEnded) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let answer = '';
    let aiGenerated = false;
    try {
      if (!streamer) throw new Error('NO_STREAMER');
      const prompt = buildAssistantPrompt(SYSTEM_PROMPT, groundingContext, history, question);
      answer = await streamer.streamContent(prompt, (chunk) => send('delta', { text: chunk }));
      aiGenerated = answer.trim().length > 0;
      if (!aiGenerated) {
        // Empty AI answer → deterministic fallback as a single delta.
        answer = fallbackText;
        send('delta', { text: answer });
      }
    } catch {
      // AI-OPTIONAL: any failure (unconfigured, network, parse) → stream the
      // deterministic grounded fallback so the client still gets an answer.
      answer = fallbackText;
      aiGenerated = false;
      send('delta', { text: answer });
    }

    // Persist the turn atomically when a conversation is in play (best-effort; a
    // failure here must not break the already-streamed response).
    if (conversationId) {
      try {
        await conversations.appendTurn(userId, conversationId, question, answer, aiGenerated);
      } catch {
        // swallow — the answer was already delivered to the client.
      }
    }

    send('done', { aiGenerated, conversationId: conversationId ?? null });
    if (!raw.writableEnded) raw.end();
  });

  // --- Knowledge reindex (ADMIN-only) ----------------------------------------

  // POST /api/v1/assistant/knowledge/reindex  — recompute semantic embeddings.
  app.post('/api/v1/assistant/knowledge/reindex', { preHandler: [auth, adminGuard], config: aiRateLimit }, async (_request, reply) => {
    const result = await retriever.reindex();
    return reply.code(200).send({ ...result, embedderConfigured: embedder !== undefined });
  });
}
