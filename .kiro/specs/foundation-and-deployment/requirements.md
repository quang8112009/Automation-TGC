# Requirements Document

## Introduction

This document specifies the requirements for the **Foundation & Deployment** module of the AutoTGC AI content-marketing automation platform. This is the first of four planned specs and defines the cross-cutting foundation that every other module (Content Strategy, Content Generation, Publishing, Analytics, Feedback Loop, Lead Management, Dashboard) depends upon, plus the deployment of the platform to the production server.

The module covers three concern areas:

1. **Authentication & Authorization** — user registration, login, logout, JWT session management, account lockout, role-based access control (RBAC), and internal service accounts.
2. **External Platform Integration Foundation** — an extensible platform adapter pattern, platform token storage and lifecycle management with proactive refresh, and secure secrets handling.
3. **Core Infrastructure & Deployment** — the backend runtime stack, datastore, reverse proxy with SSL, process management, scheduled job execution, the deployment pipeline, REST API conventions, and least-privilege operation.

This module addresses **Phase 1** only. Phase 1 integrates Facebook (Graph API), TikTok (Content Posting API), a Custom CMS, and Google Analytics 4 (GA4). The platform adapter architecture is designed to allow Phase 2+ platforms (Zalo OA, Instagram, YouTube) to be added without redesign.

Source of truth: `API_Catalog.md` (sections 3.1 Core APIs, 6.1 Token Management, 6.3 Webhooks, 8 Server & Infrastructure) and `Authentication/LoginRegister.md`.

## Glossary

- **AutoTGC_Backend**: The backend application that hosts the internal AutoTGC Core APIs, the Custom CMS API, and the Lead Management APIs, deployed on the production server.
- **Auth_Service**: The component of AutoTGC_Backend responsible for user registration, login, logout, and JWT session lifecycle.
- **Authorization_Service**: The component of AutoTGC_Backend responsible for evaluating role-based permissions on each authenticated request.
- **User_Account**: A persisted record representing a human user, containing username, email, password hash, role, and lockout state.
- **Role**: A named set of permissions assigned to a User_Account. In Phase 1 the defined roles are ADMIN and SALES.
- **ADMIN**: The Content Manager role, granted full access to all modules (Strategy, Generation, Publishing, Analytics, Feedback Review, Lead Management, Settings, Dashboard).
- **SALES**: The Sales/Consultant role, granted access to Lead Management for assigned leads and read-only access to the Dashboard.
- **Service_Account**: A non-interactive internal identity used by the AI System or the Background Worker. A Service_Account cannot perform interactive login.
- **Access_Token**: A short-lived JWT issued on successful authentication, valid for 24 hours, used to authorize API requests.
- **Refresh_Token**: A long-lived JWT issued on successful authentication, valid for 30 days, used to obtain a new Access_Token.
- **JWT_Session**: The pairing of an Access_Token and a Refresh_Token associated with one authenticated User_Account.
- **Platform_Adapter**: A component that implements a common interface to integrate one external platform (Facebook, TikTok, Custom CMS, GA4, and future platforms).
- **Platform_Token**: A stored credential (access token, refresh token, API key, or service-account credential) used by a Platform_Adapter to call an external platform, with associated expiry metadata.
- **Token_Manager**: The component of AutoTGC_Backend that stores, retrieves, and manages the lifecycle of Platform_Tokens.
- **Token_Refresh_Job**: The scheduled background job that proactively checks and refreshes Platform_Tokens before expiry.
- **Secret**: Any credential, server host value, IP address, password, API key, or token that must not appear in source code or version control.
- **Secret_Store**: An environment-variable mechanism or secret manager (for example a `.env` file outside version control, Google Secret Manager, or HashiCorp Vault) where Secrets are kept.
- **Deployment_Pipeline**: The automated process that builds, packages, and deploys AutoTGC_Backend to the production server.
- **Application_User**: The least-privilege operating-system user (for example `autotgc`) under which AutoTGC_Backend runs on the server.
- **Reverse_Proxy**: The Nginx instance that terminates TLS and forwards requests to AutoTGC_Backend.
- **Process_Manager**: The supervisor process (PM2 for Node.js, or Gunicorn with Supervisor for Python) that keeps AutoTGC_Backend running.
- **Scheduler**: The mechanism (systemd timer or node-cron) that triggers scheduled jobs such as the Token_Refresh_Job.
- **Webhook_Endpoint**: A network-exposed endpoint that receives unauthenticated inbound requests from an external platform (for example Facebook Leadgen, Custom CMS form submission).
- **Public_Endpoint**: An API endpoint that does not require a JWT, limited to login, registration, token refresh, health check, and signature-verified Webhook_Endpoints.

## Requirements

### Requirement 1: User Registration

**User Story:** As a prospective user, I want to register a new account, so that I can access the AutoTGC platform.

#### Acceptance Criteria

1. WHEN a registration request is submitted with a username, an email, a password, and a password confirmation, THE Auth_Service SHALL validate the request against the rules defined in criteria 2 through 6.
2. IF the submitted email is empty, exceeds 254 characters, or does not match the format `local@domain.tld`, THEN THE Auth_Service SHALL reject the registration request with HTTP status 400, an error message indicating an invalid email, and SHALL NOT create a User_Account.
3. IF the submitted password contains fewer than 8 characters or more than 128 characters, THEN THE Auth_Service SHALL reject the registration request with HTTP status 400, an error message indicating an invalid password length, and SHALL NOT create a User_Account.
4. IF the submitted password and the password confirmation are not identical, THEN THE Auth_Service SHALL reject the registration request with HTTP status 400, an error message indicating the passwords do not match, and SHALL NOT create a User_Account.
5. IF the submitted username is empty, consists only of whitespace, or exceeds 50 characters, THEN THE Auth_Service SHALL reject the registration request with HTTP status 400, an error message indicating an invalid username, and SHALL NOT create a User_Account.
6. IF the submitted username matches an existing User_Account username, THEN THE Auth_Service SHALL reject the registration request with HTTP status 409, an error message indicating the username is taken, and SHALL NOT create a User_Account.
7. WHEN a registration request passes all rules defined in criteria 2 through 6, THE Auth_Service SHALL create a User_Account with the password stored as a salted hash and SHALL NOT store the plaintext password.
8. WHEN a User_Account is created through registration, THE Auth_Service SHALL assign the ADMIN role to that User_Account by default.
9. WHEN a User_Account is successfully created, THE Auth_Service SHALL issue an Access_Token with an expiry of 24 hours and a Refresh_Token with an expiry of 30 days for that User_Account.

### Requirement 2: User Login

**User Story:** As a registered user, I want to log in with my credentials, so that I receive a session token to use the platform.

#### Acceptance Criteria

1. WHEN a login request is submitted with a non-empty username and a non-empty password that match an unlocked User_Account, THE Auth_Service SHALL issue an Access_Token and a Refresh_Token paired as one JWT_Session for that User_Account.
2. WHEN THE Auth_Service issues an Access_Token, THE Auth_Service SHALL set the Access_Token expiry to 24 hours after issuance.
3. WHEN THE Auth_Service issues a Refresh_Token, THE Auth_Service SHALL set the Refresh_Token expiry to 30 days after issuance.
4. IF a login request is submitted with a username that matches an existing User_Account but a password that does not match that User_Account, THEN THE Auth_Service SHALL reject the request with HTTP status 401 and increment the consecutive failed-login count for that User_Account by one.
5. IF a login request is submitted with a username that does not match any User_Account, THEN THE Auth_Service SHALL reject the request with HTTP status 401 without modifying any consecutive failed-login count.
6. IF a login request is submitted with an empty username or an empty password, THEN THE Auth_Service SHALL reject the request with HTTP status 400 and an error message indicating the missing field.
7. WHEN a login request succeeds for a User_Account, THE Auth_Service SHALL reset the consecutive failed-login count for that User_Account to zero.
8. WHEN THE Auth_Service issues an Access_Token, THE Auth_Service SHALL embed the User_Account identifier and the assigned Role in the Access_Token claims.

### Requirement 3: Account Lockout

**User Story:** As a security administrator, I want accounts locked after repeated failed logins, so that brute-force attacks are mitigated.

#### Acceptance Criteria

1. WHEN incrementing the consecutive failed-login count for a User_Account causes that count to reach 5, THE Auth_Service SHALL set that User_Account to a locked state.
2. WHILE a User_Account is in a locked state when a login request for that User_Account begins processing, THE Auth_Service SHALL reject that login request with HTTP status 423 and an error message indicating the account is locked, even if the submitted password matches that User_Account.
3. WHEN a User_Account transitions to a locked state, THE Auth_Service SHALL record the lockout timestamp on that User_Account.

### Requirement 4: Token Refresh

**User Story:** As an authenticated user, I want to renew my access token using my refresh token, so that I can stay signed in without re-entering credentials.

#### Acceptance Criteria

1. WHEN a token-refresh request is submitted with a Refresh_Token that is well-formed, unexpired, and has not been invalidated, THE Auth_Service SHALL issue a new Access_Token with an expiry of 24 hours after issuance.
2. WHEN THE Auth_Service issues a new Access_Token in response to a token-refresh request, THE Auth_Service SHALL embed in the new Access_Token claims the same User_Account identifier and Role carried by the JWT_Session of the submitted Refresh_Token.
3. IF a token-refresh request is submitted with an expired Refresh_Token, THEN THE Auth_Service SHALL reject the request with HTTP status 401 and a message indicating re-authentication is required.
4. IF a token-refresh request is submitted with a Refresh_Token that has been invalidated, THEN THE Auth_Service SHALL reject the request with HTTP status 401.
5. IF a token-refresh request is submitted without a Refresh_Token or with a malformed Refresh_Token, THEN THE Auth_Service SHALL reject the request with HTTP status 401.

### Requirement 5: Logout

**User Story:** As an authenticated user, I want to log out, so that my session can no longer be used.

#### Acceptance Criteria

1. WHEN a logout request is submitted with an Access_Token that is well-formed, unexpired, and not already invalidated, THE Auth_Service SHALL invalidate the JWT_Session associated with that Access_Token.
2. WHEN a JWT_Session is invalidated, THE Auth_Service SHALL reject subsequent requests that present the Access_Token from that JWT_Session with HTTP status 401.
3. WHEN a JWT_Session is invalidated, THE Auth_Service SHALL reject subsequent token-refresh requests that use the Refresh_Token from that JWT_Session with HTTP status 401.

### Requirement 6: Role-Based Access Control

**User Story:** As a security administrator, I want each request authorized by role, so that users only access the modules their role permits.

#### Acceptance Criteria

1. THE Authorization_Service SHALL define exactly two interactive roles in Phase 1: ADMIN and SALES.
2. WHERE a request is authenticated with a valid Access_Token carrying the ADMIN role, THE Authorization_Service SHALL grant read access and write access to the Strategy, Generation, Publishing, Analytics, Feedback Review, Lead Management, Settings, and Dashboard modules.
3. WHERE a request is authenticated with a valid Access_Token carrying the SALES role and targets a Lead Management resource assigned to that User_Account, THE Authorization_Service SHALL grant read access and status-update access to that resource.
4. WHERE a request is authenticated with a valid Access_Token carrying the SALES role and targets a Dashboard resource, THE Authorization_Service SHALL grant read-only access.
5. IF a request is authenticated with the SALES role and targets a Strategy, Generation, Publishing, Analytics, Feedback Review, or Settings resource, THEN THE Authorization_Service SHALL deny the request with HTTP status 403 and SHALL NOT process the request.
6. WHEN a request carries a valid Access_Token, THE Authorization_Service SHALL evaluate the Role claim against the targeted resource before the request is processed, independently of whether the request is ultimately processed.
7. IF a request is authenticated with the SALES role and targets a Lead Management resource that is not assigned to that User_Account, THEN THE Authorization_Service SHALL deny the request with HTTP status 403 and SHALL NOT process the request.
8. IF a request is authenticated with the SALES role and attempts a write operation (create, update, or delete) on a Dashboard resource, THEN THE Authorization_Service SHALL deny the request with HTTP status 403 and SHALL NOT modify the targeted resource.

### Requirement 7: Authentication Enforcement on Endpoints

**User Story:** As a security administrator, I want every protected endpoint to require authentication, so that no internal resource is exposed without a valid session.

#### Acceptance Criteria

1. IF a request to a protected endpoint is submitted without an Access_Token, THEN THE AutoTGC_Backend SHALL reject the request with HTTP status 401 and SHALL NOT process the request.
2. IF a request to a protected endpoint is submitted with an expired or malformed Access_Token, THEN THE AutoTGC_Backend SHALL reject the request with HTTP status 401 and SHALL NOT process the request.
3. THE AutoTGC_Backend SHALL treat every endpoint as protected except the designated Public_Endpoints.
4. THE AutoTGC_Backend SHALL limit Public_Endpoints to login, registration, token refresh, health check, and signature-verified Webhook_Endpoints.
5. IF a request to a protected endpoint is submitted with an Access_Token whose JWT_Session has been invalidated, THEN THE AutoTGC_Backend SHALL reject the request with HTTP status 401 and SHALL NOT process the request.

### Requirement 8: Internal Service Accounts

**User Story:** As a platform architect, I want the AI System and Background Worker to authenticate as internal service accounts, so that automated processes operate without human login credentials.

#### Acceptance Criteria

1. THE Auth_Service SHALL provide a Service_Account identity for the AI System and a Service_Account identity for the Background Worker.
2. IF an interactive login request targets a Service_Account, THEN THE Auth_Service SHALL reject the request with HTTP status 403.
3. WHEN a Service_Account authenticates using its valid issued credential, THE Auth_Service SHALL grant that Service_Account only the operations defined in its assigned permission set.
4. IF an authenticated Service_Account requests an operation outside its assigned permission set, THEN THE Auth_Service SHALL deny the request with HTTP status 403 and SHALL NOT process the request.
5. IF a Service_Account authentication request presents an invalid or expired credential, THEN THE Auth_Service SHALL reject the request with HTTP status 401 and SHALL NOT issue any token.
6. THE Auth_Service SHALL store Service_Account credentials in the Secret_Store rather than in source code or version control.

### Requirement 9: Extensible Platform Adapter Pattern

**User Story:** As a platform architect, I want a common adapter interface for external platforms, so that new platforms can be added in later phases without redesigning the integration layer.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL define a common Platform_Adapter interface that exposes publishing and analytics-collection operations.
2. THE AutoTGC_Backend SHALL provide a Platform_Adapter implementation for Facebook Graph API (publishing and analytics), TikTok Content Posting API (publishing and analytics), Custom CMS (publishing and analytics), and Google Analytics 4 (analytics only) in Phase 1.
3. WHERE a new Platform_Adapter implementation is registered, THE AutoTGC_Backend SHALL route platform operations to that adapter without modification to existing adapter implementations.
4. WHEN a caller requests a platform operation for an unsupported platform, THE AutoTGC_Backend SHALL reject the request with HTTP status 400 and SHALL NOT perform any platform operation, and SHALL include a message identifying the unsupported platform when such a message can be generated.
5. IF a caller requests an operation that the targeted Platform_Adapter does not implement, THEN THE AutoTGC_Backend SHALL reject the request with HTTP status 400 and a message identifying the unsupported operation, and SHALL NOT perform the operation.

### Requirement 10: Platform Token Storage

**User Story:** As a platform operator, I want platform tokens stored with their expiry metadata, so that the system can track and manage each credential's lifecycle.

#### Acceptance Criteria

1. WHEN a Platform_Token is registered, THE Token_Manager SHALL store the token value, the platform identifier, the token type (access token, refresh token, API key, or service-account credential), and the expiry timestamp or a non-expiring marker.
2. THE Token_Manager SHALL store Platform_Token values in the Secret_Store rather than in source code or version control.
3. WHEN the `/api/platform-tokens` endpoint receives an authenticated GET request, THE Token_Manager SHALL return, for each platform, the platform identifier, the token type, the expiry timestamp, and the validity status, without returning the secret token value.
4. WHERE a platform uses a service-account credential or API key without expiry, THE Token_Manager SHALL record that Platform_Token as non-expiring.
5. THE Token_Manager SHALL treat a Platform_Token as valid WHILE the token value is present and either marked non-expiring or its expiry timestamp is in the future.

### Requirement 11: Proactive Token Refresh

**User Story:** As a platform operator, I want platform tokens refreshed before they expire, so that integrations keep working without manual intervention.

#### Acceptance Criteria

1. THE Scheduler SHALL trigger the Token_Refresh_Job at its configured interval, defaulting to 12 hours.
2. WHEN the Token_Refresh_Job runs, THE Token_Manager SHALL identify each expiring Platform_Token whose expiry timestamp is within its configured refresh window, where the refresh window is greater than the Token_Refresh_Job interval.
3. WHEN a Facebook Page Access Token is within its refresh window, THE Token_Manager SHALL exchange it for a renewed long-lived token and update the stored expiry to 60 days after renewal.
4. WHEN a TikTok Access Token is within its refresh window, THE Token_Manager SHALL obtain a new Access_Token using the TikTok Refresh_Token and update the stored expiry to 24 hours after renewal.
5. WHEN the `/api/platform-tokens/{platform}/refresh` endpoint receives an authenticated request, THE Token_Manager SHALL refresh the specified platform's Platform_Token and return the resulting validity status in the response.
6. IF a Platform_Token refresh attempt fails, THEN THE Token_Manager SHALL retain the existing Platform_Token and record the failure reason.
7. THE Token_Refresh_Job SHALL skip any Platform_Token marked as non-expiring.

### Requirement 12: Token Expiry Alerting

**User Story:** As a Content Manager, I want to be alerted when a platform token is about to expire or has failed to refresh, so that I can act before integrations break.

#### Acceptance Criteria

1. IF a Platform_Token expires, THEN THE Token_Manager SHALL raise an expiry alert that identifies the affected platform immediately upon expiry, even if a refresh succeeds shortly afterward.
2. IF a Platform_Token refresh attempt fails, THEN THE Token_Manager SHALL raise an alert that identifies the affected platform and the failure reason.
3. WHEN THE Token_Manager raises an alert, THE Token_Manager SHALL deliver the alert to the Dashboard notifications channel for the ADMIN role.
4. IF an expiring Platform_Token enters its refresh window and a subsequent refresh attempt has not yet succeeded, THEN THE Token_Manager SHALL raise a pre-expiry warning that identifies the affected platform.

### Requirement 13: Secrets Handling

**User Story:** As a security administrator, I want no secrets stored in code or the repository, so that credentials cannot leak through version control.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL read all Secrets from the Secret_Store at runtime.
2. THE Deployment_Pipeline SHALL exclude all Secrets, including the server host value and the root account, from source code and version control.
3. IF a required Secret is absent from the Secret_Store at startup, THEN THE AutoTGC_Backend SHALL stop startup and log the name of the missing Secret without logging any Secret value.
4. WHEN THE AutoTGC_Backend logs a request or an error, THE AutoTGC_Backend SHALL exclude Secret values from the log output.

### Requirement 14: Least-Privilege Operation

**User Story:** As a security administrator, I want the application to run as a least-privilege user, so that a compromise cannot escalate to full server control.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL run under the Application_User on the production server.
2. THE Deployment_Pipeline SHALL configure AutoTGC_Backend to run as a non-root user.
3. IF AutoTGC_Backend is started as the root user, THEN THE AutoTGC_Backend SHALL stop startup and log an error indicating root operation is not permitted, and SHALL NOT begin serving requests.

### Requirement 15: Backend Runtime Stack

**User Story:** As a platform operator, I want the defined runtime stack provisioned, so that the application runs on supported, consistent infrastructure.

#### Acceptance Criteria

1. THE AutoTGC_Backend SHALL run on Node.js 20 LTS or Python 3.11 or later.
2. THE AutoTGC_Backend SHALL use PostgreSQL 16 as the relational datastore.
3. THE AutoTGC_Backend SHALL use Redis for caching and job queueing.
4. WHEN AutoTGC_Backend exits unexpectedly, THE Process_Manager SHALL restart AutoTGC_Backend.
5. WHILE AutoTGC_Backend is running, THE Process_Manager SHALL NOT terminate the running AutoTGC_Backend solely because a restart mechanism reported a failure.

### Requirement 16: Reverse Proxy and SSL Termination

**User Story:** As a platform operator, I want HTTPS-terminated traffic routed through a reverse proxy, so that all external traffic is encrypted.

#### Acceptance Criteria

1. THE Reverse_Proxy SHALL terminate TLS for inbound requests using a Let's Encrypt certificate.
2. WHEN an inbound request arrives over plain HTTP, THE Reverse_Proxy SHALL redirect the request to HTTPS, and IF the request is not successfully redirected to HTTPS, THEN THE Reverse_Proxy SHALL drop the request rather than serve it over HTTP.
3. WHEN THE Reverse_Proxy receives an HTTPS request, THE Reverse_Proxy SHALL forward the request to AutoTGC_Backend.
4. IF the Reverse_Proxy cannot reach AutoTGC_Backend or forwarding fails, THEN THE Reverse_Proxy SHALL respond to the client with HTTP status 502.
5. THE Deployment_Pipeline SHALL configure renewal of the Let's Encrypt certificate before its expiry.

### Requirement 17: Scheduled Job Execution

**User Story:** As a platform operator, I want scheduled jobs to run reliably on the server, so that background processes like token refresh and analytics collection execute on schedule.

#### Acceptance Criteria

1. THE Scheduler SHALL run as a systemd timer or as node-cron on the production server.
2. THE Scheduler SHALL trigger the Token_Refresh_Job at its configured interval, defaulting to 12 hours, and SHALL run with the configured interval even when the configured interval is not exactly 12 hours.
3. IF a scheduled job execution fails, THEN THE Scheduler SHALL log the failure with the job name and the failure timestamp.

### Requirement 18: Deployment Pipeline

**User Story:** As a platform operator, I want an automated build-and-deploy pipeline, so that releases reach the production server consistently and without manual secret handling.

#### Acceptance Criteria

1. WHEN a release is initiated, THE Deployment_Pipeline SHALL build and package AutoTGC_Backend.
2. WHEN THE Deployment_Pipeline deploys AutoTGC_Backend, THE Deployment_Pipeline SHALL resolve the server host value from the Secret_Store.
3. WHEN THE Deployment_Pipeline deploys AutoTGC_Backend, THE Deployment_Pipeline SHALL deploy the application to run under the Application_User.
4. THE Deployment_Pipeline SHALL require a DNS A record that maps the configured domain to the production server.
5. IF a build step or a deployment step fails, THEN THE Deployment_Pipeline SHALL stop the release and report the failed step.

### Requirement 19: REST API Conventions

**User Story:** As an API consumer, I want consistent REST conventions across endpoints, so that integrations behave predictably.

#### Acceptance Criteria

1. WHEN THE AutoTGC_Backend responds to a request, THE AutoTGC_Backend SHALL return a JSON body and an HTTP status code drawn from the set {200, 201, 202, 400, 401, 403, 404, 409, 423, 500, 502}.
2. WHEN THE AutoTGC_Backend responds to a collection request that supports pagination, THE AutoTGC_Backend SHALL accept `page` and `limit` query parameters and return the total record count in the response.
3. WHEN THE AutoTGC_Backend receives a cross-origin request from the configured AutoTGC frontend origin, THE AutoTGC_Backend SHALL return the CORS headers that permit that origin.
4. IF a request targets a resource that does not exist, THEN THE AutoTGC_Backend SHALL respond with HTTP status 404.

### Requirement 20: Webhook Signature Verification

**User Story:** As a security administrator, I want inbound webhook requests verified by signature, so that unauthenticated endpoints cannot be abused to inject false data.

#### Acceptance Criteria

1. WHEN a request arrives at a Webhook_Endpoint, THE AutoTGC_Backend SHALL verify the request signature against the shared secret for that webhook source before processing the request body.
2. IF a Webhook_Endpoint request fails signature verification, THEN THE AutoTGC_Backend SHALL reject the request with HTTP status 401 and SHALL NOT process the request body.
3. WHEN a Webhook_Endpoint request passes signature verification, THE AutoTGC_Backend SHALL process the request body and respond with an HTTP status in the 2xx range.
4. THE AutoTGC_Backend SHALL read each webhook shared secret from the Secret_Store.
