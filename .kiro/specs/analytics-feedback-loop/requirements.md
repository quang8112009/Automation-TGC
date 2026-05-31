# Requirements Document

## Introduction

This document specifies the requirements for the **Analytics & Feedback Loop** module of the AutoTGC AI content-marketing automation platform. This is the third of four planned specs. It covers the closed-loop analytics and self-learning feedback system: collecting raw performance metrics from publishing platforms, scoring content performance, running a weekly AI-driven feedback analysis with Google Gemini, presenting learning insights for human review, and producing the enriched generation context that closes the loop back into content generation.

This module depends on two earlier modules and does **not** re-specify their capabilities. The following are assumed to exist and are referenced rather than redefined:

**From the Foundation & Deployment module (spec 1):**
- **Authentication & RBAC** — JWT sessions, the ADMIN (Content Manager) and SALES roles, authentication enforcement on protected endpoints, and the role-based access policy.
- **Platform_Adapter interface and registry** — the uniform analytics-collection operations for Facebook (Graph API), TikTok (Content Posting/Research API), the Custom CMS, and Google Analytics 4, plus routing of unsupported platforms/operations to HTTP 400.
- **Token_Manager and Platform_Token lifecycle** — validity checks and refresh of platform credentials used during analytics collection.
- **Service_Account identities** — the Background Worker and AI System non-interactive identities used by scheduled analytics and feedback jobs.
- **Scheduler** — the systemd-timer/node-cron mechanism that triggers scheduled jobs.
- **Alert/notification delivery** — the Dashboard notifications channel and email delivery used to notify the Content Manager.
- **Gemini integration foundation** — configured Google Gemini access (model `gemini-2.5-pro` for analysis).

**From the Content Pipeline module (spec 2):**
- **Content_Draft / Scheduled_Post** — published posts carry an external Post identifier and a post URL stored at publish time.
- **Content_Persona** — the persona record, including its Tone_Of_Voice and a `recommended_tone` field updated by this module's Strategy Update Processor.
- **Content_Calendar** — the scheduling view whose per-topic frequency this module's Strategy Update Processor adjusts.
- **AI_Prompt_Context** — the enriched generation context this module **produces** and the Content Generation service **consumes** at `/api/strategy/ai-context`.
- **Objective, Tone_Of_Voice, Platform, Domain** — terms defined in the Content Pipeline module.

The module addresses Phase 1 platforms only: Facebook, TikTok, and the Custom CMS Website (with GA4 for website analytics).

Source of truth: `Analytics_&_Optimization/Monitor_Content_Performance.md`, `Analytics_&_Optimization/Review_AI_Insights.md`, `Data_Flow_Analytics_to_Strategy.md` (data structures and business rules R1–R14), and `API_Catalog.md` (internal APIs `/api/analytics/collect`, `/api/analytics/score`, `/api/feedback/analyze`, `/api/feedback/insights`, `/api/feedback/insights/{id}/apply`, `/api/feedback/insights/{id}/reject`, `/api/strategy/ai-context`).

## Glossary

- **AutoTGC_Backend**: The backend application (defined in the Foundation & Deployment module) that hosts the internal AutoTGC APIs, including the Analytics & Feedback Loop endpoints.
- **Content_Manager**: The human operator holding the ADMIN role (defined in Foundation) who reviews and approves or rejects learning insights.
- **Background_Worker**: The Background Worker Service_Account (defined in Foundation) that runs the scheduled analytics-collection and feedback-analysis jobs.
- **Scheduler**: The Foundation mechanism that triggers scheduled jobs (systemd timer or node-cron).
- **Platform_Adapter**: The Foundation component that performs analytics collection against one Platform.
- **Token_Manager**: The Foundation component that manages Platform_Token validity and refresh.
- **Platform**: An external analytics source; in Phase 1 one of Facebook, TikTok, or Website.
- **Published_Post**: A Scheduled_Post (defined in Content Pipeline) with the status PUBLISHED that carries an external Post identifier and a post URL.
- **External_Post_Id**: The platform-assigned identifier stored on a Published_Post, used to match collected metrics to the internal post.
- **Collection_Service**: The component of AutoTGC_Backend that collects raw metrics from platforms (`/api/analytics/collect`).
- **Analytics_Record**: A persisted record of raw metrics collected for one Published_Post on one Platform at one collection time, comprising the available subset of views, likes, shares, comments, follows, leads, click_through, reach, and a `collected_at` timestamp.
- **Raw_Metric**: A single named measurement within an Analytics_Record (for example views, reach, leads).
- **Unavailable_Metric**: A Raw_Metric that the source Platform's API does not provide for a Published_Post, recorded as null and excluded from aggregation rather than treated as zero.
- **Scoring_Engine**: The component of AutoTGC_Backend that computes derived rates and a Performance_Label and extracts Content_Features (`/api/analytics/score`).
- **Conversion_Rate**: `(leads / views) * 100`.
- **Engagement_Rate**: For Facebook and Website, `(likes + comments + shares) / reach * 100`; for TikTok, `(likes + comments + shares) / views * 100`.
- **CTA_Click_Rate**: `(click_through / views) * 100`.
- **Follow_Rate**: `(follows / reach) * 100`; not applicable to TikTok.
- **Derived_Rate**: Any of Conversion_Rate, Engagement_Rate, CTA_Click_Rate, or Follow_Rate.
- **INSUFFICIENT_DATA**: The label applied to a Derived_Rate, and to a Performance_Record, when the rate's denominator is zero, marking the post as excluded from scoring and feedback until the denominator becomes greater than zero.
- **Performance_Label**: One of HIGH_PERFORMER, AVERAGE_PERFORMER, LOW_PERFORMER, or INSUFFICIENT_DATA, assigned from Conversion_Rate against configurable thresholds.
- **HIGH_THRESHOLD**: The configurable Conversion_Rate threshold for HIGH_PERFORMER, defaulting to 5%.
- **MID_THRESHOLD**: The configurable Conversion_Rate threshold for AVERAGE_PERFORMER, defaulting to 2%.
- **Content_Features**: The metadata extracted for a Published_Post: domain_category, content_topic, persona_id, tone_of_voice, objective, platform, post_time_slot, content_length, has_cta, cta_type, and media_type.
- **Performance_Record**: The output of the Scoring_Engine for one Published_Post, combining its Content_Features, its Derived_Rates, its Performance_Label, and a `scored_at` timestamp.
- **Feedback_Engine**: The component of AutoTGC_Backend that runs Pattern_Recognition and Insight generation using Google Gemini (`/api/feedback/analyze`).
- **Pattern_Recognition**: The aggregation of Performance_Records across five analysis dimensions performed by the Feedback_Engine.
- **Analysis_Dimension**: One of the five grouping dimensions: domain_category; content_topic; persona_id with tone_of_voice; platform with post_time_slot; and cta_type with objective.
- **MIN_SAMPLE**: The minimum number of Performance_Records sharing a content_topic required to generate a Learning_Insight, defaulting to 5.
- **Learning_Insight**: A structured recommendation produced by the Feedback_Engine, of one Insight_Type, carrying supporting metrics, a confidence_score, a sample_size, and an Insight_Status.
- **Insight_Type**: One of TOPIC_FREQUENCY_ADJUSTMENT, PERSONA_TONE_OPTIMIZATION, OPTIMAL_POSTING_SCHEDULE, LOW_PERFORMER_ALERT, or PLATFORM_CONTENT_FIT.
- **Insight_Status**: The lifecycle state of a Learning_Insight, one of NEW, PENDING_REVIEW, APPROVED, or REJECTED.
- **Confidence_Score**: A value between 0 and 1 attached to a Learning_Insight indicating the strength of the supporting evidence.
- **Insight_Service**: The component of AutoTGC_Backend that lists insights and records approve/reject decisions (`/api/feedback/insights`, `/api/feedback/insights/{id}/apply`, `/api/feedback/insights/{id}/reject`).
- **Strategy_Update_Processor**: The single component authorized to apply strategy changes (to the Content_Calendar, Content_Persona recommended_tone, and AI_Prompt_Context) after a Learning_Insight is APPROVED, recording each change in the Audit_Log.
- **AI_Prompt_Context**: The enriched read model produced by the Strategy_Update_Processor and consumed by the Content Generation service (`/api/strategy/ai-context`), comprising top_performing_topics, best_cta_patterns, avoid_topics, optimal_content_length per Platform, tone_recommendations, and optimal_schedules.
- **Review_Mode**: The default operating mode in which every Learning_Insight requires Content_Manager approval before the Strategy_Update_Processor applies it.
- **Auto_Mode**: The optional operating mode, disabled by default and enabled only in Settings, in which small changes (frequency adjustments of 30% or less, and posting time-slot changes) are applied without Content_Manager approval.
- **Audit_Log**: The persisted, append-only record of every Learning_Insight generated and every approve or reject decision and every strategy change applied.
- **Retention_Period**: The minimum duration for which Performance_Records and Analytics_Records are retained, defaulting to 12 months.
- **Collection_Cycle**: The standardized 6-hour interval at which the Collection_Service collects metrics.

## Requirements

### Requirement 1: Scheduled Analytics Collection

**User Story:** As a Content_Manager, I want the system to automatically collect performance metrics from every platform on a regular cycle, so that content performance data stays current without manual effort.

#### Acceptance Criteria

1. THE Scheduler SHALL trigger the Collection_Service at the Collection_Cycle interval, defaulting to 6 hours.
2. WHEN the Collection_Service runs, THE Collection_Service SHALL authenticate as the Background_Worker Service_Account defined in the Foundation & Deployment module.
3. WHEN the Collection_Service runs, THE Collection_Service SHALL request analytics for each Published_Post through the Platform_Adapter for that post's Platform, and SHALL request website analytics through the Google Analytics 4 Platform_Adapter.
4. WHEN the Collection_Service collects metrics for a Published_Post, THE Collection_Service SHALL retrieve the available subset of views, likes, shares, comments, follows, leads, click_through, and reach, together with a `collected_at` timestamp.
5. WHEN the Collection_Service prepares to collect from a Platform, THE Collection_Service SHALL check the validity of that Platform's Platform_Token through the Token_Manager and SHALL request a refresh through the Token_Manager when the Platform_Token is expired or invalid.

### Requirement 2: Match Metrics to Internal Post

**User Story:** As a Content_Manager, I want collected metrics linked to the originating internal post, so that performance can be attributed to the content that produced it.

#### Acceptance Criteria

1. WHEN the Collection_Service receives metrics for a Published_Post, THE Collection_Service SHALL match the metrics to the internal Published_Post by the External_Post_Id stored on that Published_Post.
2. WHEN matched metrics are available for a Published_Post, THE Collection_Service SHALL persist an Analytics_Record associating the metrics with that Published_Post and its Platform.
3. IF collected metrics carry an External_Post_Id that matches no Published_Post, or the matching process fails for those metrics, THEN THE Collection_Service SHALL skip those metrics and SHALL NOT create an Analytics_Record.

### Requirement 3: Platform Metric Availability

**User Story:** As a platform architect, I want each platform's missing metrics recorded as unavailable rather than zero, so that aggregate performance figures are not skewed by metrics a platform never reports.

#### Acceptance Criteria

1. WHERE the Platform is Facebook, THE Collection_Service SHALL record views, reach, click_through, and follows for a Published_Post.
2. WHERE the Platform is Website, THE Collection_Service SHALL record pageviews as views, sessions, and conversions from Google Analytics 4 for a Published_Post.
3. WHERE the Platform is TikTok, THE Collection_Service SHALL record only views, likes, comments, and shares for a Published_Post, and SHALL record reach and follows as Unavailable_Metrics.
4. WHEN a Raw_Metric is not provided by a Platform's API for a Published_Post, THE Collection_Service SHALL store that Raw_Metric as null and mark it as an Unavailable_Metric.
5. WHEN the Scoring_Engine and the Feedback_Engine aggregate Raw_Metrics, THE AutoTGC_Backend SHALL exclude Unavailable_Metrics from the aggregation and SHALL NOT treat an Unavailable_Metric as zero.

### Requirement 4: Collection Error Handling

**User Story:** As a Content_Manager, I want to be told when a platform's data could not be refreshed, so that I know the displayed metrics are not the latest.

#### Acceptance Criteria

1. IF a platform analytics request fails during collection, THEN THE Collection_Service SHALL log the error with the affected Platform identifier and the failure timestamp.
2. IF a platform analytics request fails during collection, THEN THE Collection_Service SHALL notify the Content_Manager that the data for the affected Platform is not current, and SHALL retain the most recent Analytics_Records for that Platform.
3. WHEN a platform analytics request fails for one Platform, THE Collection_Service SHALL continue collecting metrics for the remaining Platforms.

### Requirement 5: Analytics Data Retention

**User Story:** As a platform architect, I want performance data retained for at least a year, so that the feedback loop can analyze long-term trends.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL retain each Analytics_Record and each Performance_Record for at least the Retention_Period, defaulting to 12 months.
2. WHILE an Analytics_Record or a Performance_Record has an age that is at or within the Retention_Period, including a record at exactly the Retention_Period boundary, THE AutoTGC_Backend SHALL keep that record available for Pattern_Recognition.

### Requirement 6: Compute Derived Rates

**User Story:** As a Content_Manager, I want conversion and engagement rates computed from raw metrics, so that posts can be compared on consistent performance measures.

#### Acceptance Criteria

1. WHEN the Scoring_Engine scores a Published_Post whose views are greater than zero, THE Scoring_Engine SHALL compute the Conversion_Rate as `(leads / views) * 100` and the CTA_Click_Rate as `(click_through / views) * 100`.
2. WHERE the Platform is Facebook or Website, WHEN the Scoring_Engine scores a Published_Post whose reach is greater than zero, THE Scoring_Engine SHALL compute the Engagement_Rate as `(likes + comments + shares) / reach * 100` and the Follow_Rate as `(follows / reach) * 100`.
3. WHERE the Platform is TikTok, WHEN the Scoring_Engine scores a Published_Post whose views are greater than zero, THE Scoring_Engine SHALL compute the Engagement_Rate as `(likes + comments + shares) / views * 100`, and SHALL record the Follow_Rate as not applicable.
4. WHEN the Scoring_Engine runs, THE Scoring_Engine SHALL run event-driven immediately after the Collection_Service completes a collection for a Published_Post.

### Requirement 7: Divide-by-Zero Safety

**User Story:** As a platform architect, I want rates with a zero denominator handled safely, so that new or low-traffic posts do not corrupt the analysis.

#### Acceptance Criteria

1. IF the denominator of a Derived_Rate is zero, THEN THE Scoring_Engine SHALL set that Derived_Rate to zero and SHALL NOT perform the division.
2. IF the views of a Published_Post are zero or the reach required for a Derived_Rate is zero, THEN THE Scoring_Engine SHALL set the Performance_Label of that Published_Post to INSUFFICIENT_DATA.
3. WHILE a Published_Post has the Performance_Label INSUFFICIENT_DATA, THE Feedback_Engine SHALL exclude that Published_Post from Pattern_Recognition.
4. WHEN the views or the required reach of a Published_Post labeled INSUFFICIENT_DATA become greater than zero at a later collection, THE Scoring_Engine SHALL recompute the Derived_Rates and assign a Performance_Label from the Conversion_Rate.

### Requirement 8: Performance Labeling

**User Story:** As a Content_Manager, I want each post classified by performance tier, so that high and low performers are easy to identify.

#### Acceptance Criteria

1. WHEN the Scoring_Engine assigns a Performance_Label and the Conversion_Rate is greater than or equal to the HIGH_THRESHOLD, THE Scoring_Engine SHALL set the Performance_Label to HIGH_PERFORMER.
2. WHEN the Scoring_Engine assigns a Performance_Label and the Conversion_Rate is greater than or equal to the MID_THRESHOLD and less than the HIGH_THRESHOLD, THE Scoring_Engine SHALL set the Performance_Label to AVERAGE_PERFORMER.
3. WHEN the Scoring_Engine assigns a Performance_Label and the Conversion_Rate is less than the MID_THRESHOLD, THE Scoring_Engine SHALL set the Performance_Label to LOW_PERFORMER.
4. THE Scoring_Engine SHALL read the HIGH_THRESHOLD and the MID_THRESHOLD from configuration, defaulting to 5% and 2% respectively.
5. WHEN a Published_Post is labeled INSUFFICIENT_DATA under Requirement 7, THE Scoring_Engine SHALL NOT assign HIGH_PERFORMER, AVERAGE_PERFORMER, or LOW_PERFORMER to that Published_Post.

### Requirement 9: Content Feature Extraction

**User Story:** As a platform architect, I want each scored post tagged with its content attributes, so that the feedback engine can find patterns across those attributes.

#### Acceptance Criteria

1. WHEN the Scoring_Engine scores a Published_Post, THE Scoring_Engine SHALL extract the Content_Features domain_category, content_topic, persona_id, tone_of_voice, objective, platform, post_time_slot, content_length, has_cta, cta_type, and media_type for that Published_Post.
2. WHEN the Scoring_Engine completes scoring for a Published_Post, THE Scoring_Engine SHALL produce a Performance_Record combining the Content_Features, the Derived_Rates, the Performance_Label, and a `scored_at` timestamp.
3. WHEN the Scoring_Engine produces a Performance_Record, THE Scoring_Engine SHALL persist that Performance_Record.

### Requirement 10: Weekly Feedback Analysis Trigger

**User Story:** As a Content_Manager, I want the AI feedback analysis to run automatically each week, so that the strategy is reviewed against fresh performance data on a predictable cadence.

#### Acceptance Criteria

1. THE Scheduler SHALL trigger the Feedback_Engine once per week, defaulting to Sunday at 00:00.
2. WHEN the Feedback_Engine runs, THE Feedback_Engine SHALL authenticate as the Background_Worker Service_Account defined in the Foundation & Deployment module, and IF that authentication fails, THEN THE Feedback_Engine SHALL halt immediately without performing Pattern_Recognition.
3. WHEN the Feedback_Engine runs, THE Feedback_Engine SHALL analyze the Performance_Records within the configured analysis period and SHALL exclude Performance_Records labeled INSUFFICIENT_DATA.
4. IF every Performance_Record within the analysis period is labeled INSUFFICIENT_DATA, THEN THE Feedback_Engine SHALL skip analysis entirely and SHALL leave the current strategy unchanged.

### Requirement 11: Minimum Sample Size and Fallback

**User Story:** As a Content_Manager, I want insights generated only when there is enough evidence, so that the strategy is not changed on the basis of a few posts.

#### Acceptance Criteria

1. WHEN the Feedback_Engine evaluates a content_topic, THE Feedback_Engine SHALL generate a Learning_Insight for that content_topic only when the count of Performance_Records sharing that content_topic is greater than or equal to MIN_SAMPLE, defaulting to 5.
2. IF every content_topic in the analysis period has fewer than MIN_SAMPLE Performance_Records, THEN THE Feedback_Engine SHALL generate no Learning_Insights and SHALL leave the current strategy unchanged.
3. WHEN the Feedback_Engine generates a Learning_Insight, THE Feedback_Engine SHALL attach the sample_size used to produce that Learning_Insight.
4. THE Feedback_Engine SHALL read MIN_SAMPLE from configuration, defaulting to 5.

### Requirement 12: Pattern Recognition Across Dimensions

**User Story:** As a Content_Manager, I want the AI to analyze performance across multiple content dimensions, so that recommendations reflect what actually drives results.

#### Acceptance Criteria

1. WHEN the Feedback_Engine runs Pattern_Recognition, THE Feedback_Engine SHALL aggregate Performance_Records across each Analysis_Dimension: domain_category; content_topic; persona_id with tone_of_voice; platform with post_time_slot; and cta_type with objective.
2. WHEN the Feedback_Engine performs Pattern_Recognition, THE Feedback_Engine SHALL call Google Gemini using the model `gemini-2.5-pro`.
3. WHEN the Feedback_Engine aggregates a Derived_Rate across a group of Performance_Records, THE Feedback_Engine SHALL exclude Unavailable_Metrics and Derived_Rates labeled INSUFFICIENT_DATA from that aggregation.
4. IF the Pattern_Recognition request to Google Gemini fails, THEN THE Feedback_Engine SHALL log the failure, leave the current strategy unchanged, and notify the Content_Manager that the weekly analysis did not complete, as a single combined operation, and IF any one of those actions does not succeed, THEN THE Feedback_Engine SHALL treat the analysis run as failed and leave the current strategy unchanged.

### Requirement 13: Insight Generation

**User Story:** As a Content_Manager, I want actionable insights of well-defined types backed by data, so that I can decide whether to adjust the strategy.

#### Acceptance Criteria

1. WHEN the Feedback_Engine generates a Learning_Insight, THE Feedback_Engine SHALL assign it exactly one Insight_Type from TOPIC_FREQUENCY_ADJUSTMENT, PERSONA_TONE_OPTIMIZATION, OPTIMAL_POSTING_SCHEDULE, LOW_PERFORMER_ALERT, and PLATFORM_CONTENT_FIT.
2. WHEN the Feedback_Engine generates a Learning_Insight, THE Feedback_Engine SHALL attach the supporting metrics, a Confidence_Score between 0 and 1, and the sample_size for that Learning_Insight.
3. WHEN the average Conversion_Rate for a content_topic is greater than or equal to the HIGH_THRESHOLD and the sample_size is greater than or equal to MIN_SAMPLE, THE Feedback_Engine SHALL generate a TOPIC_FREQUENCY_ADJUSTMENT Learning_Insight recommending an increase in posting frequency for that content_topic.
4. WHEN the average Conversion_Rate for a content_topic is less than the MID_THRESHOLD and the sample_size is greater than or equal to MIN_SAMPLE, THE Feedback_Engine SHALL generate a LOW_PERFORMER_ALERT Learning_Insight recommending a reduction or revision for that content_topic.
5. WHEN the Feedback_Engine creates a Learning_Insight, THE Feedback_Engine SHALL set its Insight_Status to NEW and then to PENDING_REVIEW when the Learning_Insight is queued for review.

### Requirement 14: Insight Conflict Resolution

**User Story:** As a Content_Manager, I want conflicting recommendations resolved by a consistent rule, so that the strategy does not receive contradictory changes.

#### Acceptance Criteria

1. IF two Learning_Insights recommend conflicting changes to the same content_topic, persona_id, or Platform-and-time-slot, THEN THE Feedback_Engine SHALL retain the Learning_Insight supported by the Conversion_Rate and SHALL discard or supersede the Learning_Insight supported only by the Engagement_Rate.
2. WHEN the Feedback_Engine resolves a conflict between two Learning_Insights, THE Feedback_Engine SHALL record the resolution in the Audit_Log.

### Requirement 15: Insight Lifecycle

**User Story:** As a platform architect, I want a defined insight state machine, so that insights move through review in a controlled, auditable way.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL permit an Insight_Status transition from NEW to PENDING_REVIEW, from PENDING_REVIEW to APPROVED, and from PENDING_REVIEW to REJECTED.
2. IF an Insight_Status transition that is not defined in criterion 1 is requested, THEN THE AutoTGC_Backend SHALL reject the transition with HTTP status 409 and SHALL NOT change the Insight_Status.
3. WHILE a Learning_Insight has the Insight_Status APPROVED or REJECTED, THE AutoTGC_Backend SHALL treat that Learning_Insight as terminal and SHALL NOT return it to PENDING_REVIEW.

### Requirement 16: Review Pending Insights

**User Story:** As a Content_Manager, I want to view pending insights with their supporting data, so that I can evaluate each recommendation before deciding.

#### Acceptance Criteria

1. WHEN a Content_Manager requests the list of Learning_Insights through `/api/feedback/insights`, THE Insight_Service SHALL return the Learning_Insights whose Insight_Status is PENDING_REVIEW with their Insight_Type, supporting metrics, Confidence_Score, and sample_size.
2. WHEN a Content_Manager opens a Learning_Insight, THE Insight_Service SHALL present the recommended change together with the supporting Performance_Records that justify the Learning_Insight.
3. THE Insight_Service SHALL operate in Review_Mode by default, requiring Content_Manager approval before the Strategy_Update_Processor applies any Learning_Insight.

### Requirement 17: Approve Insight

**User Story:** As a Content_Manager, I want to approve an insight, so that its recommended change is applied to the content strategy.

#### Acceptance Criteria

1. IF an approve request targets a Learning_Insight whose Insight_Status is not PENDING_REVIEW, THEN THE Insight_Service SHALL reject the request with HTTP status 409 and SHALL NOT change the Insight_Status.
2. WHEN a Content_Manager approves a Learning_Insight through `/api/feedback/insights/{id}/apply`, THE Insight_Service SHALL set the Insight_Status of that Learning_Insight to APPROVED.
3. WHEN a Learning_Insight transitions to APPROVED, THE Strategy_Update_Processor SHALL apply the recommended change of that Learning_Insight.
4. WHEN a Learning_Insight is APPROVED, THE Insight_Service SHALL record the approval, the approving Content_Manager, and the timestamp in the Audit_Log.
5. WHEN a Learning_Insight is APPROVED, THE AutoTGC_Backend SHALL make that Learning_Insight available as input context for the next run of the Feedback_Engine.

### Requirement 18: Reject or Modify Insight

**User Story:** As a Content_Manager, I want to reject an insight with a reason or modify it before applying, so that the system records my judgment and learns from it.

#### Acceptance Criteria

1. IF a Content_Manager rejects a Learning_Insight without providing a reason, THEN THE Insight_Service SHALL reject the request with HTTP status 400 and an error message indicating a reason is required, and SHALL NOT change the Insight_Status.
2. WHEN a Content_Manager rejects a Learning_Insight through `/api/feedback/insights/{id}/reject` and provides a reason, THE Insight_Service SHALL set the Insight_Status to REJECTED and store the rejection reason.
3. WHEN a Learning_Insight is REJECTED, THE Insight_Service SHALL record the rejection reason in the Audit_Log and make the rejection reason available as input context for the next run of the Feedback_Engine.
4. WHEN a Content_Manager modifies the recommended change of a PENDING_REVIEW Learning_Insight before approving, THE Insight_Service SHALL persist the modified recommended change and apply the modified change through the Strategy_Update_Processor upon approval.
5. WHEN a Learning_Insight is REJECTED, THE Strategy_Update_Processor SHALL NOT apply that Learning_Insight's recommended change.

### Requirement 19: Auto Mode

**User Story:** As a Content_Manager, I want the option to auto-apply only small changes, so that minor optimizations proceed without my review when I have explicitly enabled it.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL disable Auto_Mode by default and SHALL enable Auto_Mode only when a Content_Manager enables it in Settings.
2. WHILE Auto_Mode is enabled, WHEN the Feedback_Engine generates a Learning_Insight that recommends a posting-frequency adjustment of 30% or less or a posting time-slot change, THE Strategy_Update_Processor SHALL apply that Learning_Insight without Content_Manager approval and record the automatic application in the Audit_Log.
3. WHILE Auto_Mode is enabled, IF a Learning_Insight recommends a change other than a posting-frequency adjustment of 30% or less or a posting time-slot change, THEN THE Insight_Service SHALL route that Learning_Insight to Review_Mode and SHALL require Content_Manager approval.
4. WHILE Auto_Mode is disabled, THE Insight_Service SHALL route every Learning_Insight through Review_Mode.

### Requirement 20: Audit Logging

**User Story:** As a security administrator, I want every insight and decision logged, so that strategy changes are fully traceable.

#### Acceptance Criteria

1. WHEN the Feedback_Engine generates a Learning_Insight, THE AutoTGC_Backend SHALL record the Learning_Insight in the Audit_Log.
2. WHEN a Learning_Insight is APPROVED or REJECTED, THE AutoTGC_Backend SHALL record the decision, the deciding identity, and the timestamp in the Audit_Log.
3. WHEN the Strategy_Update_Processor applies a strategy change, THE AutoTGC_Backend SHALL record the applied change, the source Learning_Insight, and the timestamp in the Audit_Log.
4. THE Audit_Log SHALL be append-only.

### Requirement 21: Strategy Update Processor as Single Source of Truth

**User Story:** As a platform architect, I want all strategy mutations to flow through one processor, so that changes stay consistent and auditable.

#### Acceptance Criteria

1. THE Strategy_Update_Processor SHALL be the only component that mutates the Content_Calendar topic frequency, the Content_Persona recommended_tone, and the AI_Prompt_Context as a result of a Learning_Insight.
2. WHEN the Strategy_Update_Processor applies a Learning_Insight, THE Strategy_Update_Processor SHALL update only the components relevant to that Learning_Insight's Insight_Type and SHALL NOT modify components unaffected by that Learning_Insight.
3. WHEN the Strategy_Update_Processor applies a TOPIC_FREQUENCY_ADJUSTMENT Learning_Insight, THE Strategy_Update_Processor SHALL update the Content_Calendar posting frequency for the affected content_topic.
4. WHEN the Strategy_Update_Processor applies a PERSONA_TONE_OPTIMIZATION Learning_Insight, THE Strategy_Update_Processor SHALL update the recommended_tone of the affected Content_Persona.
5. WHEN the Strategy_Update_Processor applies any Learning_Insight, THE Strategy_Update_Processor SHALL update the AI_Prompt_Context fields affected by that Learning_Insight.
6. THE AutoTGC_Backend SHALL NOT allow a Learning_Insight to mutate the Content_Calendar, a Content_Persona, or the AI_Prompt_Context except through the Strategy_Update_Processor.

### Requirement 22: AI Prompt Context Production

**User Story:** As the Content Generation service, I want an enriched, current generation context, so that new content reflects what performs best.

#### Acceptance Criteria

1. WHEN the Strategy_Update_Processor produces or updates the AI_Prompt_Context, THE Strategy_Update_Processor SHALL populate top_performing_topics, best_cta_patterns, avoid_topics, optimal_content_length per Platform, tone_recommendations, and optimal_schedules.
2. WHEN a Content Generation request reads the AI_Prompt_Context through `/api/strategy/ai-context`, THE AutoTGC_Backend SHALL return the most recently produced AI_Prompt_Context with its `last_updated_from_analytics` timestamp.
3. WHEN the Strategy_Update_Processor derives avoid_topics, THE Strategy_Update_Processor SHALL include every content_topic for which an applied LOW_PERFORMER_ALERT Learning_Insight recommended reduction or revision.
4. WHEN the Strategy_Update_Processor derives top_performing_topics, THE Strategy_Update_Processor SHALL include each content_topic for which an applied Learning_Insight identified a HIGH_PERFORMER pattern, with its average Conversion_Rate.
5. WHEN no Learning_Insight has yet been applied, THE AutoTGC_Backend SHALL return an empty AI_Prompt_Context at `/api/strategy/ai-context` rather than an error, so that cold-start generation in the Content Pipeline module can proceed.

### Requirement 23: Access Control for Analytics and Feedback Endpoints

**User Story:** As a security administrator, I want the analytics and feedback endpoints protected by the platform's existing authentication and authorization, so that only permitted identities operate on performance data and insights.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL treat the endpoints `/api/analytics/collect`, `/api/analytics/score`, `/api/feedback/analyze`, `/api/feedback/insights`, `/api/feedback/insights/{id}/apply`, `/api/feedback/insights/{id}/reject`, and `/api/strategy/ai-context` as protected endpoints requiring a valid Access_Token, as defined in the Foundation & Deployment module.
2. IF a request to a feedback-review endpoint (`/api/feedback/insights`, `/api/feedback/insights/{id}/apply`, `/api/feedback/insights/{id}/reject`) is authenticated with the SALES role, THEN THE AutoTGC_Backend SHALL deny the request with HTTP status 403 and SHALL NOT process the request.
3. WHEN the Background_Worker invokes `/api/analytics/collect`, `/api/analytics/score`, or `/api/feedback/analyze`, THE Background_Worker SHALL authenticate as the Background Worker Service_Account defined in the Foundation & Deployment module.
4. IF a Service_Account requests an operation outside its assigned permission set, THEN THE AutoTGC_Backend SHALL deny the request with HTTP status 403 and SHALL NOT process the request.
