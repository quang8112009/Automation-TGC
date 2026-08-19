/**
 * Extend Fastify's route config type to accept governance options.
 *
 * This tells TypeScript that `config.governance` is a valid property
 * on route options, matching the runtime behavior the middleware expects.
 */
import type { RouteGovernanceOptions } from './middleware';

declare module 'fastify' {
  interface FastifyContextConfig {
    governance?: RouteGovernanceOptions;
  }
}
