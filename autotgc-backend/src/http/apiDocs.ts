/**
 * OpenAPI 3 specification + Swagger UI.
 *
 * `@fastify/swagger` generates the spec automatically from the schemas attached
 * to registered routes (dynamic mode). `@fastify/swagger-ui` serves the
 * interactive docs at `/docs`.
 *
 * For `/docs` to be reachable without a token, the route prefix must be present
 * in the auth middleware's public-path allowance; the caller wires that up.
 */
import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

/** Public route prefix where the Swagger UI is mounted. */
export const DOCS_ROUTE_PREFIX = '/docs';

export async function registerApiDocs(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    mode: 'dynamic',
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'AutoTGC API',
        version: '1.0.0',
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: DOCS_ROUTE_PREFIX,
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
  });
}
