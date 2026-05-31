# Implementation Plan: Content Pipeline

## Overview

This plan converts the Content Pipeline design into incremental, code-focused tasks for the **Node.js 20 LTS + TypeScript** stack established in the Foundation & Deployment module (Fastify, Prisma/PostgreSQL 16, ioredis/Redis, BullMQ, node-cron, jose, fast-check + Vitest). This module **builds on Foundation** and does not rebuild it: the auth/RBAC middleware, `PlatformAdapter`/`AdapterRegistry`, `Token_Manager`, `Alert Dispatcher`, `Service_Accounts` (`ai-system`, `background-worker`), `Secret_Store`, and the REST/error-envelope conventions are assumed to exist and are wired into rather than reimplemented.

Tasks are ordered by dependency: Prisma schema additions → the shared `Content_State_Machine` → strategy components (Persona, Calendar) → generation and media → draft management and review → scheduling → the publishing worker → cross-cutting route registration and access control. Each task builds on prior tasks and ends by integrating its output into the running application, leaving no orphaned code.

Property-based tests use `fast-check` with a minimum of **100 generated cases each**, and every property test is tagged in the format `// Feature: content-pipeline, Property {n}: {property_text}` to map 1:1 with the design's 23 Correctness Properties. Gemini, the `Platform_Adapter`, the `Token_Manager`, the `Alert Dispatcher`, and the media object store are **mocked**, and the clock is **injected** so all time-validity, due-scan, and idempotency properties are deterministic. UI rendering, graceful view degradation, two-step delete, route protection, worker identity, and BullMQ/cron registration are validated by example, integration, and smoke tests per the design's Testing Strategy.

## Tasks

- [ ] 1. Add Prisma schema and migrations for the content pipeline
  - [ ] 1.1 Define schema models and generate the migration
    - Add `Domain_Context`, `Content_Persona`, `Content_Draft` with child `DRAFT_CTA`, `Media_Asset`, and `Scheduled_Post` models to `schema.prisma` per the Data Models section, including the `ContentStatus` enum, the `objective`/`platform`/media-`kind` enums, and the draft flags (`generated_without_feedback`, `rejection_reason`, `preview_presented`)
    - Add the **unique** constraint on `Scheduled_Post.idempotency_key`, the **unique index on `(platform, idempotency_key)`**, and a partial unique index on `external_post_id` to back duplicate-post prevention; enforce the ≥1-CTA invariant for drafts at the repository/CHECK level
    - Generate the migration targeting PostgreSQL 16 and regenerate the Prisma client; reuse the Foundation Prisma datasource/client module
    - _Requirements: 1.5, 6.8, 6.9, 8.2, 8.3, 12.2, 12.6, 15.3, 17.1_

  - [ ]* 1.2 Write integration test for the migration and idempotency indexes
    - Verify the migration applies cleanly on PostgreSQL 16 and that inserting a second `Scheduled_Post` row with a duplicate `(platform, idempotency_key)` is rejected by the unique index
    - _Requirements: 12.6, 17.1_

- [ ] 2. Implement the Content_State_Machine
  - [ ] 2.1 Implement the guarded transition function
    - Implement `transition(current, target)` over the `ALLOWED_TRANSITIONS` set (DRAFT→APPROVED, APPROVED→SCHEDULED, SCHEDULED→PUBLISHING, PUBLISHING→PUBLISHED, DRAFT→REJECTED, REJECTED→DRAFT, PUBLISHING→FAILED, FAILED→SCHEDULED), returning the new status on success and a 409 result with no change for any pair not in the set
    - Make this the single module-wide entry point for changing a `ContentStatus`, consumed by Review, Scheduling, and the Worker
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 2.2 Write property test for state-machine transition closure
    - **Property 12: Content state-machine transition closure**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4**

- [ ] 3. Implement the Persona_Manager
  - [ ] 3.1 Implement the validation gate and persona create/update
    - Implement the validation gate that rejects with HTTP 400 (no persistence) when the domain name is blank, the tone-of-voice is blank, or any of age / target needs / pain points is missing, treating whitespace-only as blank; run the same gate for create and edit
    - Implement `create` (persist the persona associated with its Domain) and `update` (404 if the persona does not exist before validation; otherwise validate then persist)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3_

  - [ ] 3.2 Implement AI persona recommendation and confirmation
    - Implement `recommend(domainName)` to request proposed attributes (age, interests, target needs, pain points, tone-of-voice) from Gemini and return them **without persisting**; on a Gemini failure return an error and leave existing personas unchanged
    - Implement `confirmRecommendation` to persist a persona from accepted or edited attributes only after re-applying the Task 3.1 validation gate; a reject is a no-op
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ] 3.3 Wire the persona routes
    - Register `POST /api/strategy/persona`, `PUT /api/strategy/persona/{id}`, and `GET /api/strategy/persona/{id}/recommendations` and connect them to the Persona_Manager with JSON-schema body validation
    - _Requirements: 1.1, 2.1, 3.1_

  - [ ]* 3.4 Write property test for the persona validation gate
    - **Property 1: Persona validation gate**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.2, 3.3, 3.4**

  - [ ]* 3.5 Write property test for persona persistence round-trip
    - **Property 2: Persona persistence round-trip**
    - **Validates: Requirements 1.5, 2.3**

  - [ ]* 3.6 Write property test for AI recommendation non-persistence
    - **Property 3: AI recommendation never persists by itself**
    - **Validates: Requirements 3.2, 3.3, 3.4**

  - [ ]* 3.7 Write unit tests for persona edge cases
    - Edit a non-existent persona → 404 (Req 2.1); reject a recommendation → stored personas unchanged (Req 3.5); Gemini recommendation failure → error with existing personas unchanged (Req 3.6)
    - _Requirements: 2.1, 3.5, 3.6_

- [ ] 4. Implement the Calendar_Manager
  - [ ] 4.1 Implement calendar rendering, status colors, and reschedule
    - Implement `render` for month/week/day views returning the available subset when one or more views fail to load, attach the platform label (Facebook/TikTok/Website) to scheduled items, and implement `colorFor` as an injective mapping over {SCHEDULED, PUBLISHED, DRAFT, FAILED}
    - Implement `reschedule` to update the publish time only when the post status is SCHEDULED and the new time is strictly later than the injected `now`, reusing the shared future-time rule; otherwise reject and leave the time unchanged
    - _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3_

  - [ ] 4.2 Wire the calendar routes
    - Register `GET /api/strategy/calendar` and `PUT /api/strategy/calendar/{scheduledPostId}/reschedule` and connect them to the Calendar_Manager
    - _Requirements: 4.1, 5.1_

  - [ ]* 4.3 Write property test for drag-and-drop reschedule validity
    - **Property 4: Reschedule validity (drag-and-drop)**
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [ ]* 4.4 Write property test for distinct calendar status colors
    - **Property 23: Calendar status colors are distinct**
    - **Validates: Requirements 4.2**

  - [ ]* 4.5 Write smoke test for calendar views and platform labels
    - Calendar renders month/week/day views and returns the available subset when a view fails to load; scheduled items show their platform label
    - _Requirements: 4.1, 4.3_

- [ ] 5. Implement the Generation_Service
  - [ ] 5.1 Implement generation validation and prompt assembly
    - Implement `validate` to proceed only when a domain is provided, at least one Content_Persona is selected, and the objective is one of {Lead, View, Follow}; otherwise reject with HTTP 400 and generate nothing
    - Implement `buildPrompt` to emit segments in the strict order expert role → domain context → persona → tone-of-voice → objective → (optional performance context) → required-CTA instruction, with the required-CTA instruction always last and the performance segment present iff the `AI_Prompt_Context` is complete
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 7.3_

  - [ ] 5.2 Implement content generation with cold-start fallback
    - Load `AI_Prompt_Context` from `/api/strategy/ai-context`; when it is empty or missing any performance field, build from the `Default_Context` (selected persona + domain context + default tone), omit the performance segment, never fail for missing context, and mark the draft `generated_without_feedback`
    - Call Gemini using model `gemini-2.5-flash`; on success persist a Content_Draft with a Title, Body, and ≥1 CTA at status DRAFT; on a Gemini failure return a "generation failed" error and persist nothing
    - _Requirements: 6.5, 6.7, 6.8, 6.9, 6.10, 7.1, 7.2, 7.3, 8.1_

  - [ ] 5.3 Wire the generation route
    - Register `POST /api/generation/generate` (running under the `ai-system` Service_Account) and connect it to the Generation_Service
    - _Requirements: 6.1_

  - [ ]* 5.4 Write property test for generation request validation
    - **Property 5: Generation request validation**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [ ]* 5.5 Write property test for Gemini prompt segment ordering
    - **Property 6: Gemini prompt segment ordering**
    - **Validates: Requirements 6.6, 7.3**

  - [ ]* 5.6 Write property test for generation output shape
    - **Property 7: Generation output shape**
    - **Validates: Requirements 6.8, 6.9, 8.1**

  - [ ]* 5.7 Write property test for cold-start generation fallback
    - **Property 8: Cold-start generation fallback**
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [ ]* 5.8 Write unit tests for generation failure and model id
    - A Gemini failure surfaces an error and persists no draft (Req 6.10); the model id passed to Gemini is `gemini-2.5-flash` (Req 6.7)
    - _Requirements: 6.7, 6.10_

- [ ] 6. Implement the Media_Service
  - [ ] 6.1 Implement media storage, attach, and TikTok eligibility
    - Implement `attach(draftId, file)` to store the user-supplied image/video in the object store (file bytes never in PostgreSQL) and persist a `Media_Asset` row linking it to the draft; implement `listForDraft` and the `isTikTokEligible` helper (true iff a video or photo_carousel asset is present)
    - _Requirements: 8.2, 8.3, 12.3_

  - [ ] 6.2 Wire the media route
    - Register `POST /api/media` (multipart upload) and connect it to the Media_Service
    - _Requirements: 8.2_

  - [ ]* 6.3 Write unit tests for media upload and attach
    - Uploading an image and uploading a video each store the file and attach the asset to the draft
    - _Requirements: 8.2, 8.3_

- [ ] 7. Implement the Draft_Manager
  - [ ] 7.1 Implement draft list, detail, edit guard, and two-step delete
    - Implement `list` (paginated, returning Title + Status) and `get` (returning Title, Body, CTA); implement `edit` to persist only when status is DRAFT and reject a non-DRAFT edit with HTTP 409 leaving the draft unchanged; implement `requestDelete`/`confirmDelete` so an explicit confirmation is required before deletion
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ] 7.2 Wire the draft routes
    - Register `GET /api/generation/drafts`, `GET/PUT/DELETE /api/generation/drafts/{id}` and connect them to the Draft_Manager
    - _Requirements: 9.1, 9.2_

  - [ ]* 7.3 Write property test for the draft edit guard
    - **Property 9: Draft edit guard**
    - **Validates: Requirements 9.3, 9.4**

  - [ ]* 7.4 Write unit tests for draft list, detail, and delete confirmation
    - List returns Title + Status (Req 9.1); detail returns Title/Body/CTA (Req 9.2); delete requires confirmation then deletes (Req 9.5, 9.6)
    - _Requirements: 9.1, 9.2, 9.5, 9.6_

- [ ] 8. Implement the Review_Service
  - [ ] 8.1 Implement preview gate, approve, and reject
    - Implement `preview` to present the draft and mark the preview presented; implement `approve`/`reject` to change status only when a preview has been presented and the status is DRAFT — approve transitions DRAFT→APPROVED via the state machine, reject without a reason → 400 (no change), reject with a non-blank reason stores the reason and returns the draft to DRAFT; a non-DRAFT approve/reject → 409 with no change
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [ ] 8.2 Wire the review routes
    - Register `GET /api/generation/drafts/{id}/review` (preview), `POST /api/generation/drafts/{id}/approve`, and `POST /api/generation/drafts/{id}/reject` and connect them to the Review_Service
    - _Requirements: 10.1, 10.4, 10.5_

  - [ ]* 8.3 Write property test for review preview/DRAFT gating
    - **Property 10: Review actions gated by preview and DRAFT status**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

  - [ ]* 8.4 Write property test for reject reason and return-to-DRAFT
    - **Property 11: Reject requires a reason and returns the draft to DRAFT**
    - **Validates: Requirements 10.5, 10.6**

- [ ] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement the Scheduling_Service
  - [ ] 10.1 Implement scheduling fan-out with per-platform gates and idempotency keys
    - Reject with HTTP 409 when the target draft is not APPROVED (no Scheduled_Post); for an approved draft, create one Scheduled_Post per (draft, platform) pair, evaluating each platform independently — strictly-future publish time, and for TikTok both an attached video/photo-carousel `Media_Asset` (via `isTikTokEligible`) and a description strictly under 2200 characters including hashtags — rejecting only the failing platform while others proceed
    - Assign each created Scheduled_Post a unique `Idempotency_Key` (UUID v4) and set its status to SCHEDULED via the state machine
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [ ] 10.2 Implement failed-post recovery
    - Implement `retryFailed` to transition a FAILED Scheduled_Post to SCHEDULED with the new time only when the new time is strictly future and the edited post passes the Requirement 12.3–12.5 gates; otherwise reject and leave the status unchanged
    - _Requirements: 18.1, 18.2, 18.3_

  - [ ] 10.3 Wire the scheduling routes
    - Register `POST /api/publishing/schedule` and `POST /api/publishing/scheduled/{id}/retry` and connect them to the Scheduling_Service
    - _Requirements: 12.1, 18.1_

  - [ ]* 10.4 Write property test for per-platform scheduling validation
    - **Property 13: Scheduling validation per platform**
    - **Validates: Requirements 12.1, 12.3, 12.4, 12.5**

  - [ ]* 10.5 Write property test for fan-out and unique idempotency keys
    - **Property 14: Scheduling fan-out and unique idempotency keys**
    - **Validates: Requirements 12.2, 12.6**

  - [ ]* 10.6 Write property test for failed-post recovery validity
    - **Property 22: Failed-post recovery validity**
    - **Validates: Requirements 18.1, 18.2, 18.3**

  - [ ]* 10.7 Write integration test for the TikTok media gate end-to-end
    - End-to-end TikTok scheduling rejects a text-only draft and accepts one with an attached video
    - _Requirements: 12.3_

- [ ] 11. Implement the Publishing_Worker
  - [ ] 11.1 Implement the due-scan and the atomic idempotency lock
    - Implement `scanDue(now)` to select posts whose status is SCHEDULED and whose `scheduled_at <= now`; implement `tryLock` as the atomic `UPDATE ... SET status='PUBLISHING' WHERE id=? AND status='SCHEDULED'` compare-and-set combined with a Redis lock keyed by the post id, so only the winning process proceeds and a post already PUBLISHING or locked invokes no adapter operation
    - _Requirements: 13.1, 13.2, 13.3_

  - [ ] 11.2 Implement error classification and retry/fail policy
    - Implement `classifyError` (network / 429 / 5xx → transient; 4xx≠429 or content-policy → hard); implement the retry policy (exponential backoff up to 3 retries) and the terminal-failure operation that sets FAILED + stores the error code + raises an alert as one combined action, leaving the status unchanged if any sub-action fails; a hard error sets FAILED + stores the error + alerts with no retry
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ] 11.3 Implement the publish pipeline with token check, duplicate re-scan, and success recording
    - Before publishing, if the post is PUBLISHING and an `external_post_id` already exists for its `Idempotency_Key`, set PUBLISHED using that id with no new request; check `Token_Manager.isValid(platform)` and request `refresh` if invalid, and on refresh failure set FAILED with reason TOKEN_EXPIRED + raise an alert + never call the adapter
    - Call `AdapterRegistry.get(platform).publish(req)` including the `Idempotency_Key`; on success set PUBLISHED (even if storing returned ids fails) and store `external_post_id` + `post_url` when both are returned; a re-submitted key already used for a success is treated as the original success; wire transient/hard outcomes into the Task 11.2 policy
    - _Requirements: 14.1, 14.2, 14.3, 15.1, 15.2, 15.3, 17.1, 17.2_

  - [ ] 11.4 Wire the cron due-scan, BullMQ publish-queue, and publish endpoint
    - Register the node-cron due-scan job that enqueues one BullMQ job per due post on the existing Redis instance; configure the `publish-queue` with `attempts: 4` (1 initial + 3 retries) and `backoff: { type: 'exponential' }`; register `POST /api/publishing/post` and have the worker authenticate as the `background-worker` Service_Account when invoking it
    - _Requirements: 13.1, 16.1, 19.3_

  - [ ]* 11.5 Write property test for the due-scan selection predicate
    - **Property 15: Due-scan selection predicate**
    - **Validates: Requirements 13.1**

  - [ ]* 11.6 Write property test for the exclusive idempotency lock
    - **Property 16: Exclusive idempotency lock before publishing**
    - **Validates: Requirements 13.2, 13.3**

  - [ ]* 11.7 Write property test for token-validation fail-fast
    - **Property 17: Token validation failure fails fast without publishing**
    - **Validates: Requirements 14.3**

  - [ ]* 11.8 Write property test for the idempotency key in the publish request
    - **Property 18: Publish request carries the idempotency key**
    - **Validates: Requirements 15.1**

  - [ ]* 11.9 Write property test for success recording
    - **Property 19: Success recording**
    - **Validates: Requirements 15.2, 15.3**

  - [ ]* 11.10 Write property test for retry and error classification
    - **Property 20: Retry and error classification**
    - **Validates: Requirements 16.1, 16.2, 16.3**

  - [ ]* 11.11 Write property test for at-most-once publishing
    - **Property 21: A draft × platform publishes at most once**
    - **Validates: Requirements 17.1, 17.2**

  - [ ]* 11.12 Write unit test for token-check ordering
    - `isValid` is consulted and a refresh requested before any adapter call (Req 14.1, 14.2)
    - _Requirements: 14.1, 14.2_

  - [ ]* 11.13 Write integration test for the cron→queue→worker run and DB idempotency
    - The due-scan cron enqueues a BullMQ job per due post and the worker drives a SCHEDULED→PUBLISHING→PUBLISHED run against a mocked adapter; the unique `(platform, idempotency_key)` index rejects a duplicate successful row
    - _Requirements: 13.1, 13.2, 15.2, 17.1_

- [ ] 12. Wire routes behind Foundation auth/RBAC and enforce access control
  - [ ] 12.1 Register all content pipeline routes behind Foundation auth/RBAC
    - Mount the `/api/strategy/*`, `/api/generation/*`, `/api/publishing/*`, and `/api/media` route groups behind the Foundation authentication + RBAC middleware as ADMIN-only protected endpoints; confirm the Generation_Service runs under `ai-system` and the Publishing_Worker authenticates as `background-worker`
    - _Requirements: 19.1, 19.2, 19.3_

  - [ ]* 12.2 Write integration test for route protection
    - A SALES-authenticated request to a content pipeline endpoint is denied 403; a missing/invalid token is denied 401
    - _Requirements: 19.1, 19.2_

  - [ ]* 12.3 Write smoke test for registration, identities, and queue config
    - Routes under `/api/strategy/*`, `/api/generation/*`, `/api/publishing/*`, `/api/media` are registered ADMIN-only; the worker authenticates as `background-worker` and generation runs under `ai-system`; the `publish-queue` is configured with `attempts: 4` and exponential backoff
    - _Requirements: 19.1, 19.3, 16.1_

- [ ] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP, but each one is the validation owner for the property/requirement it names.
- Property test tasks reference the design's Correctness Properties by number and run on `fast-check` with ≥100 generated cases, tagged `// Feature: content-pipeline, Property {n}: ...`; Gemini, the Platform_Adapter, the Token_Manager, the Alert Dispatcher, and the media object store are mocked and the clock is injected for determinism.
- This module reuses Foundation wholesale (auth/RBAC, AdapterRegistry, Token_Manager, Alert Dispatcher, Service_Accounts, Secret_Store, REST/error conventions); component tasks wire into those services rather than rebuilding them.
- UI rendering (calendar views, list/detail), graceful view degradation, two-step delete, route protection, worker identity, and BullMQ/cron registration are validated by example, integration, and smoke tests per the design's Testing Strategy rather than by property tests.
- All 23 Correctness Properties are covered exactly once: P1 (3.4), P2 (3.5), P3 (3.6), P4 (4.3), P5 (5.4), P6 (5.5), P7 (5.6), P8 (5.7), P9 (7.3), P10 (8.3), P11 (8.4), P12 (2.2), P13 (10.4), P14 (10.5), P15 (11.5), P16 (11.6), P17 (11.7), P18 (11.8), P19 (11.9), P20 (11.10), P21 (11.11), P22 (10.6), P23 (4.4).
- Each task references specific requirements for traceability; checkpoints (Tasks 9, 13) ensure incremental validation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.1", "4.1", "5.1", "6.1", "7.1", "11.1", "11.2"] },
    { "id": 2, "tasks": ["3.2", "3.4", "3.5", "4.2", "4.3", "4.4", "5.2", "5.4", "5.5", "6.2", "6.3", "7.2", "7.3", "7.4", "8.1", "10.1", "11.3", "11.5", "11.6", "11.10"] },
    { "id": 3, "tasks": ["3.3", "3.6", "3.7", "4.5", "5.3", "5.6", "5.7", "5.8", "8.2", "8.3", "8.4", "10.2", "10.4", "10.5", "11.4", "11.7", "11.8", "11.9", "11.11", "11.12"] },
    { "id": 4, "tasks": ["10.3", "10.6", "11.13"] },
    { "id": 5, "tasks": ["10.7", "12.1"] },
    { "id": 6, "tasks": ["12.2", "12.3"] }
  ]
}
```
