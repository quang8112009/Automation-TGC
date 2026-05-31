# Requirements Document

## Introduction

This document specifies the requirements for the **Content Pipeline** module of the AutoTGC AI content-marketing automation platform. This is the second of four planned specs and covers the full content lifecycle for **Phase 1**: from content strategy (personas and the content calendar), through AI content generation and human review, to scheduling and automated publishing across Facebook, TikTok, and the Custom CMS Website.

This module depends on the **Foundation & Deployment** module (spec 1) and does not re-specify its capabilities. The following are assumed to exist and are referenced rather than redefined:

- **Authentication & RBAC** — JWT sessions, the ADMIN (Content Manager) and SALES roles, authentication enforcement on protected endpoints, and the role-based access policy.
- **Platform_Adapter interface and registry** — the uniform publishing/analytics interface for Facebook, TikTok, and the Custom CMS, and routing of unsupported platforms/operations to HTTP 400.
- **Token_Manager and Platform_Token lifecycle** — storage of platform credentials, validity checks, proactive refresh, and the on-demand refresh endpoint.
- **Service_Account identities** — the AI System and the Background Worker non-interactive identities.
- **Gemini integration foundation** — the configured Google Gemini access used for AI generation (model `gemini-2.5-flash`).

The module addresses Phase 1 platforms only (Facebook, TikTok, Website). Video production and editing are out of scope for Phase 1; the system handles text generation and user-supplied media.

Source of truth: the use case documents in `Content_Strategy/`, `Content_Generation/`, and `Publishing/`, and `API_Catalog.md` (internal APIs `/api/strategy/*`, `/api/generation/generate`, `/api/publishing/*`, `/api/media`, and the platform publish endpoints).

## Glossary

- **AutoTGC_Backend**: The backend application (defined in the Foundation & Deployment module) that hosts the internal AutoTGC APIs, including the Content Pipeline endpoints.
- **Content_Manager**: The human operator holding the ADMIN role (defined in Foundation), who defines strategy, generates and reviews content, and schedules publishing.
- **Persona_Manager**: The component of AutoTGC_Backend responsible for creating, editing, and validating Content_Personas and serving persona AI recommendations (`/api/strategy/persona/*`).
- **Content_Persona**: A persisted record describing a target customer profile for one Domain, containing a persona name, age, interests, target needs, pain points, and a tone-of-voice.
- **Domain**: A service area for which content is produced (for example XKLĐ or Du học), identified by a Domain name.
- **Domain_Context**: The persisted descriptive context for a Domain used as input to AI generation.
- **Tone_Of_Voice**: The writing style assigned to a Content_Persona (for example friendly, expert, inspirational).
- **Calendar_Manager**: The component of AutoTGC_Backend that presents and updates the Content_Calendar (`/api/strategy/calendar`).
- **Content_Calendar**: The scheduling view that displays Content_Drafts and Scheduled_Posts organized by date.
- **Generation_Service**: The component of AutoTGC_Backend that produces AI content via Google Gemini (`/api/generation/generate`).
- **AI_Prompt_Context**: The enriched generation context (top performing topics, best CTA patterns, avoid topics, and optimal content length per platform) produced by the Analytics Feedback Loop and read from `/api/strategy/ai-context`.
- **Default_Context**: The fallback generation context composed of the selected Content_Persona, the Domain_Context, and a default Tone_Of_Voice, used when AI_Prompt_Context is empty or incomplete.
- **Objective**: The conversion goal of a generated content item, one of Lead, View, or Follow.
- **Content_Draft**: A persisted unit of generated content consisting of a Title, a Body, and at least one CTA, together with its lifecycle status.
- **CTA**: A Call-to-Action contained within a Content_Draft.
- **Draft_Manager**: The component of AutoTGC_Backend that lists, views, edits, and deletes Content_Drafts.
- **Review_Service**: The component of AutoTGC_Backend that handles approval and rejection of Content_Drafts.
- **Media_Service**: The component of AutoTGC_Backend that stores Media_Assets and attaches them to Content_Drafts (`/api/media`).
- **Media_Asset**: A user-supplied image or video attached to a Content_Draft.
- **Platform**: An external publishing destination; in Phase 1 one of Facebook, TikTok, or Website.
- **Scheduling_Service**: The component of AutoTGC_Backend that creates Scheduled_Posts from approved Content_Drafts (`/api/publishing/schedule`) and reschedules failed posts (`/api/publishing/scheduled/{id}/retry`).
- **Scheduled_Post**: A persisted record pairing one Content_Draft with one Platform and a scheduled publish time, carrying its own lifecycle status and idempotency key.
- **Publishing_Worker**: The Background Worker (a Service_Account defined in Foundation) that scans due Scheduled_Posts and executes publishing (`/api/publishing/post`).
- **Idempotency_Key**: A unique value assigned to each Scheduled_Post and sent with each publish request to prevent duplicate external posts.
- **Platform_Adapter**: The Foundation component that performs publishing against one Platform.
- **Token_Manager**: The Foundation component that manages Platform_Token validity and refresh.
- **Platform_Token**: The Foundation-managed credential for a Platform.
- **Content_Status**: The lifecycle state of a Content_Draft or Scheduled_Post, one of DRAFT, APPROVED, SCHEDULED, PUBLISHING, PUBLISHED, REJECTED, or FAILED.
- **Transient_Error**: A publishing failure caused by a network error, an HTTP 429 response, or an HTTP 5xx response.
- **Hard_Error**: A publishing failure caused by an HTTP 4xx response other than 429, or a platform content-policy violation.

## Requirements

### Requirement 1: Define Content Persona

**User Story:** As a Content_Manager, I want to define a content persona and strategy for a domain, so that the AI has a target customer profile to guide generation.

#### Acceptance Criteria

1. WHEN a Content_Manager submits a new Content_Persona for a Domain with a persona name, an age, interests, target needs, pain points, and a Tone_Of_Voice, THE Persona_Manager SHALL validate the submission against the rules defined in criteria 2 through 4.
2. IF the submitted Domain name is empty or consists only of whitespace, THEN THE Persona_Manager SHALL reject the submission with HTTP status 400 and an error message indicating the Domain name is required, and SHALL NOT create a Content_Persona.
3. IF the submitted Tone_Of_Voice is empty or consists only of whitespace, THEN THE Persona_Manager SHALL reject the submission with HTTP status 400 and an error message indicating the Tone_Of_Voice is required, and SHALL NOT create a Content_Persona.
4. IF the submitted Content_Persona does not specify all three of an age, target needs, and pain points, THEN THE Persona_Manager SHALL reject the submission with HTTP status 400 and an error message indicating at least the age, target needs, and pain points are required, and SHALL NOT create a Content_Persona.
5. WHEN a submitted Content_Persona passes the rules defined in criteria 2 through 4, THE Persona_Manager SHALL persist the Content_Persona associated with its Domain and make it available as generation context.

### Requirement 2: Edit Existing Persona

**User Story:** As a Content_Manager, I want to edit an existing persona, so that I can refine the target profile as the strategy evolves.

#### Acceptance Criteria

1. IF the targeted Content_Persona does not exist, THEN THE Persona_Manager SHALL respond with HTTP status 404 and SHALL NOT modify any Content_Persona.
2. WHEN a Content_Manager submits updated attributes for an existing Content_Persona, THE Persona_Manager SHALL confirm the Content_Persona exists and then validate the updated attributes against the rules defined in Requirement 1 criteria 2 through 4.
3. WHEN updated attributes for an existing Content_Persona pass validation, THE Persona_Manager SHALL persist the updated attributes to that Content_Persona.

### Requirement 3: AI Persona Recommendation

**User Story:** As a Content_Manager, I want the AI to suggest a persona for a domain, so that I can start from a data-informed profile instead of a blank form.

#### Acceptance Criteria

1. WHEN a Content_Manager requests a persona recommendation for a Domain, THE Persona_Manager SHALL request from Google Gemini a proposed set of persona attributes consisting of an age, interests, target needs, pain points, and a Tone_Of_Voice for that Domain.
2. WHEN Google Gemini returns a proposed set of persona attributes, THE Persona_Manager SHALL present the proposed attributes to the Content_Manager without persisting a Content_Persona.
3. WHEN a Content_Manager accepts the proposed attributes in full, THE Persona_Manager SHALL persist a Content_Persona from the proposed attributes after applying the validation rules defined in Requirement 1 criteria 2 through 4.
4. WHEN a Content_Manager edits the proposed attributes before confirming, THE Persona_Manager SHALL persist a Content_Persona from the edited attributes after applying the validation rules defined in Requirement 1 criteria 2 through 4.
5. WHEN a Content_Manager rejects the proposed attributes, THE Persona_Manager SHALL discard the proposed attributes and SHALL NOT create or modify any Content_Persona.
6. IF the persona recommendation request to Google Gemini fails, THEN THE Persona_Manager SHALL return an error message to the Content_Manager and SHALL leave existing Content_Personas unchanged.

### Requirement 4: View Content Calendar

**User Story:** As a Content_Manager, I want to view scheduled and published content on a calendar, so that I can see the publishing plan at a glance.

#### Acceptance Criteria

1. WHEN a Content_Manager opens the Content_Calendar, THE Calendar_Manager SHALL present the content in a month view, a week view, and a day view, and SHALL present whichever of those views are available when one or more views fail to load.
2. WHEN THE Calendar_Manager displays a Content_Draft or a Scheduled_Post on the Content_Calendar, THE Calendar_Manager SHALL apply a distinct color for each of the Content_Status values SCHEDULED, PUBLISHED, DRAFT, and FAILED.
3. WHEN THE Calendar_Manager displays a Scheduled_Post on the Content_Calendar, THE Calendar_Manager SHALL display the Platform of that Scheduled_Post as one of Facebook, TikTok, or Website.

### Requirement 5: Drag-and-Drop Rescheduling

**User Story:** As a Content_Manager, I want to drag a scheduled post to a new time on the calendar, so that I can adjust the plan quickly.

#### Acceptance Criteria

1. WHERE a Scheduled_Post has the Content_Status SCHEDULED, WHEN a Content_Manager drags that Scheduled_Post to a new publish time that is later than the current time, THE Calendar_Manager SHALL update the scheduled publish time of that Scheduled_Post and confirm the change.
2. IF a Content_Manager drags a Scheduled_Post to a new publish time that is not later than the current time, THEN THE Calendar_Manager SHALL reject the change with an error message indicating the time is invalid and SHALL NOT update the scheduled publish time.
3. IF a Content_Manager attempts to reschedule by drag-and-drop a post whose Content_Status is not SCHEDULED, THEN THE Calendar_Manager SHALL reject the change and SHALL NOT update the scheduled publish time.

### Requirement 6: Generate AI Content

**User Story:** As a Content_Manager, I want to generate marketing content with AI for a chosen domain, persona, and objective, so that I can produce drafts quickly.

#### Acceptance Criteria

1. WHEN a Content_Manager requests content generation, THE Generation_Service SHALL require the selection of a Domain, the selection of at least one defined Content_Persona, and an Objective.
2. IF a content generation request omits the Objective, THEN THE Generation_Service SHALL reject the request with HTTP status 400 and an error message indicating the Objective is required, and SHALL NOT generate content.
3. IF a content generation request omits a Content_Persona selection, THEN THE Generation_Service SHALL reject the request with HTTP status 400 and an error message indicating a Content_Persona is required, and SHALL NOT generate content.
4. WHEN a content generation request specifies an Objective, THE Generation_Service SHALL accept the Objective only when its value is one of Lead, View, or Follow.
5. WHEN a content generation request is valid, THE Generation_Service SHALL load the AI_Prompt_Context from `/api/strategy/ai-context`, comprising top performing topics, best CTA patterns, avoid topics, and optimal content length per Platform.
6. WHEN THE Generation_Service constructs the Gemini prompt, THE Generation_Service SHALL order the prompt as an expert role, then the Domain_Context, then the selected Content_Persona, then the Tone_Of_Voice, then the Objective, then the available performance context from the AI_Prompt_Context, then a required-CTA instruction derived from the best CTA patterns.
7. WHEN THE Generation_Service generates content, THE Generation_Service SHALL call Google Gemini using the model `gemini-2.5-flash`.
8. WHEN Google Gemini returns generated content, THE Generation_Service SHALL produce a Content_Draft containing a Title, a Body, and at least one CTA.
9. WHEN THE Generation_Service produces a Content_Draft, THE Generation_Service SHALL persist that Content_Draft with the Content_Status DRAFT.
10. IF the content generation request to Google Gemini fails, THEN THE Generation_Service SHALL return an error message to the Content_Manager indicating generation failed and SHALL NOT persist a Content_Draft.

### Requirement 7: Cold-Start Generation Fallback

**User Story:** As a Content_Manager, I want content generation to work even before any analytics feedback exists, so that I am not blocked during the early stage of the platform.

#### Acceptance Criteria

1. IF the AI_Prompt_Context is empty or missing one or more of its performance fields when content generation runs, THEN THE Generation_Service SHALL construct the prompt from the Default_Context comprising the selected Content_Persona, the Domain_Context, and a default Tone_Of_Voice, and SHALL complete generation.
2. WHEN THE Generation_Service generates a Content_Draft using the Default_Context, THE Generation_Service SHALL mark that Content_Draft as `generated_without_feedback`.
3. WHEN the AI_Prompt_Context is empty or incomplete, THE Generation_Service SHALL omit the performance-context portion of the prompt and SHALL NOT fail generation because the AI_Prompt_Context is unavailable.

### Requirement 8: Attach Media Asset

**User Story:** As a Content_Manager, I want to attach an image or video to a draft, so that the content meets each platform's media requirements.

#### Acceptance Criteria

1. THE Generation_Service SHALL produce text content only, consisting of a Title, a Body, and at least one CTA.
2. WHEN a Content_Manager uploads an image or a video for a Content_Draft through `/api/media`, THE Media_Service SHALL store the file as a Media_Asset and attach it to that Content_Draft.
3. THE Media_Service SHALL accept image Media_Assets and video Media_Assets as user-supplied files.

### Requirement 9: Manage Content Drafts

**User Story:** As a Content_Manager, I want to list, view, edit, and delete drafts, so that I can manage generated content before it is approved.

#### Acceptance Criteria

1. WHEN a Content_Manager requests the list of Content_Drafts, THE Draft_Manager SHALL return the Content_Drafts with their Title and Content_Status.
2. WHEN a Content_Manager opens a Content_Draft, THE Draft_Manager SHALL return the Title, the Body, and the CTA of that Content_Draft.
3. WHERE a Content_Draft has the Content_Status DRAFT, WHEN a Content_Manager submits edits to its Title, Body, or CTA, THE Draft_Manager SHALL persist the edited Content_Draft.
4. IF a Content_Manager submits edits to a Content_Draft whose Content_Status is not DRAFT, THEN THE Draft_Manager SHALL reject the edit with HTTP status 409 and SHALL NOT modify that Content_Draft.
5. WHEN a Content_Manager requests deletion of a Content_Draft, THE Draft_Manager SHALL require an explicit confirmation before deletion.
6. WHEN a Content_Manager confirms deletion of a Content_Draft, THE Draft_Manager SHALL delete that Content_Draft.

### Requirement 10: Approve or Reject Draft

**User Story:** As a Content_Manager, I want to preview and then approve or reject a draft, so that only reviewed content proceeds to scheduling.

#### Acceptance Criteria

1. WHEN a Content_Manager selects a Content_Draft for review, THE Review_Service SHALL present a preview of the content before an approve or reject action is available.
2. IF a Content_Manager attempts to approve or reject a Content_Draft without the preview having been presented, THEN THE Review_Service SHALL reject the action and SHALL NOT change the Content_Status.
3. IF a Content_Manager attempts to approve or reject a Content_Draft whose Content_Status is not DRAFT, THEN THE Review_Service SHALL reject the action with HTTP status 409 and SHALL NOT change the Content_Status.
4. WHEN a Content_Manager approves a Content_Draft whose Content_Status is DRAFT, THE Review_Service SHALL set the Content_Status of that Content_Draft to APPROVED.
5. IF a Content_Manager rejects a Content_Draft without providing a rejection reason, THEN THE Review_Service SHALL reject the action with HTTP status 400 and an error message indicating a reason is required, and SHALL NOT change the Content_Status.
6. WHEN a Content_Manager rejects a Content_Draft and provides a rejection reason, THE Review_Service SHALL store the rejection reason and set the Content_Status of that Content_Draft to DRAFT so that the Content_Draft is editable again.

### Requirement 11: Content Status Lifecycle

**User Story:** As a platform architect, I want a well-defined content state machine, so that content cannot enter invalid states and publishing cannot get stuck.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL permit a Content_Status transition from DRAFT to APPROVED, from APPROVED to SCHEDULED, from SCHEDULED to PUBLISHING, and from PUBLISHING to PUBLISHED.
2. THE AutoTGC_Backend SHALL permit a Content_Status transition from DRAFT to REJECTED and from REJECTED to DRAFT.
3. THE AutoTGC_Backend SHALL permit a Content_Status transition from PUBLISHING to FAILED and from FAILED to SCHEDULED.
4. IF a Content_Status transition that is not defined in criteria 1 through 3 is requested, THEN THE AutoTGC_Backend SHALL reject the transition with HTTP status 409 and SHALL NOT change the Content_Status.

### Requirement 12: Scheduling Flow

**User Story:** As a Content_Manager, I want to schedule an approved draft to one or more platforms at a future time, so that it is published automatically.

#### Acceptance Criteria

1. IF a scheduling request targets a Content_Draft whose Content_Status is not APPROVED, THEN THE Scheduling_Service SHALL reject the request with HTTP status 409 and an error message indicating the Content_Draft is not approved, and SHALL NOT create a Scheduled_Post.
2. WHEN a Content_Manager schedules an approved Content_Draft to one or more selected Platforms, THE Scheduling_Service SHALL create one Scheduled_Post for each pair of the Content_Draft and a selected Platform.
3. WHERE a selected Platform is TikTok, IF the Content_Draft does not have an attached Media_Asset that is a video or a photo-carousel, THEN THE Scheduling_Service SHALL reject scheduling for that Platform with an error message indicating media is required, and SHALL NOT create the Scheduled_Post for that Platform.
4. WHERE a selected Platform is TikTok, IF the content description for that Scheduled_Post is 2200 characters or more including hashtags, THEN THE Scheduling_Service SHALL reject scheduling for that Platform with an error message indicating the content-length limit is exceeded, and SHALL NOT create the Scheduled_Post for that Platform.
5. IF the requested publish time for a Scheduled_Post is not later than the current time, THEN THE Scheduling_Service SHALL reject scheduling with an error message indicating the time is invalid and SHALL NOT create the Scheduled_Post.
6. WHEN THE Scheduling_Service creates a Scheduled_Post, THE Scheduling_Service SHALL assign that Scheduled_Post a unique Idempotency_Key and set its Content_Status to SCHEDULED.

### Requirement 13: Execution Scan and Idempotency Lock

**User Story:** As a platform operator, I want the worker to lock each due post before posting, so that no post is published twice by concurrent processes.

#### Acceptance Criteria

1. THE Publishing_Worker SHALL scan for Scheduled_Posts whose Content_Status is SCHEDULED and whose scheduled publish time is at or before the current time.
2. WHEN THE Publishing_Worker selects a due Scheduled_Post, THE Publishing_Worker SHALL atomically transition that Scheduled_Post from SCHEDULED to PUBLISHING and acquire its idempotency lock before invoking any Platform_Adapter operation, and SHALL perform the transition and lock acquisition only for a Scheduled_Post it has selected.
3. IF a Scheduled_Post is already in the PUBLISHING state or its idempotency lock is held by another process, THEN THE Publishing_Worker SHALL NOT invoke a Platform_Adapter operation for that Scheduled_Post.

### Requirement 14: Token Validation Before Publishing

**User Story:** As a platform operator, I want the worker to verify the platform token before posting, so that a dead token fails fast with an alert instead of a blind retry.

#### Acceptance Criteria

1. WHEN THE Publishing_Worker prepares to publish a Scheduled_Post, THE Publishing_Worker SHALL check the validity of the Platform_Token for that Platform through the Token_Manager before invoking the Platform_Adapter.
2. IF the Platform_Token is expired or invalid, THEN THE Publishing_Worker SHALL request a refresh of the Platform_Token through the Token_Manager.
3. IF the Platform_Token refresh fails, THEN THE Publishing_Worker SHALL set the Content_Status of that Scheduled_Post to FAILED with the reason TOKEN_EXPIRED, SHALL raise an alert to the Content_Manager, and SHALL NOT invoke the Platform_Adapter.

### Requirement 15: Publish Execution and Success Recording

**User Story:** As a Content_Manager, I want successful posts recorded with their platform IDs, so that I can trace and later collect analytics for each post.

#### Acceptance Criteria

1. WHEN THE Publishing_Worker invokes the Platform_Adapter to publish a Scheduled_Post, THE Publishing_Worker SHALL include the Idempotency_Key of that Scheduled_Post in the publish request.
2. WHEN the Platform_Adapter reports a successful publish, THE Publishing_Worker SHALL set the Content_Status of that Scheduled_Post to PUBLISHED, even if storing the returned identifiers does not succeed.
3. WHEN the Platform_Adapter reports a successful publish and returns both an external Post identifier and a post URL, THE Publishing_Worker SHALL store the external Post identifier and the post URL for that Scheduled_Post.

### Requirement 16: Publishing Retry and Error Classification

**User Story:** As a platform operator, I want transient errors retried and hard errors failed immediately, so that the system recovers from blips without hammering platforms on permanent errors.

#### Acceptance Criteria

1. IF a publish attempt fails with a Transient_Error, THEN THE Publishing_Worker SHALL retry the publish attempt using exponential backoff, up to a maximum of 3 retries.
2. IF a publish attempt fails with a Transient_Error and 3 retries have already been attempted, THEN THE Publishing_Worker SHALL set the Content_Status of that Scheduled_Post to FAILED, store the error code, and raise an alert to the Content_Manager as a single combined operation, and IF any one of those actions does not succeed, THEN THE Publishing_Worker SHALL leave the Content_Status of that Scheduled_Post unchanged.
3. IF a publish attempt fails with a Hard_Error, THEN THE Publishing_Worker SHALL set the Content_Status of that Scheduled_Post to FAILED, store the error code, raise an alert to the Content_Manager, and SHALL NOT retry the publish attempt.

### Requirement 17: Duplicate-Post Prevention

**User Story:** As a platform operator, I want idempotency to prevent duplicate posts when a database update is lost after a successful post, so that the same content is never published twice.

#### Acceptance Criteria

1. WHEN THE Publishing_Worker re-scans a Scheduled_Post that is in the PUBLISHING state and an external Post identifier already exists for that Scheduled_Post's Idempotency_Key, THE Publishing_Worker SHALL set the Content_Status of that Scheduled_Post to PUBLISHED using the existing external Post identifier and SHALL NOT submit a new publish request.
2. WHEN THE Publishing_Worker submits a publish request that carries an Idempotency_Key already used for a successful publish on that Platform, THE Publishing_Worker SHALL treat the response as the original successful publish and SHALL NOT create an additional external post.

### Requirement 18: Failed Post Recovery

**User Story:** As a Content_Manager, I want to fix and reschedule a failed post, so that content that failed to publish can be published after correction.

#### Acceptance Criteria

1. WHEN a Content_Manager submits a reschedule request for a Scheduled_Post whose Content_Status is FAILED with a future publish time, THE Scheduling_Service SHALL set the Content_Status of that Scheduled_Post to SCHEDULED with the new publish time.
2. IF a reschedule request for a FAILED Scheduled_Post specifies a publish time that is not later than the current time, THEN THE Scheduling_Service SHALL reject the request with an error message indicating the time is invalid and SHALL NOT change the Content_Status.
3. IF a Content_Manager edits a FAILED Scheduled_Post and the edited Scheduled_Post does not pass the validation rules defined in Requirement 12 criteria 3 through 5, THEN THE Scheduling_Service SHALL reject the reschedule request and SHALL NOT change the Content_Status until the validation issues are corrected.

### Requirement 19: Access Control for Content Pipeline Endpoints

**User Story:** As a security administrator, I want the content pipeline endpoints protected by the platform's existing authentication and authorization, so that only permitted identities operate on content.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL treat the Content Pipeline endpoints under `/api/strategy/*`, `/api/generation/*`, `/api/publishing/*`, and `/api/media` as protected endpoints requiring a valid Access_Token, as defined in the Foundation & Deployment module.
2. IF a request to a Content Pipeline endpoint is authenticated with the SALES role, THEN THE AutoTGC_Backend SHALL deny the request with HTTP status 403 and SHALL NOT process the request.
3. WHEN THE Publishing_Worker invokes `/api/publishing/post`, THE Publishing_Worker SHALL authenticate as the Background Worker Service_Account defined in the Foundation & Deployment module.
