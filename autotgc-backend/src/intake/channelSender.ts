/**
 * MessagingChannelSender — outbound chatbot replies to Facebook Messenger and
 * Zalo OA, reusing the platform token provider + HTTP client seams already used
 * by the publishing adapters. When a channel has no configured token it degrades
 * to a no-op (the inbound flow + message log still work), exactly like the
 * publishing adapters return a clean error rather than crashing.
 *
 * Endpoint shapes (public hosts only; tokens injected via the token provider):
 *  - Facebook: POST {graph}/me/messages  { recipient:{id}, message:{text} }
 *  - Zalo OA:  POST {zalo}/message        { recipient:{user_id}, message:{text} }
 */
import { PLATFORM_BASE_URLS } from '../platforms/baseUrls';
import { createFetchHttpClient } from '../platforms/httpClient';
import type { HttpClient } from '../platforms/httpClient';
import type { PlatformTokenProvider } from '../platforms/tokenProvider';
import { isUsableTokenValue } from '../platforms/tokenProvider';
import type { PlatformId } from '../platforms/adapter';
import type { ChannelSender, IntakeChannelValue } from './intakeService';

export interface MessagingChannelSenderDeps {
  tokens: PlatformTokenProvider;
  httpClient?: HttpClient;
  facebookBaseUrl?: string;
  zaloBaseUrl?: string;
}

export class MessagingChannelSender implements ChannelSender {
  private readonly tokens: PlatformTokenProvider;
  private readonly http: HttpClient;
  private readonly fbBase: string;
  private readonly zaloBase: string;

  constructor(deps: MessagingChannelSenderDeps) {
    this.tokens = deps.tokens;
    this.http = deps.httpClient ?? createFetchHttpClient();
    this.fbBase = deps.facebookBaseUrl ?? PLATFORM_BASE_URLS.facebook;
    this.zaloBase = deps.zaloBaseUrl ?? PLATFORM_BASE_URLS.zalo;
  }

  async send(channel: IntakeChannelValue, externalUserId: string, text: string): Promise<void> {
    if (channel === 'FACEBOOK') return this.sendFacebook(externalUserId, text);
    if (channel === 'ZALO') return this.sendZalo(externalUserId, text);
    // WEBSITE / unknown: nothing to push (the reply is returned in the HTTP body).
  }

  private async sendFacebook(psid: string, text: string): Promise<void> {
    const token = this.optionalToken('facebook');
    if (!token) return; // not configured -> no-op
    await this.http.post(
      `${this.fbBase}/me/messages`,
      { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } },
      { headers: { authorization: `Bearer ${token}` }, query: { access_token: token } },
    );
  }

  private async sendZalo(userId: string, text: string): Promise<void> {
    const token = this.optionalToken('zalo');
    if (!token) return; // not configured -> no-op
    await this.http.post(
      `${this.zaloBase}/message`,
      { recipient: { user_id: userId }, message: { text } },
      { headers: { access_token: token } },
    );
  }

  /** Return a usable token or undefined (never throws — send degrades to no-op). */
  private optionalToken(platform: PlatformId): string | undefined {
    try {
      const token = this.tokens.getTokenValue(platform);
      return isUsableTokenValue(token) ? token : undefined;
    } catch {
      return undefined;
    }
  }
}
