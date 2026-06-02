# Implementation Plan: admin-oversight-rbac-notifications

## Overview

Kế hoạch triển khai gói **admin-oversight-rbac-notifications** theo kiến trúc **additive** trên AutoTGC (Fastify 4 + Prisma 5/PostgreSQL 16, Redis event bus, JWT + RBAC thuần, Vitest + fast-check, PM2 + Nginx). Các bước được sắp xếp tăng dần: bắt đầu từ schema/migration Prisma, kế đến nhất quán hóa RBAC (thuần) kèm property test, rồi tới domain giám sát (`src/oversight/`), gắn hook tập trung vào các service nghiệp vụ, quản lý tài khoản, Admin Dashboard, route thông báo/hoạt động, wiring `app.ts`, frontend, và cuối cùng là kiểm chứng xuyên suốt + triển khai.

Ngôn ngữ triển khai: **TypeScript (strict)** — theo đúng thiết kế và steering (không dùng pseudocode). Mỗi correctness property trong design được hiện thực bằng **đúng một** property test trong `autotgc-backend/test/admin-oversight.properties.test.ts`, gắn comment `// Feature: admin-oversight-rbac-notifications, Property {n}: ...` và chạy `fc.assert(..., { numRuns: 100 })` trở lên.

> Lưu ý va chạm ghi file: cả 8 property test cùng nằm trong **một** file `test/admin-oversight.properties.test.ts`. Vì các tác vụ ghi cùng một file không được chạy song song, mỗi tác vụ property test được xếp vào một wave riêng trong Task Dependency Graph (serial hóa theo file). Nếu muốn song song hóa, có thể tách thành nhiều file `test/admin-oversight.<area>.properties.test.ts` — khi đó cập nhật lại wave tương ứng.

## Tasks

- [ ] 1. Nền tảng dữ liệu — Prisma schema & migration `0003`
  - [ ] 1.1 Bổ sung model `Notification` + `ActivityLog` và quan hệ ngược (additive) vào `autotgc-backend/prisma/schema.prisma`
    - Thêm model `Notification` (id, `recipientUserId`, relation `recipient` tới `UserAccount` với `onDelete: Cascade`, `kind`, `message`, `refType String?`, `refId String?`, `read Boolean @default(false)`, `createdAt DateTime @default(now())`; `@@index([recipientUserId, createdAt])`, `@@index([read])`)
    - Thêm model `ActivityLog` (id, `actorUserId`, `action`, `targetType`, `targetId`, `detail Json @default("{}")`, `createdAt DateTime @default(now())`; `@@index([actorUserId])`, `@@index([targetType, targetId])`, `@@index([createdAt])`)
    - Thêm quan hệ ngược `notifications Notification[] @relation("UserNotifications")` vào model `UserAccount` (chỉ field tầng client, không thêm cột bảng `UserAccount`); KHÔNG sửa `AuditEntry`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.3, 2.4, 2.5, 2.6, 12.1_

  - [ ] 1.2 Sinh client và tạo migration `0003_admin_oversight`
    - Chạy `npm run prisma:generate` trong `autotgc-backend/`
    - Tạo `autotgc-backend/prisma/migrations/0003_admin_oversight/migration.sql` theo phong cách `0002` (CreateTable + CreateIndex + AddForeignKey, **không** ALTER phá vỡ bảng hiện có): tạo `Notification`, `ActivityLog`, các index, và FK `Notification_recipientUserId_fkey` tới `UserAccount(id)`
    - Xác minh migration thuần additive, không khóa/đổi bảng hiện có và không đụng `AuditEntry`
    - _Requirements: 1.4, 1.5, 2.3, 2.5, 12.1_

- [ ] 2. Nhất quán hóa RBAC (thuần, SSOT) — `src/auth/rbac.ts`
  - [ ] 2.1 Mở rộng `autotgc-backend/src/auth/rbac.ts` (additive, giữ nguyên hành vi hiện có)
    - Thêm `Module 'user_management'` (ADMIN-only) và `Action 'company_stats'` (đọc thống kê toàn công ty, ADMIN-only)
    - Thêm helper thuần `isAssignedOwner(callerUserId, ownerUserId?)`: true chỉ khi owner khớp caller; `ownerUserId === undefined` coi là không khớp cho SALES
    - Cập nhật `authorize`: ADMIN → allowed mọi module/action; SALES → `lead_management` (delete→403; owner khác→403; read|update|status_update khớp owner/owner-undefined→allowed), `dashboard` (đọc→allowed; `company_stats` và mọi WRITE→403), `user_management`→403, module khác→403
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.7, 3.8, 3.9, 4.1, 5.9, 10.1, 10.3, 10.7_

  - [ ]* 2.2 Viết property test cho RBAC theo vai trò và phạm vi
    - **Property 1: RBAC quyết định đúng theo vai trò và phạm vi**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.6, 3.7, 3.8, 3.9, 4.1, 5.9, 10.3, 11.1**
    - File `autotgc-backend/test/admin-oversight.properties.test.ts`; tag `// Feature: admin-oversight-rbac-notifications, Property 1: ...`; generator role/module/action/ownerUserId/callerId; `fc.assert` ≥100 runs

  - [ ]* 2.3 Viết property test cho tính xác định của RBAC
    - **Property 2: Quyết định RBAC là xác định (deterministic, thuần)**
    - **Validates: Requirements 10.2**
    - Cùng file; tag `// Feature: admin-oversight-rbac-notifications, Property 2: ...`; gọi `authorize` lặp nhiều lần với cùng đầu vào → cùng kết quả; ≥100 runs

- [ ] 3. Domain giám sát — `src/oversight/`
  - [ ] 3.1 Tạo `autotgc-backend/src/oversight/types.ts`
    - Export `ActivityAction = 'DOCUMENT_VERIFIED' | 'CANDIDATE_STAGE_CHANGED' | 'LEAD_STATUS_CHANGED'` và `NotificationKind = 'ACTIVITY'`
    - _Requirements: 2.1, 8.3_

  - [ ] 3.2 Hiện thực `autotgc-backend/src/oversight/fanout.ts` (THUẦN)
    - Export `fanOutNotifications(users, action)` trả đúng một `NotificationDraft` cho mỗi ADMIN phân biệt (de-dup theo id, bỏ qua SALES), mỗi draft mang `refType = action.targetType`, `refId = action.targetId`
    - Export `describeActivity(action)` soạn `message` người-đọc-được chứa `actorUserId` và `action`; không truy cập DB, không phát event
    - _Requirements: 1.6, 8.1, 8.3, 8.4_

  - [ ]* 3.3 Viết property test cho fan-out
    - **Property 3: Fan-out tạo đúng một thông báo cho mỗi ADMIN với đủ ngữ cảnh**
    - **Validates: Requirements 1.6, 8.1, 8.3, 8.4, 11.2**
    - Cùng file `test/admin-oversight.properties.test.ts`; tag `// Feature: admin-oversight-rbac-notifications, Property 3: ...`; generator mảng `UserLike` (ADMIN/SALES, id trùng) + `ActionDescriptor`; kiểm độ dài == số ADMIN distinct, không draft cho SALES; ≥100 runs

  - [ ] 3.4 Hiện thực `autotgc-backend/src/oversight/activityLogger.ts` (append-only)
    - Class `ActivityLogger(prisma)` chỉ phơi bày `append(input)` (server đóng dấu `createdAt`, lưu `detail` verbatim) và `listRecent(page?, limit?)` trả mục theo `createdAt` giảm dần; KHÔNG có update/delete
    - _Requirements: 2.1, 2.2, 2.4, 2.6, 6.2, 6.5, 10.6_

  - [ ]* 3.5 Viết unit test cho `ActivityLogger`
    - File `autotgc-backend/test/activityLogger.test.ts`: `append` đóng dấu `createdAt` từ server (2.4); `detail` lưu nguyên trạng (2.6); không phơi bày `update`/`delete` (2.2, 10.6)
    - _Requirements: 2.2, 2.4, 2.6, 10.6_

  - [ ] 3.6 Hiện thực `autotgc-backend/src/oversight/notificationService.ts`
    - Class `NotificationService(prisma, eventBus?)`: `createForAdmins(drafts, eventPayload)` (createMany N bản + publish 1 event topic `notification`); `list(self, page?, limit?)` (recipient = self, `createdAt` desc); `unreadCount(self)`; `markRead(id, caller)` (404 nếu không tồn tại, 403 nếu recipient ≠ caller, lũy đẳng khi đã đọc)
    - _Requirements: 8.1, 8.2, 8.6, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 3.7 Viết property test cho truy vấn & đánh dấu đã đọc thông báo
    - **Property 8: Đánh dấu đã đọc lũy đẳng, đúng người, đếm chưa-đọc chính xác**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 11.5**
    - Cùng file `test/admin-oversight.properties.test.ts`; tag `// Feature: admin-oversight-rbac-notifications, Property 8: ...`; dùng fake prisma in-memory; ≥100 runs

  - [ ] 3.8 Hiện thực `autotgc-backend/src/oversight/oversightService.ts` (điểm phát tập trung)
    - Class `OversightService(prisma, activityLogger, notifications)` với `record(action)`: (1) append đúng 1 `ActivityLog`; (2) đọc mọi `UserAccount` role=ADMIN; (3) `fanOutNotifications` → tạo đúng 1 `Notification`/ADMIN; (4) publish 1 `DomainEvent` topic `notification`. Toàn bộ bọc try/catch — nuốt mọi lỗi phụ trợ, KHÔNG ném/không rollback; gọi SAU khi nghiệp vụ commit
    - _Requirements: 7.4, 7.5, 7.6, 8.1, 8.2, 8.5, 10.4, 10.5_

  - [ ]* 3.9 Viết property test cho tính nhất quán log/notification
    - **Property 4: Một Important_Action sinh đúng một ActivityLog và đúng một Notification cho mỗi ADMIN, nhất quán với hành động**
    - **Validates: Requirements 2.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 10.4, 10.5, 11.3**
    - Cùng file; tag `// Feature: admin-oversight-rbac-notifications, Property 4: ...`; fake prisma/bus; kiểm 1 log + N notif, `detail` verbatim; ≥100 runs

  - [ ]* 3.10 Viết property test cho cô lập lỗi của điểm phát tập trung
    - **Property 5: Cô lập lỗi của điểm phát tập trung**
    - **Validates: Requirements 8.5**
    - Cùng file; tag `// Feature: admin-oversight-rbac-notifications, Property 5: ...`; ép `append`/`createForAdmins`/`publish` ném lỗi (cờ lỗi từng collaborator) → `record` vẫn resolve không ném; ≥100 runs

- [ ] 4. Gắn hook tập trung vào service nghiệp vụ (tiêm `OversightService` tùy chọn)
  - [ ] 4.1 Gắn hook vào `autotgc-backend/src/recruitment/documents/documentChecklistService.ts`
    - Tiêm `oversight?` qua constructor; sau khi commit `updateStatus` và `nextStatus === 'VERIFIED'` → một dòng `oversight?.record({ action:'DOCUMENT_VERIFIED', targetType:'document', targetId:itemId, detail:{ candidateId, type } })`
    - _Requirements: 7.1, 7.4, 7.6_

  - [ ] 4.2 Gắn hook vào `autotgc-backend/src/recruitment/candidateService.ts`
    - Tiêm `oversight?`; trong nhánh `stageChanged` của `update`/`matchToJobOrder` (sau commit) → `oversight?.record({ action:'CANDIDATE_STAGE_CHANGED', targetType:'candidate', targetId:id, detail:{ previousStage, newStage } })`
    - _Requirements: 7.2, 7.4, 7.6_

  - [ ] 4.3 Gắn hook vào `autotgc-backend/src/leads/leadService.ts`
    - Tiêm `oversight?`; khi `update` đổi status thực sự và `newStatus ∈ {QUALIFIED, CONVERTED}` (sau commit) → `oversight?.record({ action:'LEAD_STATUS_CHANGED', targetType:'lead', targetId:id, detail:{ previousStatus, newStatus } })`
    - _Requirements: 7.3, 7.4, 7.6_

  - [ ]* 4.4 Viết integration test cho tính nhất quán của hook
    - File `autotgc-backend/test/oversight-hooks.test.ts`: với fake `OversightService`, mỗi `Important_Action` thành công gọi `record` đúng một lần với `actorUserId`/`targetType`/`targetId` khớp (7.1, 7.2, 7.3); hành động bị từ chối/ném lỗi → KHÔNG gọi `record` (7.5); `eventBus.publish` gọi đúng một lần với `topic==='notification'` (8.2)
    - _Requirements: 7.1, 7.2, 7.3, 7.5, 8.2_

- [ ] 5. Quản lý tài khoản nhân viên (ADMIN-only)
  - [ ] 5.1 Hiện thực `autotgc-backend/src/auth/userManagementService.ts`
    - Class `UserManagementService(prisma)`: `list()` (trả `username/email/role/locked`); `createSalesUser(input)` (400 nếu thiếu field hợp lệ, 409 nếu trùng `username`, tạo role SALES); `lock(userId)`; `unlock(userId)` (đặt `locked=false` và `failedLoginCount=0`); `changeRole(userId, role)` (chỉ {ADMIN, SALES}, ngoài tập → 400); `resetPassword(userId, newPassword)` (hash bằng `argon2` qua `password.ts`, không lưu plaintext)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [ ] 5.2 Hiện thực `autotgc-backend/src/auth/userRoutes.ts` (`registerUserManagementRoutes`)
    - Mount `GET/POST /api/v1/users`, `POST /api/v1/users/:id/lock|unlock|role|reset-password` sau `requireAuth` + `rbacGuard({ module:'user_management', ... })`; SALES → 403; chỉ trả mã trạng thái thuộc tập cho phép
    - _Requirements: 4.2, 4.3, 5.1, 5.9, 12.5_

  - [ ]* 5.3 Viết unit test cho `UserManagementService`
    - File `autotgc-backend/test/userManagement.test.ts`: `list` đủ trường (5.1); `createSalesUser` → role SALES (5.2); trùng username → 409 (5.3); input thiếu → 400 (5.4); `lock` → locked (5.5); `unlock` → locked=false & failedLoginCount=0 (5.6); `changeRole` (5.7); `resetPassword` → stored ≠ plaintext và `verifyPassword` đúng (5.8, vài mẫu — tránh PBT vì argon2 chậm); login khi locked → 423 (5.10)
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.10_

- [ ] 6. Admin Dashboard — tổng quan toàn công ty + dòng hoạt động
  - [ ] 6.1 Hiện thực `autotgc-backend/src/dashboard/adminOverview.ts` (THUẦN)
    - Export `safeRate(num, den)` (den=0 → `'INSUFFICIENT_DATA'`, ngược lại số hữu hạn) và `composeOverview(role, company, personal)` (ADMIN → `{ scope:'company', kpis, recentActivity }`; SALES → `{ scope:'personal', kpis }`, KHÔNG feed, KHÔNG company stats)
    - _Requirements: 3.4, 3.5, 6.1, 6.3, 6.4, 6.7_

  - [ ]* 6.2 Viết property test cho phân tách phạm vi thống kê + an toàn chia 0
    - **Property 6: Phân tách phạm vi thống kê và an toàn chia-cho-không**
    - **Validates: Requirements 3.4, 3.5, 6.1, 6.3, 6.4, 6.7, 11.4**
    - Cùng file `test/admin-oversight.properties.test.ts`; tag `// Feature: admin-oversight-rbac-notifications, Property 6: ...`; generator tập record `{assignedTo}`, role, num/den (gồm den=0, số âm); ≥100 runs

  - [ ]* 6.3 Viết property test cho thứ tự & đầy đủ trường của dòng hoạt động
    - **Property 7: Recent_Activity_Feed sắp xếp giảm dần và đủ trường**
    - **Validates: Requirements 6.2, 6.5, 6.6**
    - Cùng file; tag `// Feature: admin-oversight-rbac-notifications, Property 7: ...`; generator tập `ActivityLog` với `createdAt` ngẫu nhiên (gồm trùng nhau); kiểm desc theo `createdAt` và đủ `actorUserId/action/targetType/targetId/createdAt`; ≥100 runs

  - [ ] 6.4 Mở rộng `buildDashboardOverview` trong `autotgc-backend/src/routes/index.ts`
    - Đọc dữ liệu rồi gọi `composeOverview` phân nhánh ADMIN/SALES; chỉ ADMIN nạp `Recent_Activity_Feed` từ `ActivityLogger.listRecent`; SALES giữ phạm vi cá nhân; route sau `requireAuth` + `rbacGuard` (dashboard/read)
    - _Requirements: 3.6, 6.1, 6.2, 6.3, 6.4, 6.5, 12.5_

- [ ] 7. Route thông báo + hoạt động — `src/oversight/routes.ts`
  - [ ] 7.1 Hiện thực `autotgc-backend/src/oversight/routes.ts` (`registerOversightRoutes`)
    - Mount `GET /api/v1/notifications`, `GET /api/v1/notifications/unread-count`, `POST /api/v1/notifications/:id/read` (dashboard/read, owner-check trong service → 403/404) và `GET /api/v1/activity` (dashboard/`company_stats`, ADMIN-only); tất cả sau `requireAuth` + `rbacGuard`; chỉ trả mã trạng thái thuộc tập cho phép
    - _Requirements: 6.5, 8.7, 9.1, 9.2, 9.3, 9.4, 9.6, 12.5_

- [ ] 8. Wiring ứng dụng — `src/app.ts`
  - [ ] 8.1 Đăng ký route mới và khởi tạo + tiêm `OversightService`
    - Trong `autotgc-backend/src/app.ts`: gọi `registerOversightRoutes`, `registerUserManagementRoutes` (sau auth + RBAC); khởi tạo `ActivityLogger`, `NotificationService(prisma, eventBus)`, `OversightService` rồi tiêm vào registrar của `LeadService`/`CandidateService`/`DocumentChecklistService`
    - _Requirements: 7.1, 7.2, 7.3, 8.2, 10.4, 12.5_

- [ ] 9. Checkpoint — Backend hoàn chỉnh
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Frontend (React 18)
  - [ ] 10.1 Tạo `autotgc-frontend/src/api/notifications.ts` + nối `NotificationsBell.tsx`
    - `api/notifications.ts` export `list`, `markRead`, `unreadCount`; nối `autotgc-frontend/src/components/NotificationsBell.tsx` với trạng thái chưa-đọc bền vững (đồng bộ badge với realtime frame `notification` đã có trong `RealtimeContext.tsx`)
    - _Requirements: 8.6, 9.1, 9.2, 9.4_

  - [ ] 10.2 Mở rộng `autotgc-frontend/src/pages/Dashboard.tsx`
    - ADMIN hiển thị company KPIs + "Hoạt động gần đây" (Recent Activity feed); SALES chỉ hiển thị thống kê cá nhân (personal-only), không feed/không company stats
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ] 10.3 Tạo trang `autotgc-frontend/src/pages/UserManagement.tsx` (ADMIN-only) + route + menu
    - Trang quản lý tài khoản gọi `/api/v1/users*` (list/tạo SALES/lock/unlock/đổi role/đặt-lại mật khẩu); thêm route vào `autotgc-frontend/src/App.tsx` và mục menu (roles: ['ADMIN']) trong `autotgc-frontend/src/components/Layout.tsx`
    - _Requirements: 5.1, 5.5, 5.6, 5.7_

- [ ] 11. Kiểm chứng xuyên suốt & triển khai
  - [ ] 11.1 Biên dịch backend
    - Chạy `npm run build` trong `autotgc-backend/`; sửa mọi lỗi type/compile trước khi tiếp tục
    - _Requirements: 12.2_

  - [ ] 11.2 Chạy toàn bộ bộ test
    - Chạy `npm test` (chế độ `--run`) trong `autotgc-backend/`; xác nhận toàn bộ unit/integration/property test xanh và mỗi trong 8 property test chạy ≥100 trường hợp, gắn tag `// Feature: admin-oversight-rbac-notifications, Property {n}: ...`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [ ] 11.3 Triển khai qua pipeline `deploy/` + cập nhật runbook vận hành
    - Tạo/refresh `autotgc-backend/deploy/DEPLOY-RUNBOOK-admin-oversight.md` (mẫu `DEPLOY-RUNBOOK-ai-reporting-ops.md`): các bước migration `0003` (`prisma generate` + `prisma migrate deploy`), `npm run build`, restart PM2 qua `deploy/pm2.config.js` dưới user non-root, sau Nginx `deploy/nginx-autotgc.conf`
    - Chạy quy trình deploy (`deploy/app-deploy.sh` / `deploy/run-deploy.ps1`); bước SSH push cần thông tin đăng nhập của operator nên runbook phải ghi rõ tiền điều kiện này (không hardcode host/IP/credentials — dùng env/vault)
    - _Requirements: 12.1, 12.3, 12.4, 12.5_

- [ ] 12. Checkpoint cuối — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Các sub-task gắn hậu tố `*` là test tùy chọn (property/unit/integration), có thể bỏ qua cho MVP nhanh nhưng nên thực hiện để đảm bảo đúng đắn (Req 11).
- 8 correctness property (1–8) được hiện thực bằng đúng một property test trong `autotgc-backend/test/admin-oversight.properties.test.ts`, gắn comment `// Feature: admin-oversight-rbac-notifications, Property {n}: ...`, chạy fast-check với `numRuns ≥ 100` (Req 11.6). Vì cùng một file, các tác vụ property test được serial hóa theo wave (xem ghi chú ở Overview).
- Mỗi task tham chiếu requirement (và property nơi áp dụng) để truy vết.
- Thay đổi schema/migration là additive (Req 1.5, 2.5, 12.1); không sửa `AuditEntry`.
- Mọi route mới đứng sau `requireAuth` + `rbacGuard`; mã trạng thái thuộc tập cho phép {200,201,202,400,401,403,404,409,423,500,502}; RBAC chỉ quyết định trong `auth/rbac.ts` (SSOT — Req 10.1).
- Ghi nhật ký/đẩy thông báo cô lập lỗi: không bao giờ làm thất bại/rollback hành động nghiệp vụ đã thành công (Req 7.5, 8.5).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1"] },
    { "id": 2, "tasks": ["3.2", "3.4", "5.1", "6.1"] },
    { "id": 3, "tasks": ["3.6", "5.2", "6.4"] },
    { "id": 4, "tasks": ["3.8", "7.1"] },
    { "id": 5, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 6, "tasks": ["8.1"] },
    { "id": 7, "tasks": ["10.1", "10.2", "10.3"] },
    { "id": 8, "tasks": ["2.2", "3.5", "5.3"] },
    { "id": 9, "tasks": ["2.3", "4.4"] },
    { "id": 10, "tasks": ["3.3"] },
    { "id": 11, "tasks": ["3.7"] },
    { "id": 12, "tasks": ["3.9"] },
    { "id": 13, "tasks": ["3.10"] },
    { "id": 14, "tasks": ["6.2"] },
    { "id": 15, "tasks": ["6.3"] },
    { "id": 16, "tasks": ["11.1"] },
    { "id": 17, "tasks": ["11.2"] },
    { "id": 18, "tasks": ["11.3"] }
  ]
}
```
