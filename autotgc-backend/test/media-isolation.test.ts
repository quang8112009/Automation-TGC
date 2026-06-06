/**
 * Media isolation unit tests — Task 4.3 (deepseek-v4-model-migration).
 *
 * Proves the DeepSeek text migration does NOT touch the media (image/video)
 * route, and vice-versa (Requirement 4):
 *  - R4.1 the AI text Config_Parser reads ONLY GEMINI_BASE_URL/GEMINI_MODEL/
 *         GEMINI_TIMEOUT_MS — never the media keys (the image/video env group).
 *  - R4.2 the media provider is built from its own keys regardless of the AI
 *         text (DeepSeek) configuration.
 *  - R4.3 NEITHER modality configured → createMediaRenderProvider returns
 *         undefined (assets stay SPEC_READY; no images endpoint call).
 *  - R4.4 exactly ONE modality configured → a provider is still built.
 *
 * No real network/DB is touched: the providers are only constructed, never
 * invoked.
 */
import { describe, it, expect } from 'vitest';
import { createSecretLoader } from '../src/infra/secrets';
import { parseAiTextConfigFromSecrets, AI_TEXT_DEFAULT_MODEL } from '../src/infra/aiTextConfig';
import {
  createMediaRenderProvider,
  MediaRenderProvider,
} from '../src/marketing/assets/providers/mediaRenderProvider';

const MEDIA_ONLY = {
  GEMINI_IMAGE_API_KEY: 'img-key-abcdef',
  GEMINI_IMAGE_MODEL: 'nano-banana-pro',
  GEMINI_IMAGE_BASE_URL: 'https://gateway.example/v1',
  VEO_API_KEY: 'veo-key-abcdef',
  VEO_MODEL: 'veo3.1',
  VEO_BASE_URL: 'https://gateway.example/v1',
};

describe('media isolation — AI text Config_Parser ignores media keys (R4.1)', () => {
  it('returns ok:false (invalidKey baseUrl) when only media keys are set', () => {
    // Only media keys present; the AI text base URL/model are absent. The text
    // parser must NOT borrow any media value → it fails for a missing baseUrl.
    const secrets = createSecretLoader({ ...MEDIA_ONLY });
    const parsed = parseAiTextConfigFromSecrets(secrets);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.invalidKey).toBe('baseUrl');
  });

  it('parsed AI text config never picks up image/video model or base values', () => {
    // Set ONLY the AI text base URL. Model defaults; nothing should reflect the
    // media values (which are also present here to prove they are ignored).
    const secrets = createSecretLoader({
      GEMINI_BASE_URL: 'https://api.yescale.io/v1',
      ...MEDIA_ONLY,
    });
    const parsed = parseAiTextConfigFromSecrets(secrets);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The text model defaults to deepseek-v4-flash, NOT the image/video model.
    expect(parsed.config.model).toBe(AI_TEXT_DEFAULT_MODEL);
    expect(parsed.config.model).not.toBe(MEDIA_ONLY.GEMINI_IMAGE_MODEL);
    expect(parsed.config.model).not.toBe(MEDIA_ONLY.VEO_MODEL);
    // The base URL is the AI text one, not a media base URL (same string here is
    // avoided by using a distinct YeScale host for text).
    expect(parsed.config.baseUrl).toBe('https://api.yescale.io/v1');
  });
});

describe('media provider built from its own keys, independent of AI text config (R4.2)', () => {
  it('builds a media provider regardless of the DeepSeek text config', () => {
    const withText = createSecretLoader({
      GEMINI_BASE_URL: 'https://api.yescale.io/v1',
      GEMINI_MODEL: 'deepseek-v4-flash',
      GEMINI_API_KEY: 'sk-text-key-abcdef',
      ...MEDIA_ONLY,
    });
    const withoutText = createSecretLoader({ ...MEDIA_ONLY });

    const a = createMediaRenderProvider(withText);
    const b = createMediaRenderProvider(withoutText);

    // Media provider presence depends ONLY on media keys, not the text config.
    expect(a).toBeInstanceOf(MediaRenderProvider);
    expect(b).toBeInstanceOf(MediaRenderProvider);
  });
});

describe('media-optional behavior (R4.3 / R4.4)', () => {
  it('R4.3: neither modality configured → undefined (assets stay SPEC_READY)', () => {
    const secrets = createSecretLoader({
      GEMINI_BASE_URL: 'https://api.yescale.io/v1',
      GEMINI_API_KEY: 'sk-text-key-abcdef',
      // no GEMINI_IMAGE_API_KEY, no VEO_API_KEY
    });
    expect(createMediaRenderProvider(secrets)).toBeUndefined();
  });

  it('R4.4: only image configured → provider still built', () => {
    const secrets = createSecretLoader({
      GEMINI_IMAGE_API_KEY: 'img-key-abcdef',
      GEMINI_IMAGE_BASE_URL: 'https://gateway.example/v1',
      GEMINI_IMAGE_MODEL: 'nano-banana-pro',
    });
    expect(createMediaRenderProvider(secrets)).toBeInstanceOf(MediaRenderProvider);
  });

  it('R4.4: only video configured → provider still built', () => {
    const secrets = createSecretLoader({
      VEO_API_KEY: 'veo-key-abcdef',
      VEO_BASE_URL: 'https://gateway.example/v1',
      VEO_MODEL: 'veo3.1',
    });
    expect(createMediaRenderProvider(secrets)).toBeInstanceOf(MediaRenderProvider);
  });
});
