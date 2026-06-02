/**
 * Orchestration route registration (Agentic Orchestration Layer).
 *
 * Exposes the agentic content pipeline behind the Foundation auth + RBAC
 * middleware. All routes use module 'generation':
 *   - POST /api/v1/workflows            -> start a content_pipeline run (create)
 *   - GET  /api/v1/workflows/:id        -> run + steps (read)
 *   - POST /api/v1/workflows/:id/resume -> continue after approval (status_update)
 *   - POST /api/v1/workflows/:id/cancel -> cancel a run (status_update)
 *
 * This registrar is additive: it does NOT touch routes/index.ts. The caller
 * wires it into the Fastify app and supplies the dependencies.
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JwtService } from '../auth/jwt';
import type { Action, Module } from '../auth/rbac';
import { requireAuth, rbacGuard } from '../http/authMiddleware';
import { ValidationError } from '../infra/errors';
import type { EventBus } from '../infra/events';
import type { GenerationService } from '../content/generationService';
import type { SchedulingService } from '../content/schedulingService';
import type { ContentGenerator } from '../strategy/personaService';
import { WorkflowOrchestrator } from './orchestrator';
import { buildContentPipelineWorkflow } from './contentPipelineWorkflow';

export interface OrchestrationRouteDeps {
  prisma: PrismaClient;
  jwt: JwtService;
  eventBus: EventBus;
  /** Optional; when present, the generate step produces a real draft. */
  generationService?: GenerationService;
  /** Optional; when present, the schedule step can publish-schedule a draft. */
  schedulingService?: SchedulingService;
  /** Optional Gemini seam for the EditorAgent's summary enrichment (proposal 3.4). */
  gemini?: ContentGenerator;
}

interface IdParams {
  id: string;
}

function guard(module: Module, action: Action) {
  return rbacGuard(() => ({ module, action }));
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

export function registerOrchestrationRoutes(app: FastifyInstance, deps: OrchestrationRouteDeps): void {
  const { prisma, jwt, eventBus, generationService, schedulingService, gemini } = deps;
  const auth = requireAuth({ prisma, jwt });
  const orchestrator = new WorkflowOrchestrator(prisma, eventBus);

  // Pre-register the content pipeline definition so runNext/resume can resolve it.
  orchestrator.registerDefinition(
    buildContentPipelineWorkflow({ generationService, schedulingService, gemini }),
  );

  // Start a content pipeline run.
  app.post(
    '/api/v1/workflows',
    { preHandler: [auth, guard('generation', 'create')] },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const domainName = asString(body.domainName);
      if (!domainName) {
        throw new ValidationError('domainName is required', 'WORKFLOW_DOMAIN_REQUIRED');
      }
      const personaIds = asStringArray(body.personaIds);
      const objective = asString(body.objective);
      const platforms = asStringArray(body.platforms);
      const scheduledAt = isRecordOfStrings(body.scheduledAt) ? body.scheduledAt : undefined;

      const initialContext: Record<string, unknown> = { domainName, personaIds, objective };
      if (platforms.length > 0) initialContext.platforms = platforms;
      if (scheduledAt) initialContext.scheduledAt = scheduledAt;

      const definition = buildContentPipelineWorkflow({ generationService, schedulingService, gemini });
      const run = await orchestrator.start(definition, initialContext, request.auth?.userId);
      return reply.code(201).send({ runId: run.id, status: run.status, currentStep: run.currentStep });
    },
  );

  // Get a run + its steps.
  app.get(
    '/api/v1/workflows/:id',
    { preHandler: [auth, guard('generation', 'read')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const run = await orchestrator.getRun(id);
      return reply.code(200).send(run);
    },
  );

  // Resume a run that's waiting on human approval.
  app.post(
    '/api/v1/workflows/:id/resume',
    { preHandler: [auth, guard('generation', 'status_update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const run = await orchestrator.resume(id);
      return reply.code(200).send({ runId: run.id, status: run.status, currentStep: run.currentStep });
    },
  );

  // Cancel a run.
  app.post(
    '/api/v1/workflows/:id/cancel',
    { preHandler: [auth, guard('generation', 'status_update')] },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const run = await orchestrator.cancel(id);
      return reply.code(200).send({ runId: run.id, status: run.status, currentStep: run.currentStep });
    },
  );
}
