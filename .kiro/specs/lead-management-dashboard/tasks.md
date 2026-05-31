# Implementation Plan: Lead Management & Operational Dashboard

## Overview

This plan converts the Lead Management & Operational Dashboard design into incremental, code-focused tasks for the **Node.js 20 LTS + TypeScript** stack established across the three prior Phase 1 specs (Fastify, Prisma/PostgreSQL 16, ioredis/Redis, jose, fast-check + Vitest). This is the **fourth and final** Phase 1 spec and it **builds on the earlier modules rather than rebuilding them**:

- **Foundation & Deployment** supplies the auth + RBAC middleware (ADMIN / SALES on `lead_management` and read-only on `dashboard`), the webhook HMAC verification middleware, the `Service_Accounts` (`background-worker`), the `Alert Dispatcher` + `Token_Manager` notifications channel, and the REST conventions (status-code set, `page`/`limit`/`total` pagination, central error envelope). These are assumed to exist and are wired into.
- **Content Pipeline** supplies `Content_Draft`/`Scheduled_Post` + `Content_Status` (DRAFT / SCHEDULED / FAILED incl. `TOKEN_EXPIRED`) and the `Content_Calendar`; the Dashboard reads these through their existing query surface and the `Attribution_Resolver` resolves `content_post_id` against them.
- **Analytics & Feedback Loop** supplies `Analytics_Record`/`Performance_Record`, `Learning_Insight` (PENDING_REVIEW), and the `Collection_Cycle` `Last_Sync_Time`; the Dashboard reads these, and the Analytics `Scoring_Engine` consumes this module's `Lead_Analytics_Query` lead counts to close the conversion loop.

The Dashboard is an **aggregator**: it owns no data and assembles its read models by querying the other modules' contracts. The only data this module owns is `Lead` and `Lead_History_Entry`. Component tasks wire into the existing services rather than duplicating their data.

Tasks are ordered by dependency: Prisma schema additions + migrations → the foundational `Lead_Status_Machine` → `Lead_Service` create → view/filter + detail → update + delete → stats + `Export_Builder` → the `Webhook_Ingestor` + `Attribution_Resolver` behind the reused HMAC middleware → the `Lead_Analytics_Query` in-process contract → lead route registration + RBAC → the `Dashboard_Service` overview/notifications assembler reading from the other modules → dashboard RBAC + route wiring. Each task builds on prior tasks and ends by integrating its output into the running application, leaving no orphaned code.

Property-based tests use `fast-check` with a minimum of **100 generated cases each**, run under Vitest, and every property test is tagged in the format `// Feature: lead-management-dashboard, Property {n}: {property_text}` to map **1:1 with the design's 30 Correctness Properties**. The lead repository is backed by an **in-memory fake**, the **clock is injected** (so the upcoming-posts window and data-sync staleness predicates are deterministic, including exact-boundary cases), and **cross-module reads** (Content Pipeline, Analytics, Token_Manager / Alert Dispatcher) are **mocked**. Filter composition, stats grouping, per-post and category/topic counts, and export round-trip are validated against a naive in-memory reference. Route protection, Foundation alert integration, the cross-module dashboard reads, the analytics lead-count pull, and config defaults are validated by example, integration, and smoke tests per the design's Testing Strategy.

## Tasks

- [ ] 1. Add Prisma schema and migrations for leads
  - [ ] 1.1 Define the `lead` and `lead_history_entry` models and generate the migration
    - Add the `Lead` model (`lead_id` PK; nullable `name`/`phone`/`email`; `source` enum `facebook_leadgen|website_form|tiktok_bio|direct_message`; `platform` enum `facebook|tiktok|website`; nullable `utm_source`/`utm_medium`/`utm_campaign`; `content_post_id` varchar resolved-id-or-`'unattributed'`; nullable `domain_category`/`content_topic`; `status` enum `NEW|CONTACTED|QUALIFIED|CONVERTED|LOST` defaulting to NEW; nullable `note`; nullable `assigned_to` uuid FK → Foundation `user_account`; `unattributed` boolean default false; `created_at`/`updated_at` timestamptz) to `schema.prisma` per the Data Models section, plus the `LeadSource`, `LeadPlatform`, and `LeadStatus` enums
    - Add the CHECK constraint `phone IS NOT NULL OR email IS NOT NULL` and the indexes `(source)`, `(platform)`, `(status)`, `(created_at)`, `(content_post_id)`, `(domain_category, content_topic)`, and `(assigned_to)` to back the filters, the analytics counts, and SALES scoping
    - Add the append-only `Lead_History_Entry` model (`id` uuid PK; `lead_id` FK → lead; `previous_status`/`new_status` LeadStatus; nullable `note`; nullable `assigned_to`; `actor` varchar; `changed_at` timestamptz ordering key) and grant the application role only `INSERT`/`SELECT` on it (no `UPDATE`/`DELETE`) in the migration
    - Generate the migration targeting PostgreSQL 16 and regenerate the Prisma client, reusing the Foundation Prisma datasource/client module; the `assigned_to` FK references the Foundation `user_account` and `content_post_id` references the Content Pipeline `Scheduled_Post` (no rebuild)
    - _Requirements: 1.1, 1.4, 2.2, 2.3, 2.4, 2.5, 4.4, 11.2, 12.2, 12.3, 13.6_

  - [ ]* 1.2 Write integration test for the migration, CHECK constraint, and append-only grants
    - Verify the migration applies cleanly on PostgreSQL 16, that inserting a row with both `phone` and `email` null is rejected by the CHECK constraint, and that an `UPDATE`/`DELETE` against `lead_history_entry` is rejected for the application role
    - _Requirements: 1.4, 4.4_

- [ ] 2. Implement the Lead_Status_Machine (foundational)
  - [ ] 2.1 Implement the guarded transition function
    - Implement `transition(current, target)` over the six-edge `ALLOWED_TRANSITIONS` set (`NEW→CONTACTED`, `CONTACTED→QUALIFIED`, `QUALIFIED→CONVERTED`, and `NEW|CONTACTED|QUALIFIED → LOST`), returning the new status on success and a `409` result with no change for any pair not in the set; `CONVERTED` and `LOST` are terminal (appear only as targets, never as sources)
    - Make this the single module-wide entry point for changing a `LeadStatus`, consumed by `Lead_Service.update`
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 2.2 Write property test for the lead status transition closure
    - **Property 12: Lead status transition closure**
    - Cover all 25 `(LeadStatus, LeadStatus)` pairs; assert success iff the pair is one of the six allowed edges, otherwise 409 with status and Interaction_History unchanged
    - **Validates: Requirements 4.6, 5.1, 5.2, 5.3, 5.4**

- [ ] 3. Implement Lead_Service create
  - [ ] 3.1 Implement create with validation, defaults, and best-effort UTM storage
    - Implement `create(input, actor)`: validate **before any persistence** — reject 400 if both `phone` and `email` are absent/blank (contact required), reject 400 if `content_post_id` is omitted on direct creation, reject 400 identifying the invalid value when `source`/`platform` is not in its enum
    - On success assign a unique `lead_id`, set `status = NEW`, set `created_at = now` (injected clock) and `updated_at = created_at`, and store any provided `utm_*`, `domain_category`, and `content_topic`
    - Make UTM storage **best-effort and non-blocking**: if it fails after the Lead row is persisted, complete the creation and record the UTM-storage failure rather than rolling back the Lead
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [ ]* 3.2 Write property test for lead creation invariants
    - **Property 1: Lead creation invariants**
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [ ]* 3.3 Write property test for contact-required validation
    - **Property 2: Contact-required validation**
    - **Validates: Requirements 1.4**

  - [ ]* 3.4 Write property test for required content_post_id on direct creation
    - **Property 3: Required content_post_id on direct creation**
    - **Validates: Requirements 1.5**

  - [ ]* 3.5 Write property test for source/platform enum validation
    - **Property 4: Enum validation for source and platform**
    - **Validates: Requirements 1.6, 1.7**

  - [ ]* 3.6 Write property test for attribute storage round-trip
    - **Property 5: Attribute storage round-trip**
    - **Validates: Requirements 1.8, 10.5, 12.4**

  - [ ]* 3.7 Write unit test for UTM-storage failure non-rollback
    - A UTM-storage failure after the Lead is persisted returns 201 with the Lead intact and the failure recorded, never rolled back (Req 1.9)
    - _Requirements: 1.9_

- [ ] 4. Implement Lead_Service view/filter and detail
  - [ ] 4.1 Implement list with filters, composition, date-range validation, pagination, and SALES scope
    - Implement `list(filter, page, limit, actor)` returning the Foundation `page`/`limit`/`total` contract; apply equality filters (`source`, `platform`, `status`) and the inclusive date-range predicate on `created_at` (`from`/`to`) composed as logical AND so a Lead is returned only if it satisfies every present filter
    - Reject 400 ("date range is invalid") when `from > to` **before querying**, using a shared `validateDateRange` predicate reused by stats and export
    - When `actor` is SALES, compose an implicit, non-removable `assignedTo === actor.userId` predicate that the caller cannot widen
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 13.6_

  - [ ] 4.2 Implement detail with interaction-history ordering and SALES scope
    - Implement `get(id, actor)` returning the Lead plus its `Interaction_History` ordered most-recent-first by `changed_at`; an unknown `id` → 404 with no Lead information; a SALES actor targeting a non-assigned Lead → 403 before any data is returned
    - _Requirements: 3.1, 3.2, 3.3, 13.4_

  - [ ]* 4.3 Write property test for the pagination invariant
    - **Property 6: Pagination invariant**
    - **Validates: Requirements 2.1**

  - [ ]* 4.4 Write property test for filter correctness and composition
    - **Property 7: Filter correctness and composition** (validated against a naive in-memory reference)
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6**

  - [ ]* 4.5 Write property test for interaction-history presence and ordering
    - **Property 9: Interaction-history presence and ordering**
    - **Validates: Requirements 3.1, 3.2**

- [ ] 5. Implement Lead_Service update and delete
  - [ ] 5.1 Implement update with transition guard, append-only history, and SALES scope
    - Implement `update(id, input, actor)`: load the Lead (unknown `id` → 404, nothing modified); a SALES actor on a non-assigned Lead → 403, nothing modified; when a `status` is supplied route it through the `Lead_Status_Machine` and on an illegal transition return 409 identifying the invalid transition with the status unchanged and **no history entry appended**
    - On an accepted update apply the `status`/`note`/`assignedTo` changes, advance `updated_at`, and append exactly one `Lead_History_Entry` capturing previous status, new status, note, assigned_to, acting identity, and change timestamp, leaving all prior history entries unchanged
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 13.3, 13.4_

  - [ ] 5.2 Implement delete
    - Implement `delete(id, actor)`: an ADMIN deleting an existing Lead removes it; an unknown `id` → 404 with nothing deleted; a SALES actor → 403 regardless of assignment with nothing deleted
    - _Requirements: 6.1, 6.2, 13.5_

  - [ ]* 5.3 Write property test for update field application and single history append
    - **Property 11: Update applies fields and appends exactly one history entry**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [ ]* 5.4 Write property test for not-found leaving the store unchanged
    - **Property 10: Not-found leaves store unchanged** (detail, update, and delete on an absent `lead_id`)
    - **Validates: Requirements 3.3, 4.5, 6.2**

  - [ ]* 5.5 Write property test for the delete round-trip
    - **Property 13: Delete round-trip** (a subsequent read returns 404)
    - **Validates: Requirements 6.1**

- [ ] 6. Implement Lead statistics and the Export_Builder
  - [ ] 6.1 Implement stats grouping with dimension/date validation and SALES scope
    - Implement `stats(query, actor)` returning per-group counts over the date range for a `Group_Dimension` in `{source, platform, date}` such that each in-range Lead contributes to exactly one group and group counts sum to the in-range total; reject 400 identifying the invalid dimension when `group_by` is outside the set, and reject 400 ("date range is invalid") when `from > to` via the shared validator; a SALES actor counts only assigned Leads
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 13.6_

  - [ ] 6.2 Implement the Export_Builder (CSV/xlsx) with format/date validation and SALES scope
    - Implement `export(query, actor)` producing a CSV or `xlsx` Export_File of the Leads matching the date range; reject 400 identifying the invalid format when `format` is outside `{csv, xlsx}` (no file produced) and reject 400 when `from > to`; when authenticated as SALES the file contains only Leads assigned to that Sales_Consultant
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 13.6_

  - [ ]* 6.3 Write property test for stats grouping correctness
    - **Property 14: Stats grouping correctness** (validated against a naive in-memory grouping)
    - **Validates: Requirements 7.1, 7.2**

  - [ ]* 6.4 Write property test for invalid stats dimension rejection
    - **Property 15: Invalid stats dimension rejected**
    - **Validates: Requirements 7.3**

  - [ ]* 6.5 Write property test for export round-trip and format validation
    - **Property 16: Export round-trip and format validation** (parsing the produced file yields exactly the in-range Leads)
    - **Validates: Requirements 8.1, 8.2**

  - [ ]* 6.6 Write property test for SALES scope restriction on collection operations
    - **Property 17: SALES scope restriction on collection operations** (list, stats, and export over a mixed-assignment set)
    - **Validates: Requirements 8.3, 13.6**

  - [ ]* 6.7 Write property test for date-range validation
    - **Property 8: Date-range validation** across list, stats, and export (`from > to` → 400 before querying)
    - **Validates: Requirements 2.7, 7.4, 8.4**

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement the Webhook_Ingestor and Attribution_Resolver
  - [ ] 8.1 Implement the Attribution_Resolver
    - Implement `resolveFacebook` (fixed `source = facebook_leadgen`, `platform = facebook`) and `resolveWebsite` (`platform = website`, `source = tiktok_bio` iff `utm_source === 'tiktok_bio'` otherwise `website_form`, including when `utm_source` is absent); resolve a carried content/campaign identifier to `content_post_id` against the Content Pipeline lookup
    - When no resolvable `content_post_id` is present on a verified webhook, return `contentPostId = 'unattributed'` with `unattributed = true` so the lead is never lost
    - _Requirements: 9.2, 9.5, 10.3, 10.4, 11.1, 11.2, 11.3_

  - [ ] 8.2 Implement the Webhook_Ingestor
    - Implement `ingestFacebook(raw)` and `ingestWebsite(raw)`: parse the verified body as the Facebook Leadgen format / CMS form submission, call the `Attribution_Resolver`, and create the Lead via the Task 3.1 creation rules with `status = NEW` (the `'unattributed'` marker satisfies the Req 1.5 content-id check so webhook creation never fails it); store provided `utm_*` values and the resolved `domain_category`/`content_topic`
    - An unparseable body → 400 with no Lead created; isolate failures per request so a malformed/unattributed submission never blocks subsequent submissions
    - _Requirements: 9.1, 9.3, 9.4, 10.1, 10.2, 10.5, 10.6, 11.2, 11.3, 12.1, 12.4_

  - [ ] 8.3 Wire the webhook routes behind the Foundation HMAC middleware
    - Register `POST /api/leads/webhook/facebook` and `POST /api/leads/webhook/website` behind the reused Foundation HMAC verification middleware (no JWT) so the body is parsed only after verification passes; connect them to the `Webhook_Ingestor`
    - _Requirements: 9.1, 10.1_

  - [ ]* 8.4 Write property test for webhook source and content attribution
    - **Property 18: Webhook source and content attribution** (FB → facebook_leadgen/facebook; website → website with tiktok_bio iff `utm_source='tiktok_bio'`; resolvable id stored, otherwise `'unattributed'` + `unattributed=true`; always `status=NEW`)
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.5, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 12.1**

  - [ ]* 8.5 Write property test for webhook parse rejection
    - **Property 19: Webhook parse rejection** (unparseable verified body → 400, no Lead)
    - **Validates: Requirements 9.4, 10.6**

  - [ ]* 8.6 Write integration test for the HMAC gate behind Foundation
    - A correctly signed request is processed and creates a Lead; a tampered/unsigned request returns 401 without parsing the body — exercised against the real Foundation HMAC middleware
    - _Requirements: 9.1, 10.1_

- [ ] 9. Implement the Lead_Analytics_Query (in-process contract for Analytics)
  - [ ] 9.1 Implement countByContentPost and countByCategoryAndTopic
    - Implement `countByContentPost(contentPostId)` returning the number of Leads associated with the post and **excluding `unattributed` Leads** (the conversion-rate numerator), and `countByCategoryAndTopic(from, to)` returning counts grouped by (`domain_category`, `content_topic`) over the range for the Feedback_Engine; every Lead with a resolvable `content_post_id` is associated with that post
    - Expose this as an internal, in-process contract callable by the Analytics `Scoring_Engine` (not a public route)
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [ ]* 9.2 Write property test for per-post lead-count correctness
    - **Property 20: Per-post lead-count correctness** (excludes `unattributed`)
    - **Validates: Requirements 12.2**

  - [ ]* 9.3 Write property test for category-and-topic lead-count correctness
    - **Property 21: Category-and-topic lead-count correctness** (validated against a naive in-memory grouping)
    - **Validates: Requirements 12.3**

  - [ ]* 9.4 Write integration test for the Analytics lead-count pull
    - The `background-worker`-authenticated Scoring_Engine pull of `countByContentPost` / `countByCategoryAndTopic` returns the expected counts end-to-end
    - _Requirements: 12.2, 12.3_

- [ ] 10. Register lead routes behind Foundation auth/RBAC
  - [ ] 10.1 Register `/api/leads/*` routes and bind the lead_management RBAC policy
    - Register `POST /api/leads`, `GET /api/leads`, `GET/PUT/DELETE /api/leads/{id}`, `GET /api/leads/stats`, and `GET /api/leads/export` behind the Foundation auth + RBAC middleware as protected endpoints requiring a valid Access_Token (excluding the signature-verified webhooks), with JSON-schema body/query validation; bind ADMIN → full access on every Lead, SALES → view/status-note-update on assigned Leads only (non-assigned view/update → 403) and list/stats/export restricted to assigned Leads, SALES delete → 403; deny before handler logic so denials mutate nothing
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [ ]* 10.2 Write property test for lead RBAC enforcement
    - **Property 22: Lead RBAC enforcement** (ADMIN full; SALES view/update assigned-only → non-assigned 403; SALES delete 403; every denial leaves the Lead unmodified)
    - **Validates: Requirements 13.2, 13.3, 13.4, 13.5**

  - [ ]* 10.3 Write smoke test for lead route protection
    - Every `/api/leads/*` (non-webhook) route rejects an unauthenticated request with 401
    - _Requirements: 13.1_

- [ ] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Implement the Dashboard_Service overview and notifications assembler
  - [ ] 12.1 Implement the Overview_Assembler reading from the other modules
    - Implement `overview(now, actor)` assembling the `Dashboard_Overview` from cross-module reads (mocked in tests): the KPI_Overview (View/Follow from Analytics/Performance records, Lead from the lead store), the Approval_Queue (Content_Drafts at DRAFT ∪ Learning_Insights at PENDING_REVIEW, ordered to prioritize most-recently-created / nearest-deadline), the Upcoming_Posts (Scheduled_Posts with SCHEDULED status and `now <= scheduledPublishTime <= now + 7 days`, excluding non-SCHEDULED and beyond-window posts), the Alert_Section (FAILED Scheduled_Posts with their reason incl. `TOKEN_EXPIRED`, plus Token_Manager token-expiry warnings), and the Data_Sync_Status (reports `Last_Sync_Time`; 'data not updated' warning + manual-sync suggestion iff `now - lastSyncTime > Sync_Staleness_Threshold`, current at or within the threshold; threshold read from config, default 6h)
    - If one or more source data sets cannot be read, respond 500 ("overview could not be assembled") rather than a partial overview; use the injected clock for the window and staleness predicates
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 15.1, 15.2, 16.1, 16.2, 16.3, 17.1, 17.2, 17.3, 18.1, 18.2, 18.3, 18.4_

  - [ ] 12.2 Implement the Notifications_Assembler
    - Implement `notifications(actor)` returning the ADMIN alert feed as the union of platform token-expiry warnings (from the Foundation Token_Manager / Alert Dispatcher), publish-failure alerts (a Scheduled_Post entering FAILED), and insights-pending notifications (a Learning_Insight entering PENDING_REVIEW)
    - _Requirements: 19.1, 19.2, 19.3, 19.4_

  - [ ]* 12.3 Write property test for overview completeness
    - **Property 23: Overview completeness** (all five sections present)
    - **Validates: Requirements 14.2**

  - [ ]* 12.4 Write property test for approval-queue composition
    - **Property 24: Approval-queue composition** (exactly DRAFT drafts ∪ PENDING_REVIEW insights)
    - **Validates: Requirements 15.1**

  - [ ]* 12.5 Write property test for approval-queue ordering
    - **Property 25: Approval-queue ordering** (most-recently-created / nearest-deadline first)
    - **Validates: Requirements 15.2**

  - [ ]* 12.6 Write property test for the upcoming-posts 7-day window predicate
    - **Property 26: Upcoming-posts 7-day window predicate** (injected clock; include the exact `now` and `now + 7 days` boundaries)
    - **Validates: Requirements 16.1, 16.2, 16.3**

  - [ ]* 12.7 Write property test for alert-section composition
    - **Property 27: Alert-section composition** (exactly FAILED posts, each with its reason incl. `TOKEN_EXPIRED`)
    - **Validates: Requirements 17.1, 17.2**

  - [ ]* 12.8 Write property test for the data-sync staleness predicate
    - **Property 28: Data-sync staleness predicate** (injected clock; warning iff `now - lastSync > threshold`, current at exactly the threshold)
    - **Validates: Requirements 18.1, 18.2, 18.3**

  - [ ]* 12.9 Write property test for notifications composition
    - **Property 29: Notifications composition** (exactly the union of token-expiry, publish-failure, and insights-pending)
    - **Validates: Requirements 19.1**

  - [ ]* 12.10 Write unit tests for overview edge cases and notification examples
    - A source data set being unavailable yields 500 with no partial overview (Req 14.4); the overview pulls from all three sources (Req 14.1); the KPI_Overview contains View/Lead/Follow series (Req 14.3); a Scheduled_Post entering FAILED produces a publish-failure notification (Req 19.3); an insight entering PENDING_REVIEW produces an insights-pending notification (Req 19.4)
    - _Requirements: 14.1, 14.3, 14.4, 19.3, 19.4_

  - [ ]* 12.11 Write integration test for Foundation alert surfacing
    - Token-expiry / refresh-failure alerts raised by the Foundation Token_Manager / Alert Dispatcher surface in the Alert_Section and the Notifications_Channel
    - _Requirements: 17.3, 19.2_

- [ ] 13. Register dashboard routes behind Foundation auth/RBAC
  - [ ] 13.1 Register `/api/dashboard/*` routes and bind the dashboard RBAC policy
    - Register `GET /api/dashboard/overview` and `GET /api/dashboard/notifications` behind the Foundation auth + RBAC middleware as protected endpoints requiring a valid Access_Token; bind ADMIN → full overview + notifications, SALES → read-only, and deny any SALES write attempt (non-GET on a dashboard resource) with 403 before handler logic so nothing is modified; connect them to the `Dashboard_Service`
    - _Requirements: 20.1, 20.2, 20.3, 20.4_

  - [ ]* 13.2 Write property test for dashboard RBAC enforcement
    - **Property 30: Dashboard RBAC enforcement** (ADMIN full; SALES read-only; SALES write attempt → 403 leaving every resource unmodified)
    - **Validates: Requirements 20.2, 20.3, 20.4**

  - [ ]* 13.3 Write smoke test for dashboard route protection and the staleness-threshold default
    - Every `/api/dashboard/*` route rejects an unauthenticated request with 401 (Req 20.1); `Sync_Staleness_Threshold` defaults to 6 hours when no configuration value is provided (Req 18.4)
    - _Requirements: 20.1, 18.4_

- [ ] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP, but each one is the validation owner for the property/requirement it names.
- Property test tasks reference the design's Correctness Properties by number and run on `fast-check` with ≥100 generated cases, tagged `// Feature: lead-management-dashboard, Property {n}: ...`; the lead repository is an in-memory fake, the clock is injected (deterministic upcoming-posts window and data-sync staleness, including exact boundaries), and cross-module reads (Content Pipeline, Analytics, Token_Manager / Alert Dispatcher) are mocked. Filter composition (P7), stats grouping (P14), per-post and category/topic counts (P20, P21), and export round-trip (P16) are checked against a naive in-memory reference.
- This module reuses the prior three specs wholesale (auth/RBAC + HMAC middleware, `background-worker` Service_Account, Alert Dispatcher + Token_Manager, REST/pagination/error conventions; Content_Draft/Scheduled_Post + Content_Status + Content_Calendar; Analytics_Record/Performance_Record, Learning_Insight PENDING_REVIEW, Last_Sync_Time). The Dashboard aggregates their data via their read queries and never duplicates or re-persists it; the only owned data is `Lead` and `Lead_History_Entry`.
- Route protection, the Foundation HMAC gate, the cross-module dashboard reads, the Analytics lead-count pull, Foundation alert surfacing, and config defaults are validated by example, integration, and smoke tests per the design's Testing Strategy rather than by property tests.
- All 30 Correctness Properties are covered exactly once: P1 (3.2), P2 (3.3), P3 (3.4), P4 (3.5), P5 (3.6), P6 (4.3), P7 (4.4), P8 (6.7), P9 (4.5), P10 (5.4), P11 (5.3), P12 (2.2), P13 (5.5), P14 (6.3), P15 (6.4), P16 (6.5), P17 (6.6), P18 (8.4), P19 (8.5), P20 (9.2), P21 (9.3), P22 (10.2), P23 (12.3), P24 (12.4), P25 (12.5), P26 (12.6), P27 (12.7), P28 (12.8), P29 (12.9), P30 (13.2).
- Each task references specific requirements for traceability; checkpoints (Tasks 7, 11, 14) ensure incremental validation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.1", "8.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "4.1", "4.2", "5.1", "5.2", "8.2", "9.1"] },
    { "id": 3, "tasks": ["4.3", "4.4", "4.5", "5.3", "5.4", "5.5", "6.1", "6.2", "8.3", "8.4", "8.5", "9.2", "9.3", "12.1", "12.2"] },
    { "id": 4, "tasks": ["6.3", "6.4", "6.5", "6.6", "6.7", "8.6", "9.4", "10.1", "13.1", "12.3", "12.4", "12.5", "12.6", "12.7", "12.8", "12.9", "12.10", "12.11"] },
    { "id": 5, "tasks": ["10.2", "10.3", "13.2", "13.3"] }
  ]
}
```
