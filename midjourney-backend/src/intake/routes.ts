/**
 * Intake routes — messaging webhooks (Facebook Messenger + Zalo OA) and the
 * authenticated consultant views over conversations.
 *
 * Webhooks are PUBLIC paths (the platforms call them) but security-gated:
 *  - Facebook: GET verify (hub.challenge) + POST with X-Hub-Signature-256 HMAC
 *    verified against the configured app secret BEFORE the body is parsed.
 *  - Zalo: POST with an X-ZEvent-Signature / mac verified against the OA secret.
 * Raw-body capture + constant-time verify mirror the lead webhook in
 * routes/index.ts. Inbound messages drive the pure intake flow via IntakeService.
 *
 * The consultant endpoints (list/get conversations) sit behind requireAuth +
 * rbacGuard (lead_management/read) so ADMIN and SALES can view intake threads.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import type { AppConfig } from '../infra/config';
import type { EventBus } from '../infra/events';
import { requireAuth, rbacGuard } from '../http/authMiddleware';
import type { RbacAuditor } from '../http/authMiddleware';
import { verifySignature } from '../infra/hmac';
import { recordWebhookDelivery } from '../infra/webhookReplay';
import { IntakeService, NOOP_SENDER } from './intakeService';
import { governanceRoute } from '../governance/middleware';
import type { ChannelSender, IntakeChannelValue, InboundMessage } from './intakeService';
import { INTAKE_PUBLIC_PATHS } from './publicPaths';

export { INTAKE_PUBLIC_PATHS };

export interface IntakeRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  config: AppConfig;
  eventBus?: EventBus;
  /** Outbound transport; defaults to a no-op when no messaging tokens are wired. */
  sender?: ChannelSender;
  /** Optional best-effort sink for denied authorization decisions (Req 7.2,
   * 7.3); threaded into every rbacGuard so each 403 appends one AUTHZ_DENIED. */
  auditor?: RbacAuditor;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Extract inbound messaging events from a Facebook Messenger webhook payload. */
export function parseFacebookMessaging(payload: unknown): Array<{ senderId: string; text: string }> {
  const out: Array<{ senderId: string; text: string }> = [];
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const messaging = (entry as { messaging?: unknown }).messaging;
    if (!Array.isArray(messaging)) continue;
    for (const m of messaging) {
      const senderId = asString((m as { sender?: { id?: unknown } }).sender?.id);
      const text = asString((m as { message?: { text?: unknown } }).message?.text);
      if (senderId && text) out.push({ senderId, text });
    }
  }
  return out;
}

/** Extract a single inbound message from a Zalo OA webhook payload. */
export function parseZaloMessage(payload: unknown): { senderId: string; text: string } | null {
  const p = payload as { sender?: { id?: unknown }; message?: { text?: unknown } };
  const senderId = asString(p.sender?.id);
  const text = asString(p.message?.text);
  return senderId && text ? { senderId, text } : null;
}

export async function registerIntakeRoutes(app: FastifyInstance, deps: IntakeRouteDeps): Promise<void> {
  const { prisma, jwt, config, auditor } = deps;
  const auth = requireAuth({ prisma, jwt });
  const service = new IntakeService(prisma, deps.sender ?? NOOP_SENDER, deps.eventBus);

  const fbSecret = config.webhookSecrets.facebook ?? '';
  const zaloSecret = config.webhookSecrets.zalo ?? '';
  const fbVerifyToken = config.intakeFacebookVerifyToken ?? '';

  // ---- Webhooks (raw body + HMAC, encapsulated parser scope) ----------------
  await app.register(async (scope) => {
    const rawParser = (
      _req: FastifyRequest,
      body: Buffer,
      done: (err: Error | null, body?: unknown) => void,
    ) => done(null, body);
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawParser);
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, rawParser);

    // Facebook subscription verification handshake (GET).
    scope.get('/api/intake/webhook/facebook', async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const mode = asString(q['hub.mode']);
      const token = asString(q['hub.verify_token']);
      const challenge = asString(q['hub.challenge']);
      if (mode === 'subscribe' && token && fbVerifyToken && token === fbVerifyToken && challenge) {
        return reply.code(200).send(challenge);
      }
      return reply.code(403).send({ error: { code: 'VERIFY_FAILED', message: 'Verification failed' } });
    });

    const handleInbound = async (
      channel: IntakeChannelValue,
      messages: Array<{ senderId: string; text: string }>,
      raw: unknown,
    ): Promise<void> => {
      for (const m of messages) {
        const inbound: InboundMessage = {
          channel,
          externalUserId: m.senderId,
          text: m.text,
          raw,
        };
        await service.handleInbound(inbound);
      }
    };

    scope.post('/api/intake/webhook/facebook', async (request: FastifyRequest, reply: FastifyReply) => {
      const raw: Buffer = Buffer.isBuffer(request.body)
        ? (request.body as Buffer)
        : Buffer.from(typeof request.body === 'string' ? request.body : '', 'utf8');
      const signature = (request.headers['x-hub-signature-256'] as string | undefined) ?? '';
      // Fail CLOSED: verifySignature returns false when the secret is empty/unset,
      // so an unconfigured Facebook intake webhook rejects ALL requests (401)
      // rather than accepting forged/unsigned payloads (matches the lead webhook).
      if (!verifySignature(fbSecret, raw, signature)) {
        return reply.code(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Bad signature' } });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: { code: 'INVALID_JSON', message: 'Bad JSON' } });
      }
      // Replay protection: a valid-but-replayed delivery is a no-op 409.
      const entryId = asString((payload as { entry?: Array<{ id?: unknown }> }).entry?.[0]?.id);
      const fresh = await recordWebhookDelivery(prisma, {
        source: 'intake:facebook',
        deliveryId: entryId,
        rawBody: raw,
        signature,
      });
      if (!fresh) {
        return reply.code(409).send({ error: { code: 'WEBHOOK_REPLAY', message: 'Duplicate delivery' } });
      }
      await handleInbound('FACEBOOK', parseFacebookMessaging(payload), payload);
      // Messenger expects a fast 200 ack.
      return reply.code(200).send({ status: 'EVENT_RECEIVED' });
    });

    scope.post('/api/intake/webhook/zalo', async (request: FastifyRequest, reply: FastifyReply) => {
      const raw: Buffer = Buffer.isBuffer(request.body)
        ? (request.body as Buffer)
        : Buffer.from(typeof request.body === 'string' ? request.body : '', 'utf8');
      const signature =
        (request.headers['x-zevent-signature'] as string | undefined) ??
        (request.headers['x-signature'] as string | undefined) ??
        '';
      // Fail CLOSED: an unconfigured Zalo secret rejects ALL requests (401).
      if (!verifySignature(zaloSecret, raw, signature)) {
        return reply.code(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Bad signature' } });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: { code: 'INVALID_JSON', message: 'Bad JSON' } });
      }
      const fresh = await recordWebhookDelivery(prisma, {
        source: 'intake:zalo',
        rawBody: raw,
        signature,
      });
      if (!fresh) {
        return reply.code(409).send({ error: { code: 'WEBHOOK_REPLAY', message: 'Duplicate delivery' } });
      }
      const msg = parseZaloMessage(payload);
      await handleInbound('ZALO', msg ? [msg] : [], payload);
      return reply.code(200).send({ status: 'ok' });
    });
  });

  // ---- Consultant views (authenticated) -------------------------------------
  const readGuard = rbacGuard(() => ({ module: 'lead_management', action: 'read' }), auditor);
  // /simulate WRITES (creates a Lead/IntakeConversation), so it must require a
  // write capability — not the read scope. Under the pure RBAC policy SALES is
  // assigned-only on lead_management writes; with no resource owner here it is
  // effectively ADMIN-only, which is correct for a test/widget inject endpoint.
  const createGuard = rbacGuard(() => ({ module: 'lead_management', action: 'create' }), auditor);

  app.get(
    '/api/v1/intake/conversations',
    { ...governanceRoute({ audit: true }), preHandler: [auth, readGuard] },
    async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const page = Number(q.page) > 0 ? Number(q.page) : 1;
      const limit = Number(q.limit) > 0 ? Number(q.limit) : 20;
      const result = await service.list(asString(q.status), page, limit);
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/v1/intake/conversations/:id',
    { ...governanceRoute({ audit: true }), preHandler: [auth, readGuard] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const convo = await service.getConversation(id);
      return reply.code(200).send(convo ?? {});
    },
  );

  // Simulate an inbound message (testing / website widget): drives the same flow.
  app.post(
    '/api/v1/intake/simulate',
    { ...governanceRoute({ pii: true, audit: true }), preHandler: [auth, createGuard] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const externalUserId = asString(body.externalUserId);
      const text = asString(body.text);
      if (!externalUserId || !text) {
        return reply
          .code(400)
          .send({ error: { code: 'INTAKE_INPUT_REQUIRED', message: 'externalUserId and text are required' } });
      }
      const result = await service.handleInbound({
        channel: 'WEBSITE',
        externalUserId,
        text,
        displayName: asString(body.displayName),
      });
      return reply.code(200).send(result);
    },
  );
}
