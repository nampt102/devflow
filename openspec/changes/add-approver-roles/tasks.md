# Tasks

## 1. Duyệt

- [x] 1.1 Chủ dự án duyệt proposal, design (D1–D7), migration `0360` và spec `approver-roles`

## 2. Schema và lõi

- [x] 2.1 `packages/db`: bảng `dr_member_roles` (D1), export, migration `0360` sinh bằng `pnpm db:generate`; test migration áp sạch và CHECK/unique hoạt động
- [x] 2.2 `packages/shared`: validator approver kiểu `role` (D2) và kiểu dùng chung cho danh sách vai
- [x] 2.3 `pipelines.ts`: `normalizeStageConfig` nhận kind `role`; `assertActorCanApproveStageExit` thành async với nhánh `role` (D3, D4); `PipelineActor` thêm `instanceAdmin?`
- [x] 2.4 Test lõi: chạy toàn bộ `pipelines-*` (mốc hành vi cũ); test mới cho từng nhánh `any_human|user|agent` không đổi và nhánh `role` (đúng vai, thiếu vai, nhiều vai, owner, instance admin, agent, đường chuyển stage trực tiếp); đột biến: bỏ kiểm vai, bỏ kiểm đường chuyển stage, bỏ quyền owner đều bị bắt

## 3. Quản lý vai trò

- [x] 3.1 `devflow/roles/` (service, routes): GET liệt kê staff kèm vai, PUT thay danh sách vai của một người trong giao dịch, kiểm thành viên đang hoạt động, 422 cho vai lạ, `activity_log` khi có thay đổi (D5)
- [x] 3.2 Test: chỉ owner/instance admin (403 cho nhân viên thường, agent, requester), 404 công ty khác, cách ly công ty, idempotent, có audit
- [x] 3.3 `scripts/devflow/set-member-roles.mjs`
- [x] 3.4 UI màn hình Roles (D8): `ui/src/api/devflowRoles.ts`, `pages/Roles.tsx`, route `/roles`, mục sidebar (cả hai file Sidebar), query keys; logic thuần ở `lib/` có test; `pnpm check:token-gates` không lỗi

## 4. Pipeline và màn hình duyệt

- [x] 4.1 Đọc `setup-dev-request-pipeline.mjs`; `dev-request-pipeline.json` đặt approver theo vai cho ba stage; script cập nhật công ty đã seed chỉ ở trường `approver`, chạy lại không đổi gì, có cờ `--any-human` để hoàn tác (D7); cập nhật test `devflow-dev-request-pipeline`
- [x] 4.2 Ba service chi tiết trả `canDecide` và `requiredRoles` từ cùng hàm tính quyền (D6); route duyệt truyền `instanceAdmin` vào actor
- [x] 4.3 UI ba trang duyệt tắt nút quyết định và nêu vai cần có khi `!canDecide`; test logic; `pnpm check:token-gates` không lỗi ở file đổi
- [x] 4.4 Test tích hợp trên Postgres nhúng cho ba stage: thiếu vai bị 403 và case không đổi, đủ vai duyệt được, hai vai kết hợp

## 5. Kiểm chứng và triển khai

- [x] 5.1 Typecheck server, UI, db, shared; test DevFlow và `pipelines-*` pass (gồm pgvector)
- [x] 5.2 Build image (hướng dẫn trong `kb/tech-stack.md`), gán vai cho nhân viên hiện có của RESKI và DevFlow Verify, chạy lại seed pipeline, thử bằng tài khoản không có vai. Đã làm ngày 2026-10-21 ở DevFlow TEST (tên mới của DevFlow Verify); chủ dự án thử ok. RESKI chỉ có owner nên chưa gán vai và chưa đổi approver; làm khi có nhân viên thật
- [x] 5.3 Cập nhật `kb/runbook.md` (thứ tự triển khai, cách gán vai), `kb/triage-review.md`, `kb/ba-spec.md`, `kb/tech-plan.md`, `kb/dev-request-pipeline.md`, ADR 0023, `status.md`; đánh dấu B-06 xong trong `backlog.md`
