# Implementation Plan: SALES Access Restrictions

## Overview

This plan implements the RBAC policy revision for the SALES role in `autotgc-backend` (TypeScript / Fastify / Prisma). Work is ordered by dependency: the pure policy core (`auth/rbac.ts`) and the data-model change (`JobOrder.assignedTo`) land first, followed by the audit/types extension and the cross-cutting `rbacGuard` audit hook, then the per-surface route re-targeting and service scoping, then app wiring, and finally the property-based, unit, integration, and regression tests. Each task builds on the previous and ends wired into the running app — no orphaned code.

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Tasks

- [x] 1. Extend the Authorization_Service policy core (`auth/rbac.ts`)
  - [x] 1.1 Extend the `Module` union and add the SALES allow-list
    - Add `platform_tokens`, `document_catalog`, `knowledge_base` to the `Module` union type
    - Add the `SALES_CONFIG_GRANTS` table: `platform_tokens → {read, update}`, `document_catalog → {read, update}`, `knowledge_base → {read, create, update}`
    - In `authorize`, add the SALES branch that checks `SALES_CONFIG_GRANTS` first, then keeps the existing `lead_management` (assigned-only, `delete` → 403, `create` → 403) and `dashboard` (read-only, `company_stats` → 403, writes → 403) branches, and denies everything else by default
    - Keep `ADMIN → { allowed: true }` and the unknown-role fail-closed deny unchanged
    - Do not change the signatures of `authorize` / `isAssignedOwner` or the `AuthzDecision` / `ResourceTarget` / `AuthContext` types
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 2.3, 2.5, 5.1, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [x] 2. Add the `JobOrder.assignedTo` data-model change (`prisma/schema.prisma`)
  - [x] 2.1 Add the ownership field and migration
    - Add nullable `assignedTo String?` to the `JobOrder` model and `@@index([assignedTo])`
    - Run `npm run prisma:generate` to regenerate the Prisma client
    - Create a migration that adds the nullable column + index (non-destructive; existing rows get `assignedTo = null`)
    - _Requirements: 2.1, 2.3, 4.4_

- [x] 3. Extend the audit action taxonomy (`oversight/types.ts`)
  - [x] 3.1 Add new `ActivityAction` variants
    - Extend the `ActivityAction` union with `PLATFORM_TOKEN_REFRESHED`, `DOCUMENT_CATALOG_UPDATED`, `KNOWLEDGE_CREATED`, `KNOWLEDGE_UPDATED`, `KNOWLEDGE_DEACTIVATED`, and `AUTHZ_DENIED`
    - _Requirements: 7.1, 7.3_

- [x] 4. Add the denied-path audit hook to `rbacGuard` (`http/authMiddleware.ts`)
  - [x] 4.1 Add the optional `RbacAuditor` hook
    - Define the `RbacAuditor` interface with a fire-and-forget `recordDenied(...)` method that swallows its own errors and never blocks the response
    - Add an optional `auditor?: RbacAuditor` parameter to `rbacGuard`; call `auditor?.recordDenied(...)` on both the `target === undefined` deny path and the `authorize` deny path, before throwing `ForbiddenError`
    - Preserve existing behavior exactly when no auditor is injected (all current `rbacGuard` callers must keep compiling and behaving identically)
    - _Requirements: 4.5, 7.2, 7.3_

- [x] 5. Checkpoint - core policy, schema, and middleware compile
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Re-target the configuration-surface routes to the new fine-grained modules
  - [x] 6.1 Re-target Platform Tokens to `platform_tokens` (`platforms/routes.ts`)
    - Change the list guard `settings/read` → `platform_tokens/read` and the refresh guard `settings/update` → `platform_tokens/update`
    - On successful refresh, append a `PLATFORM_TOKEN_REFRESHED` audit record (`targetType: 'platform_token'`, `targetId: platform`, detail = status metadata only, no secret)
    - Leave `tokenManager.listPublic()` / `refresh()` unchanged (already returns secret-free `PublicTokenView`)
    - _Requirements: 1.1, 1.2, 1.3, 7.1, 7.4_

  - [x] 6.2 Re-target Document Catalog to `document_catalog` (`recruitment/documents/routes.ts`)
    - Change the catalog GET guard to `document_catalog/read` and the catalog PUT guard to `document_catalog/update`
    - On successful PUT, append a `DOCUMENT_CATALOG_UPDATED` audit record (`targetId: market`, metadata-only detail)
    - Leave the per-candidate checklist guards (`candidateTargetById` / `itemTargetById`) unchanged — they are already assigned-only
    - _Requirements: 1.4, 1.5, 3.7, 3.8, 7.1_

  - [x] 6.3 Re-target Knowledge Base routes to `knowledge_base` (`recruitment/agent/routes.ts`)
    - Change the three knowledge routes: GET `/knowledge` → `knowledge_base/read`, POST `/knowledge` → `knowledge_base/create`, PUT `/knowledge/:id` → `knowledge_base/update` (deactivate is `update` with `active:false`)
    - On each successful write, append `KNOWLEDGE_CREATED` / `KNOWLEDGE_UPDATED` / `KNOWLEDGE_DEACTIVATED` accordingly
    - Leave the consult/draft/suggest (`/api/v1/ai/*`) routes on `generation` and the assistant on `dashboard/read` unchanged
    - _Requirements: 1.6, 1.7, 1.8, 1.9, 7.1_

- [x] 7. Implement Job Order assigned-only scoping (Req 2)
  - [x] 7.1 Add `actor`-aware scoping to `JobOrderService` (`recruitment/jobOrderService.ts`)
    - Add an `actor` parameter to `list` / `search` / `stats`; when `actor.role === 'SALES'`, apply `where.assignedTo = actor.userId`
    - Add `actor` to `get`; when SALES and `order.assignedTo !== actor.userId`, throw `ForbiddenError`
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 7.2 Add the `jobOrderTargetById` builder and re-target routes (`recruitment/routes.ts`)
    - Add `jobOrderTargetById(action)` (mirror of `candidateTargetById`) resolving `ownerUserId` from `jobOrder.assignedTo`; apply to the `:id` routes (GET/PUT/`:id/close`)
    - Keep `collectionGuard('read')` on list/stats and pass `actor` (from `getAuth(request)`) into the `JobOrderService.list` / `stats` calls
    - Keep `collectionGuard('create'|'delete')` on create/delete so SALES still gets 403
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 8. Remove Recruitment Analytics access for SALES (Req 5) (`recruitment/routes.ts`)
  - [x] 8.1 Re-target the four analytics routes to `analytics/read`
    - Replace `collectionGuard('read')` (which maps to `lead_management`) with a guard for `analytics/read` on `/candidates/analytics/funnel`, `/by-market`, `/by-source`, and `/conversion-by-job-order`
    - Verify the deny happens at the preHandler stage (before any analytics query runs) so SALES → 403 and ADMIN → 200 unchanged
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 9. Implement Nurturing 1-1 assigned-only scoping (Req 3.5, 3.6)
  - [x] 9.1 Scope `FollowUpService.list` by candidate ownership (`intake/followUpService.ts`)
    - Add an `actor` parameter; when SALES, resolve owned candidate ids (`candidateProfile.assignedTo = actor.userId`) and constrain `where.candidateId = { in: ownedIds }` (tasks with no candidate are excluded — fail-closed)
    - _Requirements: 3.5, 3.6, 4.4_

  - [x] 9.2 Pass `actor` from follow-up routes (`intake/followUpRoutes.ts`)
    - Pass `actor = getAuth(request)` into `service.list(...)`; use `candidateTargetById('read'|'update')` on any per-candidate nurturing `:id` route so non-owners get 403; leave `scan`/`send-due`/`cancel` guards unchanged
    - _Requirements: 3.5, 3.6_

- [x] 10. Wire the AuthorizationAuditor into the app (`app.ts`)
  - [x] 10.1 Construct and inject the auditor
    - Create an `AuthorizationAuditor` that wraps `ActivityLogger` and implements `RbacAuditor.recordDenied` (appends an `AUTHZ_DENIED` record, `targetType: 'authorization'`, best-effort)
    - Inject it into the `rbacGuard` calls (at minimum the `lead_management` / job-order / candidate / analytics guards) so denied decisions are audited; confirm guards still work when the auditor append fails
    - _Requirements: 7.2, 7.3, 7.4_

- [x] 11. Checkpoint - all surfaces wired and building
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Property-based tests for the pure core (`test/sales-access-restrictions.properties.test.ts`)
  - [x] 12.1 Set up the property test file with fast-check
    - Create the test file next to `foundation.properties.test.ts`, importing `fast-check`; define generators: `fc.constantFrom(...)` for `Module` / `Action` / `Role`, `fc.option(fc.string())` for `ownerUserId`, `fc.array(fc.record({ assignedTo: fc.option(userIdArb) }))` for collections
    - Run every property with `numRuns >= 100`; tag each test `// Feature: sales-access-restrictions, Property {n}: ...`
    - _Requirements: 4.3_

  - [x]* 12.2 Write property test for the SALES decision table
    - **Property 1: SALES decision table — allow exactly equals the allow-set** (uses fast-check, `numRuns >= 100`)
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.5, 5.1, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7**

  - [x]* 12.3 Write property test for ADMIN always allowed
    - **Property 2: ADMIN is always allowed** (uses fast-check, `numRuns >= 100`)
    - **Validates: Requirements 1.10, 5.4**

  - [x]* 12.4 Write property test for lead_management owner-match
    - **Property 3: owner-match for lead_management (read/update/status_update)** (uses fast-check, `numRuns >= 100`)
    - **Validates: Requirements 2.3, 3.4, 3.5, 3.7, 3.8**

  - [x]* 12.5 Write property test for collection scoping
    - **Property 4: collection scoping — SALES results are a subset of the owned set** (uses fast-check, `numRuns >= 100`); test the pure filter/where-builder predicate over a generated resource array
    - **Validates: Requirements 2.1, 2.2, 2.4, 3.1, 3.2, 3.3, 3.6, 4.1, 4.2**

  - [x]* 12.6 Write property test for authorize determinism
    - **Property 5: `authorize` is deterministic** (uses fast-check, `numRuns >= 100`); call twice and deep-equal the decisions
    - **Validates: Requirements 4.3**

  - [x]* 12.7 Write property test for the isAssignedOwner helper
    - **Property 6: undefined owner never matches** (uses fast-check, `numRuns >= 100`)
    - **Validates: Requirements 4.4**

- [x] 13. Unit tests for service and shape behavior
  - [x]* 13.1 Write unit tests for token view and refresh metadata
    - Assert `PublicTokenView` has no secret fields; refresh returns metadata only
    - _Requirements: 1.1, 1.2_

  - [x]* 13.2 Write unit tests for KnowledgeService create/deactivate
    - `create` → `active = true`; `deactivate` → `active = false` with the row preserved (soft delete)
    - _Requirements: 1.6, 1.8_

  - [x]* 13.3 Write unit tests for FollowUpService.list scoping
    - With fixed data, SALES sees only tasks for owned candidates; tasks without a candidate are excluded
    - _Requirements: 3.6, 4.4_

  - [x]* 13.4 Write unit test for audit detail containing no secrets
    - Assert audit `detail` carries metadata only (platform name, market, entry id, module/action), never token values
    - _Requirements: 7.4_

- [x] 14. Integration and route-level tests
  - [x]* 14.1 Write integration test for recruitment analytics deny
    - SALES → 403 and the analytics service is NOT called (spy); ADMIN → 200 with full data
    - _Requirements: 5.1, 5.2, 5.4_

  - [x]* 14.2 Write route tests for fail-closed and state-preservation
    - Guard builder error → 403 with no data body; on 403 the handler/service does not run and data is unchanged
    - _Requirements: 4.5, 6.7, 7.2_

  - [x]* 14.3 Write integration tests for audit success and denied paths
    - Success: one complete `*_REFRESHED`/`*_UPDATED`/`KNOWLEDGE_*` record after a management action; denied: one complete `AUTHZ_DENIED` record on 403; `ActivityLogger.listRecent` returns required fields for ADMIN
    - _Requirements: 7.1, 7.3, 7.5_

  - [x]* 14.4 Write regression test that `settings` stays ADMIN-only for SALES
    - SALES still gets 403 on partners-write and privacy/GDPR routes (no privilege escalation from the new modules)
    - _Requirements: 6.5_

- [ ] 15. Final checkpoint - verification
  - [x] 15.1 Run build, tests, and lint
    - Run `npm run build`, `npm test`, and `npm run lint` in `autotgc-backend`
    - Confirm existing regression suites stay green (`dashboard-rbac.regression.test.ts`, `foundation.properties.test.ts`)
    - Fix any failures before completing
    - _Requirements: 4.3, 5.4, 6.5_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP, but they validate the correctness properties and the testing matrix from the design.
- Each task references specific requirement sub-clauses for traceability.
- Property tests (12.2–12.7) use `fast-check` with `numRuns >= 100` and map one-to-one to the six correctness properties in the design.
- The single data-model change is `JobOrder.assignedTo` (nullable + index); the migration is non-destructive.
- The `settings`, `generation`, `strategy`, `publishing`, `feedback`, `analytics`, and `user_management` modules remain deny-by-default for SALES.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 1, "tasks": ["4.1"] },
    { "id": 2, "tasks": ["6.1", "6.2", "6.3", "7.1", "9.1"] },
    { "id": 3, "tasks": ["7.2", "9.2"] },
    { "id": 4, "tasks": ["8.1"] },
    { "id": 5, "tasks": ["10.1"] },
    { "id": 6, "tasks": ["12.1", "13.1", "13.2", "13.3", "13.4"] },
    { "id": 7, "tasks": ["12.2", "12.3", "12.4", "12.5", "12.6", "12.7"] },
    { "id": 8, "tasks": ["14.1", "14.2", "14.3", "14.4"] },
    { "id": 9, "tasks": ["15.1"] }
  ]
}
```
