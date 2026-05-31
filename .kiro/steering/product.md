# Product

AutoTGC is an AI-driven content-marketing automation platform. It generates marketing content with Google Gemini, publishes it across social platforms on a schedule, collects performance analytics, and feeds those results back into strategy via a human-reviewed learning loop. It also captures and manages sales leads attributed to the content that produced them.

## Core capabilities

- **Content Strategy** — domain context, personas, and a content calendar that enrich AI prompts.
- **Content Generation** — AI drafts (title, body, CTA) using enriched, analytics-informed context.
- **Publishing** — scheduled, idempotent posting to platforms with retry on failure and platform token management.
- **Analytics** — periodic collection of post/page metrics and per-post performance scoring.
- **Feedback Loop** — AI pattern recognition over performance data that produces "learning insights" applied to strategy. Defaults to **REVIEW MODE**: insights require human approval before they affect strategy.
- **Lead Management** — self-built lead tracking (no external CRM) with UTM/webhook attribution back to the content post that drove each lead.
- **Operational Dashboard** — approval queue, upcoming posts, failure alerts, lead KPIs, and data-sync freshness.

## Phase 1 scope

Integrations are limited to **Facebook, TikTok, Website (custom CMS), and Google Analytics 4**. Zalo OA, YouTube, and Instagram are deferred to Phase 2+; the architecture uses an extensible platform-adapter pattern so they can be added later without redesign.

## Roles

- **ADMIN** — full read/write across all modules.
- **SALES** — read-only dashboard plus assigned-lead access only (no delete).

## Audience & language

Product and use-case documentation is primarily written in Vietnamese. Match the language of the document or surrounding context when editing docs.
