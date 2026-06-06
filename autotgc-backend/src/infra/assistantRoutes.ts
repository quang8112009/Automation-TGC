/**
 * Grounded-assistant route — the HTTP surface of the reusable
 * "grounded assistant with tools" use-case. ADMIN + SALES may ask grounded
 * questions; the engine is AI-OPTIONAL (deterministic fallback when DeepSeek is
 * unconfigured or fails) and tool use is governed by the allow-list registry.
 *
 *   POST /api/v1/assistant/ask   -> dashboard/read (ADMIN + SALES)
 *     body: { question: string }
 *     200:  { answer, aiGenerated, iterations, toolResults, fallbackReason? }
 *
 * Wiring is self-contained (mirrors jobs.ts): the AI text config is parsed from
 * the SecretLoader and a `ChatCompleter` is built ONLY when configured; the
 * KnowledgeService powers both the grounding context and a read-only
 * knowledge_search tool. Telemetry is intentionally orthogonal — this engine
 * uses the agent loop, not the single-shot client.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import { requireAuth, rbacGuard, getAuth } from '../http/authMiddleware';
import { ValidationError } from './errors';
import type { ChatCompleter } from './aiAgentLoop';
import { ToolRegistry } from './aiToolCalls';
import { GroundedAssistant } from './groundedAssistant';
import type { AssistantRequest } from './groundedAssistant';
import { buildKnowledgeSearchTool } from './knowledgeSearchTool';
import { KnowledgeService } from '../recruitment/knowledge/knowledgeService';

export interface AssistantRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  /**
   * Pre-built ChatCompleter (DeepSeek) from composeServices, or `undefined`
   * when AI text is not configured — in which case the assistant runs the
   * deterministic fallback path.
   */
  completer?: ChatCompleter;
}

/** Narrow an unknown request body to the { question } shape (400 on failure). */
function readQuestion(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request body is required', 'ASSISTANT_BODY_REQUIRED');
  }
  const q = (body as Record<string, unknown>).question;
  if (typeof q !== 'string' || q.trim().length === 0) {
    throw new ValidationError('A non-empty "question" is required', 'ASSISTANT_QUESTION_REQUIRED');
  }
  return q.trim();
}

/** Default role/policy framing for the general grounded assistant. */
const SYSTEM_PROMPT =
  'Bạn là trợ lý AI nội bộ của AutoTGC. Chỉ trả lời dựa trên ngữ cảnh được cung cấp và ' +
  'kết quả công cụ; không bịa thông tin. Nếu thiếu dữ kiện, hãy nói rõ là chưa đủ dữ liệu.';

export async function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDeps): Promise<void> {
  const { prisma, jwt, completer } = deps;
  const auth = requireAuth({ prisma, jwt });
  const readGuard = rbacGuard(() => ({ module: 'dashboard', action: 'read' }));

  const knowledge = new KnowledgeService(prisma);

  // Governed allow-list: only the read-only knowledge_search tool is offered.
  const registry = new ToolRegistry().register(buildKnowledgeSearchTool(knowledge));

  // POST /api/v1/assistant/ask
  app.post('/api/v1/assistant/ask', { preHandler: [auth, readGuard] }, async (request, reply) => {
    getAuth(request); // ensure authenticated principal (defensive)
    const question = readQuestion(request.body);

    // Assemble grounding context deterministically from the KnowledgeBase.
    const hits = await knowledge.search(question, 5);
    const groundingContext =
      hits.length > 0
        ? hits.map((h, i) => `(${i + 1}) [${h.category}] ${h.title}: ${h.content}`).join('\n')
        : 'Không tìm thấy tri thức nền liên quan.';

    const assistantRequest: AssistantRequest = {
      systemPrompt: SYSTEM_PROMPT,
      groundingContext,
      userMessage: question,
    };

    // Deterministic fallback: summarize the grounded hits (or say there is none).
    const fallback = (req: AssistantRequest): string =>
      hits.length > 0
        ? `Dựa trên tri thức nền hiện có:\n${req.groundingContext}`
        : 'Hiện chưa có đủ dữ liệu nền để trả lời câu hỏi này. Vui lòng bổ sung thông tin hoặc liên hệ chuyên viên.';

    const assistant = new GroundedAssistant(completer, registry, fallback, { maxIterations: 4 });
    const result = await assistant.run(assistantRequest);

    return reply.code(200).send(result);
  });
}
