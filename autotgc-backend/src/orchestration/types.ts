/**
 * Orchestration types (Agentic Orchestration Layer).
 *
 * A WorkflowDefinition is a declarative, ordered list of steps. Each step wraps
 * an agent invocation (or a no-op) and may declare `requiresApproval` to pause
 * the run for human review before continuing. Definitions are pure data +
 * functions so they can be built/tested without Fastify or Prisma.
 */
import type { AgentContext, AgentResult } from '../agents/agent';

/** A single ordered unit of work inside a workflow. */
export interface StepDefinition {
  /** Unique step name within the workflow (also the WorkflowStep.name). */
  name: string;
  /** Execute this step against the accumulated workflow context. */
  run(ctx: AgentContext): Promise<AgentResult>;
  /** When true, the run pauses (WAITING_APPROVAL) BEFORE running this step. */
  requiresApproval?: boolean;
}

/** A named, ordered pipeline of steps. */
export interface WorkflowDefinition {
  /** Workflow type discriminator persisted on WorkflowRun.type. */
  type: string;
  steps: StepDefinition[];
}

/** Re-export agent context/result types for definition authors' convenience. */
export type { AgentContext, AgentResult } from '../agents/agent';
