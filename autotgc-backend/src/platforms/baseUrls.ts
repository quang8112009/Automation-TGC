/**
 * External platform base URLs (from API_Catalog §2). These are public,
 * non-secret API hosts/versions — no credentials, hosts, or IPs are encoded
 * here. Secrets/tokens are injected separately via the token provider.
 */
export const PLATFORM_BASE_URLS = {
  facebook: 'https://graph.facebook.com/v21.0',
  tiktok: 'https://open.tiktokapis.com/v2',
  ga4: 'https://analyticsdata.googleapis.com/v1beta',
  /** YouTube Data API v3 (public host; OAuth token injected separately). */
  youtube: 'https://www.googleapis.com/youtube/v3',
  /** Zalo Official Account Open API (public host; access token injected separately). */
  zalo: 'https://openapi.zalo.me/v3.0',
  /** Gemini (API_Catalog §4). */
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
} as const;
