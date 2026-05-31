# Requirements Document

## Introduction

This document specifies the requirements for the **Lead Management & Operational Dashboard** module of the AutoTGC AI content-marketing automation platform. This is the fourth and final of four planned specs. It covers two concern areas:

1. **Lead Management** — a self-built lead-tracking system (no external CRM) that ingests leads from Facebook Leadgen webhooks, Custom CMS website form webhooks, and TikTok bio-link traffic (captured through the website form with UTM attribution); stores, filters, updates, deletes, exports, and aggregates leads; enforces a lead status lifecycle; and links every lead to its originating content post so the Analytics & Feedback Loop module can attribute conversions.
2. **Operational Dashboard** — an aggregated overview that surfaces KPI charts (View, Lead, Follow), the approval queue (drafts awaiting approval and AI insights pending review), upcoming scheduled posts, failed-post and token-expiry alerts, a data-synchronization freshness warning, and a notifications channel for administrators.

This module depends on the three earlier modules and does **not** re-specify their capabilities. The following are assumed to exist and are referenced rather than redefined:

**From the Foundation & Deployment module (spec 1):**
- **Authentication & RBAC** — JWT sessions, the ADMIN (Content Manager) and SALES (Sales/Consultant) roles, authentication enforcement on protected endpoints, and the role-based access policy (ADMIN full access; SALES limited to assigned leads and read-only Dashboard).
- **Webhook signature verification** — the HMAC signature verification applied to every Webhook_Endpoint, the rejection of unverified requests with HTTP 401, and the reading of each webhook shared secret from the Secret_Store.
- **Service_Account identities** — the Background Worker non-interactive identity used by scheduled and background processes.
- **Alert Dispatcher and Token_Manager** — the Dashboard notifications channel that delivers ADMIN alerts, plus the Token_Manager that raises platform token-expiry warnings and refresh-failure alerts.
- **REST API conventions** — JSON responses, the standard HTTP status code set, and the pagination contract (`page` and `limit` query parameters with a total record count in the response).

**From the Content Pipeline module (spec 2):**
- **Content_Draft / Scheduled_Post and Content_Status** — the content lifecycle states DRAFT, APPROVED, SCHEDULED, PUBLISHING, PUBLISHED, REJECTED, and FAILED, including the FAILED reason TOKEN_EXPIRED.
- **Content_Calendar** — the scheduling view of Content_Drafts and Scheduled_Posts organized by date.

**From the Analytics & Feedback Loop module (spec 3):**
- **Analytics_Record / Performance_Record** — the collected raw metrics (views, follows, leads, and so on) and derived performance data.
- **Learning_Insight and Insight_Status** — the AI insights and their lifecycle states, including PENDING_REVIEW.
- **Conversion_Rate** — `(leads / views) * 100`, computed by the Scoring_Engine from lead counts attributed to a post.
- **Collection_Cycle** — the standardized 6-hour interval at which the Collection_Service refreshes analytics data.

The module addresses Phase 1 platforms only: Facebook, TikTok, and the Custom CMS Website.

Source of truth: `Lead_Management/Manage_Leads.md`, `Operational_Dashboard/View_Operational_Dashboard.md`, and `API_Catalog.md` (section 3.2 Lead Management APIs, the Lead Data Model, the Lead Status Flow, and the internal APIs `/api/leads/*` and `/api/dashboard/*`).

## Glossary

- **AutoTGC_Backend**: The backend application (defined in the Foundation & Deployment module) that hosts the internal AutoTGC APIs, including the Lead Management and Dashboard endpoints.
- **Content_Manager**: The human operator holding the ADMIN role (defined in Foundation), granted full access to Lead Management and the Dashboard.
- **Sales_Consultant**: The human operator holding the SALES role (defined in Foundation), granted access to update assigned leads and read-only access to the Dashboard.
- **Lead_Service**: The component of AutoTGC_Backend that creates, reads, updates, deletes, aggregates, and exports Leads (`/api/leads/*`).
- **Lead**: A persisted record representing a prospective customer, containing a lead_id, name, phone, email, Lead_Source, Lead_Platform, utm_source, utm_medium, utm_campaign, content_post_id, domain_category, content_topic, Lead_Status, note, assigned_to, created_at, and updated_at.
- **Lead_Id**: The unique identifier assigned to a Lead.
- **Lead_Source**: The acquisition channel of a Lead, one of `facebook_leadgen`, `website_form`, `tiktok_bio`, or `direct_message`.
- **Lead_Platform**: The originating platform of a Lead, one of `facebook`, `tiktok`, or `website`.
- **Lead_Status**: The lifecycle state of a Lead, one of NEW, CONTACTED, QUALIFIED, CONVERTED, or LOST.
- **Active_Lead_Status**: A Lead_Status that is not terminal, one of NEW, CONTACTED, or QUALIFIED.
- **Terminal_Lead_Status**: A Lead_Status from which no further transition is permitted, one of CONVERTED or LOST.
- **Content_Post_Id**: The identifier of the published content post that produced a Lead, used to attribute the Lead to its originating content for ROI and conversion measurement.
- **Lead_History_Entry**: A persisted, append-only record of one change to a Lead, capturing the previous Lead_Status, the new Lead_Status, the note, the assigned_to value, the acting identity, and the change timestamp.
- **Interaction_History**: The ordered collection of Lead_History_Entries for one Lead.
- **Lead_Webhook**: A signature-verified Webhook_Endpoint (defined in Foundation) that ingests inbound leads, one of the Facebook_Leadgen_Webhook or the Website_Form_Webhook.
- **Facebook_Leadgen_Webhook**: The Lead_Webhook at `/api/leads/webhook/facebook` that ingests leads in the Facebook Leadgen format.
- **Website_Form_Webhook**: The Lead_Webhook at `/api/leads/webhook/website` that ingests leads from Custom CMS website form submissions, including TikTok bio-link traffic carrying a `tiktok_bio` source.
- **Lead_Filter**: The set of query parameters that constrain a lead listing: Lead_Source, Lead_Platform, Lead_Status, and a date range (`from` and `to`).
- **Lead_Stats**: An aggregation of Lead counts grouped by a Group_Dimension over a date range.
- **Group_Dimension**: One of `source`, `platform`, or `date`, used to group Lead_Stats.
- **Export_File**: A downloadable file of Leads produced by the Lead_Service in CSV or Excel (`xlsx`) format.
- **Dashboard_Service**: The component of AutoTGC_Backend that assembles the Dashboard_Overview and the Notifications_Channel (`/api/dashboard/*`).
- **Dashboard_Overview**: The aggregated read model returned by `/api/dashboard/overview`, composed of the KPI_Overview, the Approval_Queue, the Upcoming_Posts, the Alert_Section, and the Data_Sync_Status.
- **KPI_Overview**: The set of summary charts for View, Lead, and Follow metrics, also referred to as the Lead Overview.
- **Approval_Queue**: The combined list of Content_Drafts whose Content_Status is DRAFT awaiting approval and Learning_Insights whose Insight_Status is PENDING_REVIEW.
- **Upcoming_Posts**: The Scheduled_Posts whose Content_Status is SCHEDULED and whose scheduled publish time falls within the next 7 days.
- **Alert_Section**: The Dashboard area that lists Scheduled_Posts whose Content_Status is FAILED with their failure reason, together with platform token-expiry warnings.
- **Data_Sync_Status**: The Dashboard indicator reporting the timestamp of the most recent analytics synchronization and whether the data is current.
- **Last_Sync_Time**: The timestamp of the most recent successful analytics synchronization performed by the Collection_Service on its Collection_Cycle.
- **Sync_Staleness_Threshold**: The configurable maximum age of synchronized data before the Data_Sync_Status reports the data as not current, defaulting to 6 hours.
- **Notifications_Channel**: The read model returned by `/api/dashboard/notifications` that delivers ADMIN alerts, including token-expiry warnings, publish-failure alerts, and insights-pending-review notifications.

## Requirements

### Requirement 1: Create Lead

**User Story:** As a Content_Manager, I want leads created from inbound sources with their originating content captured, so that every lead can be measured against the content that produced it.

#### Acceptance Criteria

1. WHEN a lead-creation request is submitted to `/api/leads` with at least one contact value among phone and email, a Lead_Source, a Lead_Platform, and a Content_Post_Id, THE Lead_Service SHALL create a Lead and assign it a unique Lead_Id.
2. WHEN THE Lead_Service creates a Lead, THE Lead_Service SHALL set the Lead_Status of that Lead to NEW.
3. WHEN THE Lead_Service creates a Lead, THE Lead_Service SHALL record the created_at timestamp and set the updated_at timestamp equal to the created_at timestamp.
4. IF a lead-creation request omits both a phone and an email, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and an error message indicating at least one contact value is required, and SHALL NOT create a Lead.
5. IF a lead-creation request omits the Content_Post_Id, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and an error message indicating the Content_Post_Id is required, and SHALL NOT create a Lead.
6. IF a lead-creation request specifies a Lead_Source that is not one of `facebook_leadgen`, `website_form`, `tiktok_bio`, or `direct_message`, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and an error message identifying the invalid Lead_Source, and SHALL NOT create a Lead.
7. IF a lead-creation request specifies a Lead_Platform that is not one of `facebook`, `tiktok`, or `website`, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and an error message identifying the invalid Lead_Platform, and SHALL NOT create a Lead.
8. WHEN a lead-creation request includes utm_source, utm_medium, or utm_campaign values, THE Lead_Service SHALL store those values on the created Lead.
9. IF storing the utm_source, utm_medium, or utm_campaign values fails after a Lead is created, THEN THE Lead_Service SHALL complete the Lead creation and SHALL record the UTM-storage failure without discarding the created Lead.

### Requirement 2: View and Filter Leads

**User Story:** As a Content_Manager, I want to list and filter leads by source, platform, status, and date range with pagination, so that I can find the leads I need to work on.

#### Acceptance Criteria

1. WHEN a Content_Manager requests the list of Leads through `/api/leads`, THE Lead_Service SHALL return the matching Leads with the `page` and `limit` pagination contract and the total record count, as defined in the Foundation & Deployment module.
2. WHEN a list request specifies a Lead_Source filter, THE Lead_Service SHALL return only Leads whose Lead_Source equals the specified value.
3. WHEN a list request specifies a Lead_Platform filter, THE Lead_Service SHALL return only Leads whose Lead_Platform equals the specified value.
4. WHEN a list request specifies a Lead_Status filter, THE Lead_Service SHALL return only Leads whose Lead_Status equals the specified value.
5. WHEN a list request specifies a `from` date, a `to` date, or both, THE Lead_Service SHALL return only Leads whose created_at timestamp falls within the specified date range, inclusive of the boundaries.
6. WHEN a list request specifies more than one filter among Lead_Source, Lead_Platform, Lead_Status, and the date range, THE Lead_Service SHALL return only Leads that satisfy every specified filter.
7. IF a list request specifies a `from` date that is later than the `to` date, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and an error message indicating the date range is invalid.

### Requirement 3: View Lead Detail

**User Story:** As a Content_Manager, I want to open a lead and see its information and interaction history, so that I understand the full context before acting.

#### Acceptance Criteria

1. WHEN a Content_Manager requests a Lead through `/api/leads/{id}`, THE Lead_Service SHALL return the Lead information together with its Interaction_History.
2. WHEN THE Lead_Service returns the Interaction_History for a Lead, THE Lead_Service SHALL order the Lead_History_Entries from most recent to oldest by change timestamp.
3. IF a Lead-detail request targets a Lead_Id that does not exist, THEN THE Lead_Service SHALL respond with HTTP status 404 and SHALL NOT return Lead information.

### Requirement 4: Update Lead

**User Story:** As a Sales_Consultant, I want to update a lead's status, note, and assignment, so that I can record progress through the consultation process.

#### Acceptance Criteria

1. WHEN an update request is submitted to `/api/leads/{id}` with a new Lead_Status that is a permitted transition from the current Lead_Status under Requirement 5, THE Lead_Service SHALL set the Lead_Status to the new value and update the updated_at timestamp.
2. WHEN an update request includes a note, THE Lead_Service SHALL store the note on the Lead.
3. WHEN an update request includes an assigned_to value, THE Lead_Service SHALL set the assigned_to value of the Lead to that value.
4. WHEN THE Lead_Service applies an update to a Lead, THE Lead_Service SHALL append a Lead_History_Entry capturing the previous Lead_Status, the new Lead_Status, the note, the assigned_to value, the acting identity, and the change timestamp.
5. IF an update request targets a Lead_Id that does not exist, THEN THE Lead_Service SHALL respond with HTTP status 404 and SHALL NOT modify any Lead.
6. IF an update request specifies a Lead_Status transition that is not permitted under Requirement 5, THEN THE Lead_Service SHALL reject the request with HTTP status 409 and an error message identifying the invalid transition, and SHALL NOT change the Lead_Status.

### Requirement 5: Lead Status Lifecycle

**User Story:** As a platform architect, I want a well-defined lead state machine, so that leads progress through valid stages and cannot enter invalid states.

#### Acceptance Criteria

1. THE Lead_Service SHALL permit a Lead_Status transition from NEW to CONTACTED, from CONTACTED to QUALIFIED, and from QUALIFIED to CONVERTED.
2. THE Lead_Service SHALL permit a Lead_Status transition to LOST from each Active_Lead_Status of NEW, CONTACTED, and QUALIFIED.
3. WHILE a Lead has a Terminal_Lead_Status of CONVERTED or LOST, THE Lead_Service SHALL treat that Lead_Status as terminal and SHALL NOT permit a transition to any other Lead_Status.
4. IF a Lead_Status transition that is not defined in criteria 1 and 2 is requested, THEN THE Lead_Service SHALL reject the transition with HTTP status 409 and SHALL NOT change the Lead_Status.

### Requirement 6: Delete Lead

**User Story:** As a Content_Manager, I want to delete a lead, so that I can remove invalid or duplicate records.

#### Acceptance Criteria

1. WHEN a Content_Manager submits a delete request to `/api/leads/{id}` for an existing Lead, THE Lead_Service SHALL delete that Lead.
2. IF a delete request targets a Lead_Id that does not exist, THEN THE Lead_Service SHALL respond with HTTP status 404 and SHALL NOT delete any Lead.

### Requirement 7: Lead Statistics

**User Story:** As a Content_Manager, I want lead counts grouped by source, platform, or date over a date range, so that I can measure acquisition performance.

#### Acceptance Criteria

1. WHEN a Content_Manager requests Lead_Stats through `/api/leads/stats` with a Group_Dimension and a date range, THE Lead_Service SHALL return the count of Leads grouped by the specified Group_Dimension over the specified date range.
2. THE Lead_Service SHALL accept a Group_Dimension only when its value is one of `source`, `platform`, or `date`.
3. IF a Lead_Stats request specifies a Group_Dimension that is not one of `source`, `platform`, or `date`, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and an error message identifying the invalid Group_Dimension.
4. IF a Lead_Stats request specifies a `from` date that is later than the `to` date, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and an error message indicating the date range is invalid.

### Requirement 8: Export Leads

**User Story:** As a Content_Manager, I want to export leads to CSV or Excel filtered by date range, so that I can share lead data outside the platform.

#### Acceptance Criteria

1. WHEN an export request is submitted to `/api/leads/export` with a `format` of `csv` or `xlsx`, THE Lead_Service SHALL produce an Export_File in the requested format containing the Leads that match the requested date range.
2. IF an export request specifies a `format` that is not one of `csv` or `xlsx`, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and an error message identifying the invalid format, and SHALL NOT produce an Export_File.
3. WHERE the export request is authenticated with the SALES role, THE Lead_Service SHALL include in the Export_File only the Leads assigned to that Sales_Consultant.
4. IF an export request specifies a `from` date that is later than the `to` date, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and an error message indicating the date range is invalid.

### Requirement 9: Facebook Leadgen Webhook Ingestion

**User Story:** As a Content_Manager, I want leads from Facebook Lead Ads ingested automatically, so that prospects are captured in real time without manual entry.

#### Acceptance Criteria

1. WHEN a request arrives at the Facebook_Leadgen_Webhook and passes the signature verification defined in the Foundation & Deployment module, THE Lead_Service SHALL parse the request body as the Facebook Leadgen format and create a Lead.
2. WHEN THE Lead_Service creates a Lead from the Facebook_Leadgen_Webhook, THE Lead_Service SHALL set the Lead_Source to `facebook_leadgen` and the Lead_Platform to `facebook`.
3. WHEN THE Lead_Service creates a Lead from the Facebook_Leadgen_Webhook, THE Lead_Service SHALL set the Lead_Status to NEW and apply the creation rules defined in Requirement 1.
4. IF a Facebook_Leadgen_Webhook request body cannot be parsed as the Facebook Leadgen format, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and SHALL NOT create a Lead.
5. WHEN a Facebook_Leadgen_Webhook request carries a content or campaign identifier, THE Lead_Service SHALL map that identifier to the Content_Post_Id of the created Lead.

### Requirement 10: Website Form Webhook Ingestion

**User Story:** As a Content_Manager, I want leads from website forms ingested automatically, including TikTok bio-link traffic, so that all owned-channel prospects are captured consistently.

#### Acceptance Criteria

1. WHEN a request arrives at the Website_Form_Webhook and passes the signature verification defined in the Foundation & Deployment module, THE Lead_Service SHALL parse the request body as a Custom CMS form submission and create a Lead.
2. WHEN THE Lead_Service creates a Lead from the Website_Form_Webhook, THE Lead_Service SHALL set the Lead_Platform to `website` and apply the creation rules defined in Requirement 1.
3. WHEN a Website_Form_Webhook submission carries a utm_source of `tiktok_bio`, THE Lead_Service SHALL set the Lead_Source of the created Lead to `tiktok_bio`.
4. WHEN a Website_Form_Webhook submission does not carry a utm_source of `tiktok_bio`, including when the submission carries no utm_source value, THE Lead_Service SHALL set the Lead_Source of the created Lead to `website_form`.
5. WHEN a Website_Form_Webhook submission carries utm_source, utm_medium, or utm_campaign values, THE Lead_Service SHALL store those values on the created Lead.
6. IF a Website_Form_Webhook request body cannot be parsed as a Custom CMS form submission, THEN THE Lead_Service SHALL reject the request with HTTP status 400 and SHALL NOT create a Lead.

### Requirement 11: Webhook Lead Source Attribution

**User Story:** As a Content_Manager, I want each webhook-ingested lead linked to its originating content even when attribution data is incomplete, so that no lead is lost while ROI measurement is preserved where possible.

#### Acceptance Criteria

1. WHEN THE Lead_Service ingests a Lead from a Lead_Webhook that carries a resolvable Content_Post_Id, THE Lead_Service SHALL store that Content_Post_Id on the created Lead.
2. IF a Lead_Webhook request passes signature verification but does not carry a resolvable Content_Post_Id, THEN THE Lead_Service SHALL create the Lead with an `unattributed` Content_Post_Id marker and record that the Lead is unattributed.
3. WHEN THE Lead_Service creates an unattributed Lead, THE Lead_Service SHALL set the Lead_Status to NEW so that the Lead remains workable.

### Requirement 12: Lead-to-Analytics Integration

**User Story:** As a platform architect, I want each lead linked to its originating content so the analytics module can compute conversion, so that content ROI is measurable.

#### Acceptance Criteria

1. THE Lead_Service SHALL associate every Lead that has a resolvable Content_Post_Id with that Content_Post_Id so that the Analytics & Feedback Loop module can attribute the Lead to its originating content.
2. WHEN the Analytics & Feedback Loop module requests the lead count for a Content_Post_Id, THE Lead_Service SHALL return the count of Leads associated with that Content_Post_Id so that the Scoring_Engine can compute the Conversion_Rate.
3. WHEN the Analytics & Feedback Loop module requests lead counts grouped by domain_category and content_topic, THE Lead_Service SHALL return the count of Leads grouped by domain_category and content_topic over the requested date range so that the counts feed the feedback loop.
4. WHEN a Lead is associated with content, THE Lead_Service SHALL store the domain_category and the content_topic on that Lead.

### Requirement 13: Lead Management Access Control

**User Story:** As a security administrator, I want lead operations authorized by role, so that sales consultants act only on their assigned leads and only administrators have full access.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL treat the Lead Management endpoints under `/api/leads/*`, excluding the signature-verified Lead_Webhooks, as protected endpoints requiring a valid Access_Token, as defined in the Foundation & Deployment module.
2. WHERE a request is authenticated with the ADMIN role, THE Lead_Service SHALL grant access to create, list, view, update, delete, aggregate, and export every Lead.
3. WHERE a request is authenticated with the SALES role and targets a Lead assigned to that Sales_Consultant, THE Lead_Service SHALL grant access to view that Lead and to update the Lead_Status and the note of that Lead.
4. IF a request is authenticated with the SALES role and targets a view or update of a Lead that is not assigned to that Sales_Consultant, THEN THE Lead_Service SHALL deny the request with HTTP status 403 and SHALL NOT process the request.
5. IF a request is authenticated with the SALES role and attempts to delete a Lead, THEN THE Lead_Service SHALL deny the request with HTTP status 403 and SHALL NOT delete any Lead.
6. WHERE a request is authenticated with the SALES role and lists, aggregates, or exports Leads, THE Lead_Service SHALL restrict the result to the Leads assigned to that Sales_Consultant.

### Requirement 14: Dashboard Overview Aggregation

**User Story:** As a Content_Manager, I want a single dashboard that aggregates analytics, draft, and lead data, so that I can see the operational state of the platform at a glance.

#### Acceptance Criteria

1. WHEN a Content_Manager requests the Dashboard_Overview through `/api/dashboard/overview`, THE Dashboard_Service SHALL assemble the Dashboard_Overview from Analytics_Records, Content_Draft and Scheduled_Post statuses, and Lead data.
2. WHEN THE Dashboard_Service assembles the Dashboard_Overview, THE Dashboard_Service SHALL include the KPI_Overview, the Approval_Queue, the Upcoming_Posts, the Alert_Section, and the Data_Sync_Status.
3. WHEN THE Dashboard_Service assembles the KPI_Overview, THE Dashboard_Service SHALL include summary charts for View, Lead, and Follow metrics.
4. IF the Dashboard_Service cannot assemble the Dashboard_Overview because one or more source data sets are unavailable, THEN THE Dashboard_Service SHALL respond with HTTP status 500 and an error message indicating the overview could not be assembled.

### Requirement 15: Approval Queue

**User Story:** As a Content_Manager, I want a prioritized queue of items awaiting my review, so that I can approve drafts and insights before they fall behind.

#### Acceptance Criteria

1. WHEN THE Dashboard_Service assembles the Approval_Queue, THE Dashboard_Service SHALL include the Content_Drafts whose Content_Status is DRAFT and the Learning_Insights whose Insight_Status is PENDING_REVIEW.
2. WHEN THE Dashboard_Service orders the Approval_Queue, THE Dashboard_Service SHALL prioritize the items that were created most recently or that are nearest to their deadline.

### Requirement 16: Upcoming Scheduled Posts

**User Story:** As a Content_Manager, I want to see posts scheduled for the next week, so that I can anticipate what is about to publish.

#### Acceptance Criteria

1. WHEN THE Dashboard_Service assembles the Upcoming_Posts, THE Dashboard_Service SHALL include the Scheduled_Posts whose Content_Status is SCHEDULED and whose scheduled publish time is within the next 7 days of the current time.
2. THE Dashboard_Service SHALL exclude from the Upcoming_Posts every Scheduled_Post whose scheduled publish time is more than 7 days after the current time.
3. THE Dashboard_Service SHALL exclude from the Upcoming_Posts every Scheduled_Post whose Content_Status is not SCHEDULED.

### Requirement 17: Failed Post and Token Alerts

**User Story:** As a Content_Manager, I want failed posts and expiring tokens surfaced on the dashboard, so that the publishing flow does not break silently.

#### Acceptance Criteria

1. WHEN THE Dashboard_Service assembles the Alert_Section, THE Dashboard_Service SHALL include each Scheduled_Post whose Content_Status is FAILED together with its failure reason.
2. WHERE a FAILED Scheduled_Post carries the reason TOKEN_EXPIRED, THE Dashboard_Service SHALL display that reason with the affected Scheduled_Post in the Alert_Section.
3. WHEN THE Dashboard_Service assembles the Alert_Section, THE Dashboard_Service SHALL include the platform token-expiry warnings raised by the Token_Manager defined in the Foundation & Deployment module.

### Requirement 18: Data Synchronization Alert

**User Story:** As a Content_Manager, I want to be warned when dashboard data is stale, so that I do not act on out-of-date metrics.

#### Acceptance Criteria

1. WHEN THE Dashboard_Service assembles the Data_Sync_Status, THE Dashboard_Service SHALL report the Last_Sync_Time reflecting the most recent analytics synchronization on the Collection_Cycle defined in the Analytics & Feedback Loop module.
2. IF the age of the Last_Sync_Time exceeds the Sync_Staleness_Threshold, defaulting to 6 hours, THEN THE Dashboard_Service SHALL report a 'data not updated' warning in the Data_Sync_Status and suggest a manual synchronization.
3. WHILE the age of the Last_Sync_Time is at or within the Sync_Staleness_Threshold, THE Dashboard_Service SHALL report the Data_Sync_Status as current.
4. THE Dashboard_Service SHALL read the Sync_Staleness_Threshold from configuration, defaulting to 6 hours.

### Requirement 19: Notifications Channel

**User Story:** As a Content_Manager, I want a notifications feed of administrative alerts, so that I receive token-expiry, publish-failure, and pending-insight notifications in one place.

#### Acceptance Criteria

1. WHEN a Content_Manager requests the Notifications_Channel through `/api/dashboard/notifications`, THE Dashboard_Service SHALL return the ADMIN alerts comprising platform token-expiry warnings, publish-failure alerts, and insights-pending-review notifications.
2. WHEN the Token_Manager raises a token-expiry warning or a refresh-failure alert as defined in the Foundation & Deployment module, THE Dashboard_Service SHALL deliver that alert through the Notifications_Channel for the ADMIN role.
3. WHEN a Scheduled_Post transitions to the Content_Status FAILED, THE Dashboard_Service SHALL deliver a publish-failure notification through the Notifications_Channel for the ADMIN role.
4. WHEN a Learning_Insight enters the Insight_Status PENDING_REVIEW, THE Dashboard_Service SHALL deliver an insights-pending-review notification through the Notifications_Channel for the ADMIN role.

### Requirement 20: Dashboard Access Control

**User Story:** As a security administrator, I want the dashboard authorized by role, so that administrators have full access and sales consultants have read-only access.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL treat the Dashboard endpoints under `/api/dashboard/*` as protected endpoints requiring a valid Access_Token, as defined in the Foundation & Deployment module.
2. WHERE a request to a Dashboard endpoint is authenticated with the ADMIN role, THE Dashboard_Service SHALL grant access to the full Dashboard_Overview and the Notifications_Channel.
3. WHERE a request to a Dashboard endpoint is authenticated with the SALES role, THE Dashboard_Service SHALL grant read-only access.
4. IF a request to a Dashboard endpoint is authenticated with the SALES role and attempts a write operation, THEN THE Dashboard_Service SHALL deny the request with HTTP status 403 and SHALL NOT modify any resource.
