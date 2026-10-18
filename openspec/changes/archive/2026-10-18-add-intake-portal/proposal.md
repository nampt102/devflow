## Why

User nghiệp vụ trong tập đoàn chưa có cách gửi và theo dõi yêu cầu phần mềm mà không dùng board kỹ thuật của Paperclip. Cần một Intake Portal tiếng Việt, tách khỏi board, để mỗi yêu cầu trở thành một ticket ở stage Triage của pipeline `dev-request`.

## What Changes

- Thêm API `/api/portal/*` cho requester (user nghiệp vụ): gửi yêu cầu, xem danh sách yêu cầu của mình, xem trạng thái bằng nhãn tiếng Việt, bổ sung thông tin và file đính kèm.
- Thêm guard `assertRequester`: chỉ user có bản ghi `dr_requesters` đang hoạt động; `companyId` và `requesterId` luôn lấy từ bản ghi này, không tin tham số request.
- Thêm cơ chế mời requester bằng link một lần (`dr_requester_invites`, bảng mới, **cần duyệt DDL trước khi tạo migration**).
- Thêm app web `portal/` (React + Vite, chỉ tiếng Việt), server phục vụ tĩnh ở `/portal`.
- Mã yêu cầu `REQ-n` dùng `caseKey`; giới hạn file và tần suất gửi.

Quyết định đã duyệt (2026-10-17): A1 (link mời một lần), B1 (`/api/portal/*` cùng server), C1 (app `portal/` riêng). Xem `openspec/kb/requester-access.md`.

## Capabilities

### New Capabilities
- `intake-portal`: requester gửi và theo dõi yêu cầu, được cách ly khỏi board và khỏi requester khác.

### Modified Capabilities
(không có)

## Impact

- `server/`: route mới, guard, service portal; mount trước fallback UI board trong `app.ts`.
- `packages/db`: migration mới cho `dr_requester_invites` (chờ duyệt).
- `portal/`: workspace package mới; đổi `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `Dockerfile`.
- Dựa trên `dr_*` (migration 0355) và pipeline `dev-request`.
