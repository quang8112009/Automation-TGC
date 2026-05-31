# Implementation Plan: Analytics & Feedback Loop

## Overview

This plan converts the Analytics & Feedback Loop design into incremental, code-focused tasks for the **Node.js 20 LTS + TypeScript** stack established across Foundation & Deployment and Content Pipeline (Fastify, Prisma/PostgreSQL 16, ioredis/Redis, BullMQ, node-cron, jose, fast-check + Vitest). This module is the third Phase 1 spec and **builds on the two prior modules rather than rebuilding them**:

- **Foundation & Deployment** supplies auth/RBAC middleware, the `PlatformAdapter`/`AdapterRegistry` (incl. GA4) analytics ops, `Token_Manager`, the `Alert Dispatcher`, the `Scheduler` (node-cron), the `background-worker` Service_Account, the `Secret_Store`, the REST/error-envelope conventions, and the Gemini client. These are assumed to exist and are wired into.
- **Content Pipeline** supplies `Scheduled_Post` (PUBLISHED, with `external_post_id`/`post_url`), `Content_Persona` (`recommended_tone`), `Content_Calendar` (per-topic frequency), and the `Content_Draft` features used during extraction. This module is the **producer** of the `AI_Prompt_Context` that the Content Pipeline `Generation_Service` consumes.

Tasks are ordered by dependency: Prisma schema additions + retention predicate → the foundational `Insight_State_Machine` → the pure `Scoring_Engine` → the `Collection_Service` → the append-only `Audit_Log` → the `Feedback_Engine` → the `Insight_Service` → the single-source-of-truth `Strategy_Update_Processor` → `AI_Prompt_Context` production + read model → cross-cutting route registration, RBAC, cron/queue wiring, and integration/smoke. Each task builds on prior tasks and ends by integrating its output into the running application, leaving no orphaned code.

Property-based tests use `fast-check` with a minimum of **100 generated cases each**, and every property test is tagged in the format `// Feature: analytics-feedback-loop, Property {n}: {property_text}` to map 1:1 with the design's **29 Correctness Properties**. The `Platform_Adapter`, GA4, the `Token_Manager`, the Gemini client, and the `Alert Dispatcher` are **mocked**, and the **clock is injected** so all schedule, retention-boundary, divide-by-zero, atomicity, and aggregation properties are deterministic and cost does not scale with iteration count. Per-platform metric mapping, persisted shapes, cron registration, service-account auth, the score-queue trigger, the five-dimension grouping shape, and ai-context cold-start are validated by example, integration, and smoke tests per the design's Testing Strategy.

## Tasks

- [ ] 1. Add Prisma schema, migrations, and the retention predicate
  - [ ] 1.1 Define schema models and generate the migration
    - Add `Analytics_Record` (with **nullable** integer columns `views`, `likes`, `shares`, `comments`, `follows`, `leads`, `click_through`, `reach` so an Unavailable_Metric is stored as `null` and never `0`; `published_post_id` FK, `platform` enum, `collected_at` timestamptz), `Performance_Record` (Content_Features columns + `conversion_rate`/`engagement_rate`/`cta_click_rate`, **nullable** `follow_rate`, `performance_label` enum, `scored_at`), `Learning_Insight` (`insight_type`, `insight_status`, `subject`/`metrics`/`recommended_change`/`modified_change` jsonb, `confidence_score`, `sample_size`, `analysis_period`, `rejection_reason`, `generated_at`), `AI_Prompt_Context` (single current row: `context_version`, nullable `last_updated_from_analytics`, six jsonb context fields), and `Audit_Entry` (`event_type`, `insight_id`, `actor`, `detail` jsonb, `recorded_at`) to `schema.prisma` per the Data Models section, plus the `Platform`, `PerformanceLabel`, `InsightType`, `InsightStatus`, and `AuditEventType` enums
    - Configure the `Audit_Entry` table as **append-only**: grant the application role only `INSERT`/`SELECT` (no `UPDATE`/`DELETE`) in the migration
    - Generate the migration targeting PostgreSQL 16 and regenerate the Prisma client, reusing the Foundation Prisma datasource/client module; the `published_post_id` FK references the Content Pipeline `Scheduled_Post` table
    - _Requirements: 1.3, 1.4, 2.2, 3.4, 5.1, 9.1, 9.2, 9.3, 13.1, 15.1, 20.4, 22.1_

  - [ ] 1.2 Implement the retention predicate
    - Implement a pure `isRetained(record, now)` predicate that keeps an `Analytics_Record` or `Performance_Record` available for Pattern_Recognition exactly when its age is at or within the configurable `Retention_Period` (default 12 months), **inclusive of the exact boundary**; read `Retention_Period` from configuration with the injected clock
    - _Requirements: 5.1, 5.2_

  - [ ]* 1.3 Write property test for the retention predicate
    - **Property 6: Retention keeps records at or within the period**
    - **Validates: Requirements 5.1, 5.2**

  - [ ]* 1.4 Write integration test for the migration and append-only audit grants
    - Verify the migration applies cleanly on PostgreSQL 16, that nullable metric columns accept `null`, and that an `UPDATE`/`DELETE` against `Audit_Entry` is rejected for the application role
    - _Requirements: 5.1, 20.4_

- [ ] 2. Implement the Insight_State_Machine (foundational)
  - [ ] 2.1 Implement the guarded transition function
    - Implement `transition(current, target)` over the `ALLOWED_TRANSITIONS` set (`NEW→PENDING_REVIEW`, `PENDING_REVIEW→APPROVED`, `PENDING_REVIEW→REJECTED`), returning the new status on success and a `409` result with no change for any pair not in the set; `APPROVED` and `REJECTED` have no outgoing edges (terminal)
    - Make this the single module-wide entry point for changing an `Insight_Status`, consumed by the Feedback_Engine (queueing) and the Insight_Service (approve/reject)
    - _Requirements: 15.1, 15.2, 15.3_

  - [ ]* 2.2 Write property test for the insight lifecycle transition closure
    - **Property 18: Insight lifecycle transition closure**
    - **Validates: Requirements 13.5, 15.1, 15.2, 15.3, 17.1, 17.2**

- [ ] 3. Implement the Scoring_Engine (pure logic)
  - [ ] 3.1 Implement computeRates with divide-by-zero safety and unavailable-metric exclusion
    - Implement `computeRates(platform, metrics)`: with `views > 0`, `conversionRate = leads/views*100` and `ctaClickRate = click_through/views*100`; Facebook/Website with `reach > 0`, `engagementRate = (likes+comments+shares)/reach*100` and `followRate = follows/reach*100`; TikTok with `views > 0`, `engagementRate = (likes+comments+shares)/views*100` and `followRate = null`
    - Any Derived_Rate whose denominator is zero is **set to exactly 0 with no division performed** (never `NaN`/`Infinity`); a `null` (Unavailable_Metric) input is excluded and never read as `0`; return an `insufficient` flag set when `views === 0` or a required `reach` is `0`
    - _Requirements: 3.5, 6.1, 6.2, 6.3, 7.1, 7.2_

  - [ ] 3.2 Implement labelFor threshold mapping
    - Implement `labelFor(conversionRate, insufficient, cfg)`: when `insufficient`, return `INSUFFICIENT_DATA` and never a tier; otherwise `>= HIGH_THRESHOLD → HIGH_PERFORMER`, `>= MID_THRESHOLD and < HIGH_THRESHOLD → AVERAGE_PERFORMER`, `< MID_THRESHOLD → LOW_PERFORMER`; read `HIGH_THRESHOLD`/`MID_THRESHOLD` from config (defaults 5 and 2)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ] 3.3 Implement score(): feature extraction, Performance_Record production, and recovery rescoring
    - Implement `score(record, features, cfg)` to extract the eleven Content_Features (domain_category, content_topic, persona_id, tone_of_voice, objective, platform, post_time_slot, content_length, has_cta, cta_type, media_type) from the post's draft/scheduled-post, combine them with the Derived_Rates, the Performance_Label, and a `scored_at` timestamp into a `Performance_Record`, and persist it
    - When a later collection raises `views`/required `reach` above zero for a post previously labeled `INSUFFICIENT_DATA`, recompute the Derived_Rates and assign a tier label from the fresh Conversion_Rate
    - _Requirements: 7.4, 9.1, 9.2, 9.3_

  - [ ]* 3.4 Write property test for derived-rate platform formulas
    - **Property 7: Derived rates follow their platform formulas**
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [ ]* 3.5 Write property test for divide-by-zero safety
    - **Property 8: Divide-by-zero yields zero rate and INSUFFICIENT_DATA**
    - **Validates: Requirements 7.1, 7.2**

  - [ ]* 3.6 Write property test for performance-label threshold mapping
    - **Property 9: Performance label maps conversion rate against thresholds**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.5**

  - [ ]* 3.7 Write property test for recovery rescoring
    - **Property 10: Rescoring on recovery replaces INSUFFICIENT_DATA with a tier**
    - **Validates: Requirements 7.4**

  - [ ]* 3.8 Write property test for performance-record completeness
    - **Property 11: Performance records are complete**
    - **Validates: Requirements 9.1, 9.2**

  - [ ]* 3.9 Write unit tests for default thresholds and record persistence
    - Default `HIGH_THRESHOLD`/`MID_THRESHOLD` are 5 and 2 (Req 8.4); a produced `Performance_Record` is persisted (Req 9.3)
    - _Requirements: 8.4, 9.3_

- [ ] 4. Implement the Collection_Service
  - [ ] 4.1 Implement shapeMetrics with per-platform availability
    - Implement `shapeMetrics(platform, raw)`: Facebook → views, reach, click_through, follows (+ engagement inputs); Website/GA4 → pageviews-as-views, sessions, conversions; TikTok → only views, likes, comments, shares, with **reach and follows recorded as `null` Unavailable_Metrics** regardless of payload contents; any metric a platform's API does not provide is stored `null` and flagged unavailable, never coerced to `0`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ] 4.2 Implement matchToPost and Analytics_Record persistence
    - Implement `matchToPost(externalPostId)` to resolve the internal `Scheduled_Post` by its `External_Post_Id`; persist an `Analytics_Record` keyed to that post + platform with the shaped metrics and a `collected_at` timestamp; if the id matches no post or matching fails, **skip** those metrics and create no `Analytics_Record`
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 4.3 Implement runCycle with token gate, GA4 collection, error handling, and score-queue enqueue
    - Implement `runCycle(now)`: for each platform, call `Token_Manager.isValid(platform)` and request `Token_Manager.refresh(platform)` when invalid/expired before collecting; resolve the per-platform `PlatformAdapter` (website via the GA4 adapter) and request analytics for each Published_Post; on a per-platform request failure, log the platform id + failure timestamp, notify the Content_Manager via the Alert Dispatcher that the platform's data is not current, **retain the most-recent Analytics_Records** for that platform, and continue with the remaining platforms
    - On each persisted `Analytics_Record`, enqueue a BullMQ `score-queue` job so scoring runs event-driven immediately after collection
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 4.3, 6.4_

  - [ ]* 4.4 Write property test for TikTok unavailable metrics
    - **Property 2: TikTok reach and follows are always unavailable**
    - **Validates: Requirements 3.3**

  - [ ]* 4.5 Write property test for missing-metric null handling
    - **Property 3: Missing metrics are null, never zero**
    - **Validates: Requirements 3.4**

  - [ ]* 4.6 Write property test for metric-to-post matching
    - **Property 1: Metrics match only their originating post**
    - **Validates: Requirements 2.1, 2.3**

  - [ ]* 4.7 Write property test for collection failure isolation
    - **Property 5: Collection failure isolates the platform and keeps last data**
    - **Validates: Requirements 4.2, 4.3**

  - [ ]* 4.8 Write unit tests for Facebook/GA4 mapping and Analytics_Record shape
    - Facebook records views/reach/click_through/follows (Req 3.1); Website/GA4 records pageviews-as-views, sessions, conversions (Req 3.2); the persisted `Analytics_Record` carries the metrics + a `collected_at` timestamp (Req 1.4)
    - _Requirements: 1.4, 3.1, 3.2_

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement the append-only Audit_Log
  - [ ] 6.1 Implement the Audit_Log repository
    - Implement an `append(entry)` writer that records `INSIGHT_GENERATED`, `INSIGHT_APPROVED`, `INSIGHT_REJECTED`, `CONFLICT_RESOLVED`, and `STRATEGY_CHANGE_APPLIED` events with `insight_id`, `actor`, `detail`, and a server `recorded_at` timestamp; expose **only** `append` and read methods — no update or delete path — enforcing append-only at the API layer to match the DB-level grant restriction
    - _Requirements: 20.1, 20.2, 20.3, 20.4_

  - [ ]* 6.2 Write property test for append-only behavior
    - **Property 28: Audit log is append-only**
    - **Validates: Requirements 20.4**

- [ ] 7. Implement the Feedback_Engine
  - [ ] 7.1 Implement five-dimension aggregation with exclusion
    - Implement `aggregate(records, dim)` across the five Analysis_Dimensions (domain_category; content_topic; persona_id × tone_of_voice; platform × post_time_slot; cta_type × objective); when aggregating a Derived_Rate across a group, exclude Unavailable_Metrics (`null`) and rates labeled `INSUFFICIENT_DATA` so the aggregate equals the value over the non-null, non-INSUFFICIENT subset
    - _Requirements: 10.3, 12.1, 12.3_

  - [ ] 7.2 Implement input filtering, MIN_SAMPLE gating, and the empty-analysis guard
    - Implement `eligibleTopics(records, cfg)` to load Performance_Records in the configured period, **exclude every `INSUFFICIENT_DATA` record**, and return only content_topics whose record count is `>= MIN_SAMPLE` (config, default 5); if every record is `INSUFFICIENT_DATA` skip analysis entirely, and if no topic reaches `MIN_SAMPLE` generate no insights — both leaving the strategy unchanged
    - _Requirements: 10.3, 10.4, 11.1, 11.2, 11.3, 11.4_

  - [ ] 7.3 Implement insight generation with conditional types and lifecycle queueing
    - Generate Learning_Insights each with exactly one `Insight_Type`, supporting metrics, a `confidence_score ∈ [0,1]`, and the `sample_size` used; topic avg conversion `>= HIGH_THRESHOLD` with `sample_size >= MIN_SAMPLE` → `TOPIC_FREQUENCY_ADJUSTMENT` (increase); topic avg conversion `< MID_THRESHOLD` with `sample_size >= MIN_SAMPLE` → `LOW_PERFORMER_ALERT` (reduce/revise); create each insight `NEW` then move it to `PENDING_REVIEW` via the Insight_State_Machine when queued, and append an `INSIGHT_GENERATED` audit entry
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 20.1_

  - [ ] 7.4 Implement deterministic conflict resolution
    - Implement `resolveConflicts(insights)`: when two insights recommend conflicting changes to the same content_topic, persona_id, or platform-and-time-slot, **retain the one supported by Conversion_Rate and discard/supersede the one supported only by Engagement_Rate** (deterministic for a given input set), and append a `CONFLICT_RESOLVED` audit entry for each resolution
    - _Requirements: 14.1, 14.2_

  - [ ] 7.5 Implement run() weekly orchestration with auth gate, Gemini call, and atomic failure handling
    - Implement `run(now, period)`: authenticate as `background-worker` and **halt immediately without Pattern_Recognition** if auth fails; aggregate across the five dimensions and call Gemini `gemini-2.5-pro` for Pattern_Recognition; on a Gemini failure perform — as a single combined operation — log the failure, leave the strategy unchanged, and notify the Content_Manager that the weekly analysis did not complete, and if any one sub-action fails treat the run as failed leaving strategy state identical to before the run
    - _Requirements: 10.1, 10.2, 12.2, 12.4_

  - [ ]* 7.6 Write property test for aggregation exclusion
    - **Property 4: Aggregation excludes unavailable and insufficient data**
    - **Validates: Requirements 3.5, 7.3, 10.3, 12.3**

  - [ ]* 7.7 Write property test for minimum-sample gating
    - **Property 13: Minimum-sample gating**
    - **Validates: Requirements 11.1, 11.2, 11.3**

  - [ ]* 7.8 Write property test for the empty-data analysis guard
    - **Property 12: Empty-data analysis leaves strategy unchanged**
    - **Validates: Requirements 10.4**

  - [ ]* 7.9 Write property test for well-formed insights
    - **Property 15: Generated insights are well-formed**
    - **Validates: Requirements 13.1, 13.2**

  - [ ]* 7.10 Write property test for conditional insight-type selection
    - **Property 16: Conditional insight-type selection**
    - **Validates: Requirements 13.3, 13.4**

  - [ ]* 7.11 Write property test for conflict resolution
    - **Property 17: Conflict resolution is deterministic and conversion-favoring**
    - **Validates: Requirements 14.1**

  - [ ]* 7.12 Write property test for atomic analysis-failure handling
    - **Property 14: Analysis failure leaves strategy unchanged atomically**
    - **Validates: Requirements 12.4**

  - [ ]* 7.13 Write integration test for the five-dimension grouping and Gemini model
    - The five-dimension grouping produces the expected shape (Req 12.1) and Pattern_Recognition invokes Gemini with model id `gemini-2.5-pro` (Req 12.2)
    - _Requirements: 12.1, 12.2_

- [ ] 8. Implement the Insight_Service
  - [ ] 8.1 Implement listPending and open
    - Implement `listPending(page, limit)` returning exactly the `PENDING_REVIEW` insights with their `Insight_Type`, supporting metrics, `Confidence_Score`, and `sample_size` (paginated); implement `open(id)` returning the recommended change plus the supporting Performance_Records that justify it; operate in Review_Mode by default
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ] 8.2 Implement approve
    - Implement `approve(id, actor)`: if the target is not `PENDING_REVIEW` → `409` with no change; otherwise transition to `APPROVED` via the Insight_State_Machine, delegate application of the (possibly modified) recommended change to the Strategy_Update_Processor, append `INSIGHT_APPROVED` to the Audit_Log with approver + timestamp, and make the approved insight available as input context for the next Feedback_Engine run
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [ ] 8.3 Implement reject-with-reason and modify
    - Implement `reject(id, actor, reason)`: a missing/blank (whitespace-only) reason → `400` with no change; with a non-blank reason transition to `REJECTED` via the state machine, store the reason, append `INSIGHT_REJECTED` to the Audit_Log, and make the reason available as input context for the next run; implement `modify(id, edited)` to persist a `modified_change` on a `PENDING_REVIEW` insight so approval applies the modified change; a `REJECTED` insight is never applied
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

  - [ ] 8.4 Implement Auto_Mode routing
    - Implement `route(insight, autoMode)`: while Auto_Mode is disabled (default) route every insight through Review_Mode; while enabled, an insight recommending a posting-frequency adjustment of `<= 30%` **or** a posting time-slot change is routed to `AUTO_APPLY` (processor applies without approval, audited), and any other change is routed to `REVIEW`
    - _Requirements: 16.3, 19.1, 19.2, 19.3, 19.4_

  - [ ]* 8.5 Write property test for the pending list projection
    - **Property 19: Pending list is filtered and projected**
    - **Validates: Requirements 16.1**

  - [ ]* 8.6 Write property test for reject-reason enforcement
    - **Property 20: Reject requires a reason**
    - **Validates: Requirements 18.1, 18.2**

  - [ ]* 8.7 Write property test for modified-change application
    - **Property 21: Modified insights apply the modified change**
    - **Validates: Requirements 18.4**

  - [ ]* 8.8 Write property test for Auto_Mode routing
    - **Property 22: Auto_Mode routing**
    - **Validates: Requirements 16.3, 19.1, 19.2, 19.3, 19.4**

  - [ ]* 8.9 Write unit tests for open rendering and next-run availability
    - `open` renders the recommended change with its supporting Performance_Records (Req 16.2); an approved insight is available as input context for the next Feedback run (Req 17.5)
    - _Requirements: 16.2, 17.5_

- [ ] 9. Implement the Strategy_Update_Processor (single source of truth)
  - [ ] 9.1 Implement apply() with targeted strategy mutation and audit
    - Implement `apply(insight, source)` as the **only** component permitted to mutate Content_Calendar topic frequency, Content_Persona `recommended_tone`, and the AI_Prompt_Context in response to an insight; touch **only** the targets relevant to the insight's type — `TOPIC_FREQUENCY_ADJUSTMENT` → Content_Calendar frequency; `PERSONA_TONE_OPTIMIZATION` → persona `recommended_tone`; every applied insight → its affected AI_Prompt_Context fields — leaving unaffected components unchanged, and append a `STRATEGY_CHANGE_APPLIED` audit entry recording the applied change, source insight, and timestamp atomically with the write
    - _Requirements: 17.3, 19.2, 20.3, 21.1, 21.2, 21.3, 21.4, 21.6_

  - [ ]* 9.2 Write property test for single-source-of-truth mutation
    - **Property 23: Strategy mutates only through the processor**
    - **Validates: Requirements 17.3, 18.5, 21.1, 21.6**

  - [ ]* 9.3 Write property test for targeted component updates
    - **Property 24: Applied changes touch only relevant components**
    - **Validates: Requirements 21.2, 21.3, 21.4, 21.5**

- [ ] 10. Implement AI_Prompt_Context production and read model
  - [ ] 10.1 Implement produceAiContext derivation and the read model
    - Implement `produceAiContext(appliedInsights)` within the processor to populate all six context fields with `last_updated_from_analytics`, deriving `avoid_topics` as exactly the content_topics of applied `LOW_PERFORMER_ALERT` insights recommending reduction/revision and `top_performing_topics` as exactly the content_topics of applied HIGH_PERFORMER patterns with their average Conversion_Rate; implement `AiContextReadModel.get()` to return the most recently produced context, and serve `EMPTY_AI_PROMPT_CONTEXT` (all collections empty, null timestamp) — never an error — when no insight has been applied
    - _Requirements: 21.5, 22.1, 22.2, 22.3, 22.4, 22.5_

  - [ ] 10.2 Wire the ai-context read route
    - Register `GET /api/strategy/ai-context` and connect it to the read model so the Content Pipeline `Generation_Service` consumes the latest context, returning the empty context on cold start
    - _Requirements: 22.2, 22.5_

  - [ ]* 10.3 Write property test for context production and derivation
    - **Property 25: AI_Prompt_Context production and derivation**
    - **Validates: Requirements 22.1, 22.2, 22.3, 22.4**

  - [ ]* 10.4 Write property test for cold-start context
    - **Property 26: Cold-start context is empty, not an error**
    - **Validates: Requirements 22.5**

- [ ] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Wire routes, schedulers, and access control
  - [ ] 12.1 Register all routes behind Foundation auth/RBAC
    - Register `POST /api/analytics/collect`, `POST /api/analytics/score`, `POST /api/feedback/analyze`, `GET /api/feedback/insights`, `GET /api/feedback/insights/{id}`, `POST /api/feedback/insights/{id}/apply`, `POST /api/feedback/insights/{id}/reject`, and `GET /api/strategy/ai-context` behind the Foundation auth + RBAC middleware as protected endpoints requiring a valid Access_Token; the three feedback-review endpoints are **ADMIN-only** (SALES → 403); the three worker endpoints require the `background-worker` Service_Account permission set (out-of-set → 403); denials are rejected before handler logic and mutate nothing
    - _Requirements: 23.1, 23.2, 23.3, 23.4_

  - [ ] 12.2 Register the cron jobs and the BullMQ score-queue
    - Register the node-cron 6-hour Collection_Cycle job invoking `Collection_Service.runCycle` and the weekly Sunday-00:00 job invoking `Feedback_Engine.run`, both authenticating as `background-worker`; configure the BullMQ `score-queue` on the existing Redis instance and wire its consumer to the Scoring_Engine so collection-enqueued jobs are scored event-driven
    - _Requirements: 1.1, 1.2, 6.4, 10.1, 10.2_

  - [ ]* 12.3 Write property test for RBAC denial without side effects
    - **Property 29: RBAC denies unauthorized access without side effects**
    - **Validates: Requirements 23.1, 23.2, 23.4**

  - [ ]* 12.4 Write property test for audit-log completeness
    - **Property 27: Audit log completeness**
    - **Validates: Requirements 14.2, 17.4, 18.3, 20.1, 20.2, 20.3**

  - [ ]* 12.5 Write smoke test for cron registration
    - The 6-hour collection cron (Req 1.1) and the weekly Sunday-00:00 feedback cron (Req 10.1) are registered
    - _Requirements: 1.1, 10.1_

  - [ ]* 12.6 Write integration tests for wiring
    - Background_Worker service-account auth on collect/score/analyze (Req 1.2, 10.2, 23.3); per-platform adapter resolution incl. GA4 (Req 1.3); Token_Manager validity/refresh sequence (Req 1.5); event-driven score-queue trigger after collection (Req 6.4); `/api/strategy/ai-context` cold-start returns the empty context (Req 22.5)
    - _Requirements: 1.2, 1.3, 1.5, 6.4, 10.2, 22.5, 23.3_

- [ ] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP, but each one is the validation owner for the property/requirement it names.
- Property test tasks reference the design's Correctness Properties by number and run on `fast-check` with ≥100 generated cases, tagged `// Feature: analytics-feedback-loop, Property {n}: ...`; the Platform_Adapter, GA4, the Token_Manager, the Gemini client, and the Alert Dispatcher are mocked and the clock is injected for determinism.
- This module reuses Foundation wholesale (auth/RBAC, AdapterRegistry incl. GA4, Token_Manager, Alert Dispatcher, `background-worker` Service_Account, Secret_Store, Scheduler, Gemini client, REST/error conventions) and plugs into Content Pipeline contracts (`Scheduled_Post.external_post_id`, `Content_Persona.recommended_tone`, `Content_Calendar` frequency, `Content_Draft` features); component tasks wire into those rather than rebuilding them.
- The append-only Audit_Log (Task 6) is built before the Feedback_Engine, Insight_Service, and Strategy_Update_Processor that write to it, so audit recording is wired in as each component is implemented.
- Per-platform metric mapping, persisted shapes, the five-dimension grouping shape, cron registration, service-account auth, the score-queue trigger, and ai-context cold-start are validated by example, integration, and smoke tests per the design's Testing Strategy rather than by property tests.
- All 29 Correctness Properties are covered exactly once: P1 (4.6), P2 (4.4), P3 (4.5), P4 (7.6), P5 (4.7), P6 (1.3), P7 (3.4), P8 (3.5), P9 (3.6), P10 (3.7), P11 (3.8), P12 (7.8), P13 (7.7), P14 (7.12), P15 (7.9), P16 (7.10), P17 (7.11), P18 (2.2), P19 (8.5), P20 (8.6), P21 (8.7), P22 (8.8), P23 (9.2), P24 (9.3), P25 (10.3), P26 (10.4), P27 (12.4), P28 (6.2), P29 (12.3).
- Each task references specific requirements for traceability; checkpoints (Tasks 5, 11, 13) ensure incremental validation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "6.1", "3.1", "4.1", "1.4", "2.2"] },
    { "id": 2, "tasks": ["3.2", "4.2", "9.1", "1.3", "3.4", "3.5", "4.4", "4.5", "6.2"] },
    { "id": 3, "tasks": ["3.3", "4.3", "10.1", "7.1", "8.1", "3.6", "4.6", "4.8", "9.2", "9.3"] },
    { "id": 4, "tasks": ["10.2", "7.2", "8.2", "3.7", "3.8", "3.9", "4.7", "7.6", "8.5", "10.3"] },
    { "id": 5, "tasks": ["7.3", "8.3", "7.7", "7.8", "8.9", "10.4"] },
    { "id": 6, "tasks": ["7.4", "8.4", "7.9", "7.10", "8.6", "8.7"] },
    { "id": 7, "tasks": ["7.5", "7.11", "8.8"] },
    { "id": 8, "tasks": ["12.1", "12.2", "7.12", "7.13", "12.4"] },
    { "id": 9, "tasks": ["12.3", "12.5", "12.6"] }
  ]
}
```
