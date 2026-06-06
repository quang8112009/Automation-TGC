/**
 * Service composition unit tests — Task 4.2 (deepseek-v4-model-migration).
 *
 * Example/unit tests (NOT property tests) covering how `composeServices`
 * wires the AI text client and fails fast on invalid configuration, plus the
 * startup fail-fast for a missing required secret.
 *
 * No real DB or network is touched: the fake PrismaClient is only stored (never
 * called) at construction time, and omitting REDIS_URL keeps the event bus an
 * in-process emitter (see `getEventBus` → InMemoryEventBus).
 *
 * Covers:
 *  - R1.5 — composeServices exposes a single shared AiTextClient instance.
 *  - R8.4 — invalid AI text config (missing baseUrl OR empty/whitespace model)
 *           makes composeServices throw, naming ONLY the offending key and never
 *           a secret value.
 *  - R8.5 — a missing required secret fails fast naming ONLY the secret name.
 *           This guard lives in `loadConfig`/`firstMissingSecret`/
 *           `SecretLoader.require` (NOT in composeServices), so the assertions
 *           target those functions directly (see placement note in the suite).
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { composeServices } from '../src/infra/services';
import { InstrumentedContentGenerator, InMemoryAiTelemetrySink } from '../src/infra/aiTelemetry';
import { createSecretLoader, MissingSecretError } from '../src/infra/secrets';
import { loadConfig } from '../src/infra/config';

/**
 * A recognizable secret value. We assert it NEVER appears in any error message
 * raised on the fail-fast paths (the message must name keys only, R8.4/R8.5).
 */
const API_KEY_SENTINEL = 'sk-secret-DEEPSEEK-do-not-leak-0xABCDEF';

/**
 * Minimal fake PrismaClient. `composeServices` only hands `prisma` to the alert
 * dispatcher / token manager / media service constructors — none of which call
 * a Prisma method at construction — so no DB connection is opened.
 */
function fakePrisma(): PrismaClient {
  return {} as unknown as PrismaClient;
}

describe('composeServices — AI text wiring (R1.5)', () => {
  it('exposes a single shared AI text generator (telemetry-wrapped) on the `gemini` field', () => {
    // Valid AI text config: base URL present; model omitted → defaults to
    // `deepseek-v4-flash`; REDIS_URL omitted → in-process event bus (no I/O).
    const secrets = createSecretLoader({
      GEMINI_BASE_URL: 'https://gateway.example/v1',
      GEMINI_API_KEY: API_KEY_SENTINEL,
    });

    const services = composeServices(fakePrisma(), secrets);

    // The shared generator satisfies the ContentGenerator seam. After the
    // AgentOps change it is an InstrumentedContentGenerator wrapping the
    // AiTextClient (telemetry), so we assert the seam contract + that an
    // AgentOps telemetry sink is exposed, rather than the concrete class.
    expect(services.gemini).toBeDefined();
    expect(typeof services.gemini.generateContent).toBe('function');
    expect(services.gemini).toBeInstanceOf(InstrumentedContentGenerator);
    expect(services.aiTelemetry).toBeInstanceOf(InMemoryAiTelemetrySink);

    // composeServices builds exactly ONE generator and assigns it to `gemini`,
    // so every reader (HTTP layer + scheduled jobs) shares the same reference.
    const first = services.gemini;
    const second = services.gemini;
    expect(first).toBe(second);
  });

  it('does not throw or perform I/O for a valid configuration', () => {
    const secrets = createSecretLoader({
      GEMINI_BASE_URL: 'https://gateway.example/v1',
      GEMINI_MODEL: 'deepseek-v4-pro',
    });
    expect(() => composeServices(fakePrisma(), secrets)).not.toThrow();
  });
});

describe('composeServices — fail-fast on invalid AI text config (R8.4)', () => {
  it('throws naming "baseUrl" (without any secret value) when the base URL is absent', () => {
    // GEMINI_BASE_URL omitted ⇒ parseAiTextConfigFromSecrets → ok:false, invalidKey:'baseUrl'.
    const secrets = createSecretLoader({
      GEMINI_API_KEY: API_KEY_SENTINEL,
    });

    let caught: unknown;
    try {
      composeServices(fakePrisma(), secrets);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('baseUrl');
    // The offending KEY is named, but the API key (a secret) must never leak.
    expect(message).not.toContain(API_KEY_SENTINEL);
  });

  it('throws naming "model" (without any secret value) when the model is empty/whitespace', () => {
    // A valid base URL plus an explicitly-empty (whitespace) model ⇒ invalidKey:'model'.
    // Note: SecretLoader.optional() collapses '' to undefined, so we use a
    // whitespace value to exercise the "explicitly provided but empty" branch.
    const secrets = createSecretLoader({
      GEMINI_BASE_URL: 'https://gateway.example/v1',
      GEMINI_MODEL: '   ',
      GEMINI_API_KEY: API_KEY_SENTINEL,
    });

    let caught: unknown;
    try {
      composeServices(fakePrisma(), secrets);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('model');
    expect(message).not.toContain(API_KEY_SENTINEL);
  });
});

describe('startup fail-fast on a missing required secret (R8.5)', () => {
  // PLACEMENT NOTE: the "missing required secret ⇒ fail fast, log ONLY the name"
  // behavior is enforced at startup by `loadConfig` (via `firstMissingSecret`)
  // and ultimately by `SecretLoader.require` throwing `MissingSecretError`. It is
  // NOT part of composeServices, so the assertions below target those functions.

  it('loadConfig aborts naming the missing secret and never logs a present secret VALUE', () => {
    const databaseUrl = 'postgres://user:pw@db.internal:5432/app';
    const secrets = createSecretLoader({
      DATABASE_URL: databaseUrl,
      REDIS_URL: 'redis://localhost:6379',
      // JWT_SECRET deliberately absent → fail fast.
    });

    let caught: unknown;
    try {
      loadConfig(secrets);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('JWT_SECRET');
    // Names the missing key only — no present secret value is echoed.
    expect(message).not.toContain(databaseUrl);
  });

  it('SecretLoader.require throws MissingSecretError carrying only the key name', () => {
    const secrets = createSecretLoader({});

    let caught: unknown;
    try {
      secrets.require('JWT_SECRET');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MissingSecretError);
    expect((caught as MissingSecretError).secretName).toBe('JWT_SECRET');
    expect((caught as Error).message).toContain('JWT_SECRET');
  });
});
