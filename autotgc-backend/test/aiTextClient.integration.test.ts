/**
 * Opt-in integration test — Task 5.5 (deepseek-v4-model-migration).
 *
 * Exercises the REAL AiTextClient against the configured provider (DeepSeek V4
 * over the YeScale OpenAI-compatible gateway) ONLY when the gateway is
 * configured in the environment. When the env keys are absent the whole suite
 * is skipped, so CI without secrets stays green and no network call is made.
 *
 * Enable by setting (in the shell / .env, not committed):
 *   GEMINI_BASE_URL=https://api.yescale.io/v1
 *   GEMINI_MODEL=deepseek-v4-flash        (optional; parser defaults it)
 *   GEMINI_API_KEY=<secret>               (loaded via SecretLoader; never logged)
 *
 * (Validates Req 7.5 — when the provider IS configured in the test environment,
 * the consumer may use the real AI response instead of the deterministic
 * fallback.)
 */
import { describe, it, expect } from 'vitest';
import { createSecretLoader } from '../src/infra/secrets';
import { parseAiTextConfigFromSecrets } from '../src/infra/aiTextConfig';
import { AiTextClient } from '../src/infra/aiTextClient';
import { EssayWriter } from '../src/essays/essayWriter';
import type { EssayContext } from '../src/essays/types';

const hasLiveConfig =
  typeof process.env.GEMINI_BASE_URL === 'string' &&
  process.env.GEMINI_BASE_URL.trim().length > 0 &&
  typeof process.env.GEMINI_API_KEY === 'string' &&
  process.env.GEMINI_API_KEY.trim().length > 0;

// `describe.skipIf` keeps the suite as a documented no-op when unconfigured.
describe.skipIf(!hasLiveConfig)('AiTextClient live integration (opt-in)', () => {
  it('generateContent returns non-empty text from the configured provider', async () => {
    const secrets = createSecretLoader(process.env);
    const parsed = parseAiTextConfigFromSecrets(secrets);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const client = new AiTextClient(secrets.optional('GEMINI_API_KEY'), parsed.config);
    const out = await client.generateContent(
      'Trả lời ngắn gọn bằng tiếng Việt: thủ đô của Việt Nam là gì?',
    );
    expect(typeof out).toBe('string');
    expect(out.trim().length).toBeGreaterThan(0);
  }, 30_000);

  it('EssayWriter uses the real AI response (aiGenerated=true) when configured', async () => {
    const secrets = createSecretLoader(process.env);
    const parsed = parseAiTextConfigFromSecrets(secrets);
    if (!parsed.ok) return;

    const client = new AiTextClient(secrets.optional('GEMINI_API_KEY'), parsed.config);
    const writer = new EssayWriter(client);
    const ctx: EssayContext = {
      candidateName: 'Nguyen Van A',
      educationLevel: 'Cử nhân CNTT',
      programName: 'MSc Computer Science',
      programCountry: 'Germany',
      fieldOfStudy: 'AI',
    };

    const result = await writer.write(ctx, 'SOP', 'AI');
    expect(result.aiGenerated).toBe(true);
    expect(result.content.trim().length).toBeGreaterThan(0);
  }, 30_000);
});
