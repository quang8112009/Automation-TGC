/**
 * Lead creation validation + webhook attribution pure logic (Lead Management Req 1, 9, 10, 11).
 */
export type LeadSource = 'facebook_leadgen' | 'website_form' | 'tiktok_bio' | 'direct_message';
export type LeadPlatform = 'facebook' | 'tiktok' | 'website';

export const LEAD_SOURCES: readonly LeadSource[] = ['facebook_leadgen', 'website_form', 'tiktok_bio', 'direct_message'];
export const LEAD_PLATFORMS: readonly LeadPlatform[] = ['facebook', 'tiktok', 'website'];
export const UNATTRIBUTED = 'unattributed';

export interface CreateLeadInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  source?: string;
  platform?: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  contentPostId?: string | null;
  domainCategory?: string | null;
  contentTopic?: string | null;
}

export type LeadValidationResult =
  | { ok: true }
  | { ok: false; status: 400; code: string; message: string };

function blank(v: string | null | undefined): boolean {
  return v === undefined || v === null || v.trim().length === 0;
}

/**
 * Direct /api/leads creation validation (Req 1.4-1.7).
 * requireContentPostId is false for webhook ingestion (unattributed fallback handles it).
 */
export function validateCreateLead(input: CreateLeadInput, requireContentPostId = true): LeadValidationResult {
  if (blank(input.phone) && blank(input.email)) {
    return { ok: false, status: 400, code: 'CONTACT_REQUIRED', message: 'At least one of phone or email is required.' };
  }
  if (requireContentPostId && blank(input.contentPostId)) {
    return { ok: false, status: 400, code: 'CONTENT_POST_ID_REQUIRED', message: 'content_post_id is required.' };
  }
  if (!input.source || !LEAD_SOURCES.includes(input.source as LeadSource)) {
    return { ok: false, status: 400, code: 'INVALID_SOURCE', message: `Invalid source: ${String(input.source)}` };
  }
  if (!input.platform || !LEAD_PLATFORMS.includes(input.platform as LeadPlatform)) {
    return { ok: false, status: 400, code: 'INVALID_PLATFORM', message: `Invalid platform: ${String(input.platform)}` };
  }
  return { ok: true };
}

export interface Attribution {
  source: LeadSource;
  platform: LeadPlatform;
  contentPostId: string;
  unattributed: boolean;
}

/** Facebook Leadgen attribution (Req 9). */
export function resolveFacebookAttribution(contentPostId?: string | null): Attribution {
  const resolvable = !blank(contentPostId);
  return {
    source: 'facebook_leadgen',
    platform: 'facebook',
    contentPostId: resolvable ? (contentPostId as string) : UNATTRIBUTED,
    unattributed: !resolvable,
  };
}

/** Website form attribution incl. tiktok_bio via UTM (Req 10, 11). */
export function resolveWebsiteAttribution(utmSource?: string | null, contentPostId?: string | null): Attribution {
  const resolvable = !blank(contentPostId);
  const source: LeadSource = utmSource === 'tiktok_bio' ? 'tiktok_bio' : 'website_form';
  return {
    source,
    platform: 'website',
    contentPostId: resolvable ? (contentPostId as string) : UNATTRIBUTED,
    unattributed: !resolvable,
  };
}

/** Date-range validation shared by list/stats/export (Req 2.7, 7.4, 8.4). */
export function validateDateRange(from?: string, to?: string): LeadValidationResult {
  if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
    return { ok: false, status: 400, code: 'INVALID_DATE_RANGE', message: 'date range is invalid' };
  }
  return { ok: true };
}

/**
 * Webhook body parsers (Lead Management Req 9.4, 10.6).
 *
 * Pure, additive helpers supporting the Webhook_Ingestor parse step: a verified
 * body must be a JSON object in the expected shape, otherwise it is unparseable
 * and the ingestor rejects with 400 and creates no Lead. They normalize the
 * Facebook Leadgen / CMS form payloads into a common field set consumed by the
 * Attribution_Resolver + Lead_Service.createFromWebhook.
 */
export interface ParsedWebhookLead {
  name: string | null;
  phone: string | null;
  email: string | null;
  contentPostId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  domainCategory: string | null;
  contentTopic: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStrOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Parse a verified Facebook Leadgen body; null when unparseable (Req 9.4). */
export function parseFacebookLeadgen(raw: unknown): ParsedWebhookLead | null {
  if (!isPlainObject(raw)) return null;
  const fields: Record<string, string> = {};
  const fd = raw.field_data;
  if (Array.isArray(fd)) {
    for (const item of fd) {
      if (isPlainObject(item) && typeof item.name === 'string' && Array.isArray(item.values)) {
        const val = item.values.find((x) => typeof x === 'string');
        if (typeof val === 'string') fields[item.name] = val;
      }
    }
  }
  return {
    name: fields.full_name ?? fields.name ?? asStrOrNull(raw.name),
    phone: fields.phone_number ?? fields.phone ?? asStrOrNull(raw.phone),
    email: fields.email ?? asStrOrNull(raw.email),
    contentPostId:
      asStrOrNull(raw.content_post_id) ?? asStrOrNull(raw.ad_id) ?? asStrOrNull(raw.campaign_id),
    utmSource: asStrOrNull(raw.utm_source),
    utmMedium: asStrOrNull(raw.utm_medium),
    utmCampaign: asStrOrNull(raw.utm_campaign),
    domainCategory: asStrOrNull(raw.domain_category),
    contentTopic: asStrOrNull(raw.content_topic),
  };
}

/** Parse a verified CMS website-form body; null when unparseable (Req 10.6). */
export function parseWebsiteForm(raw: unknown): ParsedWebhookLead | null {
  if (!isPlainObject(raw)) return null;
  return {
    name: asStrOrNull(raw.name),
    phone: asStrOrNull(raw.phone),
    email: asStrOrNull(raw.email),
    contentPostId: asStrOrNull(raw.content_post_id),
    utmSource: asStrOrNull(raw.utm_source),
    utmMedium: asStrOrNull(raw.utm_medium),
    utmCampaign: asStrOrNull(raw.utm_campaign),
    domainCategory: asStrOrNull(raw.domain_category),
    contentTopic: asStrOrNull(raw.content_topic),
  };
}
