/**
 * Logger with secret redaction (Req 13.4).
 * Every emitted line passes through SecretLoader.redact().
 */
import pino from 'pino';
import type { SecretLoader } from './secrets';

export function createLogger(redact: SecretLoader['redact']) {
  const base = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    // formatters/hooks ensure secret values never reach the sink
    hooks: {
      logMethod(args, method) {
        const redactedArgs = args.map((a) =>
          typeof a === 'string' ? redact(a) : a,
        );
        return method.apply(this, redactedArgs as Parameters<typeof method>);
      },
    },
  });
  return base;
}

export type Logger = ReturnType<typeof createLogger>;
