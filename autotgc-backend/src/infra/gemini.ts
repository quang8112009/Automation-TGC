/**
 * GeminiClient — text generator over an OpenAI-COMPATIBLE chat gateway.
 *
 * The whole system now targets the YeScale gateway, which is OpenAI-compatible
 * (NOT Google-native): it authenticates with `Authorization: Bearer <key>` and
 * exposes `POST {baseUrl}/chat/completions` taking `{model, messages:[...]}` and
 * returning the OpenAI shape `{choices:[{message:{content}}]}`.
 *
 * CONFIG NOTE: for an OpenAI-compatible gateway, `GEMINI_BASE_URL` MUST be the
 * gateway's `/v1` base (e.g. the YeScale `/v1` host) — composeServices passes
 * it through. No vendor host is hardcoded in app logic; the caller controls the
 * base URL. The `PLATFORM_BASE_URLS.gemini` default is only a last-resort
 * fallback for the constructor; the request path is ALWAYS `${baseUrl}/chat/
 * completions` regardless, which is correct for the gateway.
 *
 * The API key is read from config and never logged. When the key is absent the
 * client fails fast with a 502 AI_NOT_CONFIGURED rather than calling the API.
 * HTTP is injected for testing.
 */
import { AppError } from './errors';
import { PLATFORM_BASE_URLS } from '../platforms/baseUrls';
import { createFetchHttpClient } from '../platforms/httpClient';
import type { HttpClient } from '../platforms/httpClient';
import { asString, isRecord, readPath } from '../platforms/narrow';

export class GeminiClient {
  private readonly http: HttpClient;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    httpClient?: HttpClient,
    baseUrl: string = PLATFORM_BASE_URLS.gemini,
  ) {
    this.http = httpClient ?? createFetchHttpClient();
    this.baseUrl = baseUrl;
  }

  /** Generate text for a prompt. Throws 502 if the AI service is not configured. */
  async generateContent(prompt: string): Promise<string> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new AppError(502, 'AI not configured', 'AI_NOT_CONFIGURED');
    }

    let res;
    try {
      res = await this.http.post(
        `${this.baseUrl}/chat/completions`,
        { model: this.model, messages: [{ role: 'user', content: prompt }] },
        { headers: { authorization: `Bearer ${this.apiKey}` } },
      );
    } catch {
      throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
    }
    if (!res.ok) {
      throw new AppError(502, 'AI request failed', 'AI_REQUEST_FAILED');
    }

    const text = this.extractText(res.body);
    if (text === undefined) {
      throw new AppError(502, 'AI returned no content', 'AI_BAD_RESPONSE');
    }
    return text;
  }

  /** Extract the assistant message content from the OpenAI chat-completions shape. */
  private extractText(body: unknown): string | undefined {
    // Primary: choices[0].message.content is a plain string.
    const content = readPath(body, 'choices.0.message.content');
    const asStr = asString(content);
    if (asStr !== undefined) return asStr;

    // Tolerant: some gateways return content as an array of {type,text} parts.
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const part of content) {
        if (isRecord(part)) {
          const t = asString(part.text);
          if (t) texts.push(t);
        }
      }
      if (texts.length > 0) return texts.join('');
    }

    return undefined;
  }
}
