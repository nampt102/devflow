## Why

Ba màn hình duyệt (Triage review, BA review, Plan review) hiện cho **mọi board user không phải viewer** quyết định, vì stage review dùng `approver: any_human` và Paperclip không có approver theo vai trò (`kb/spike-pipelines.md`, backlog B-06). Pilot RESKI chỉ vài người nên chưa gây hại; trước khi thêm nhân viên, bất kỳ ai có tài khoản board cũng duyệt được kế hoạch kỹ thuật, trái nguyên tắc "mọi gate là người có đúng vai trò duyệt". Một người có thể kiêm nhiều vai (BA và Tech Lead), nên vai trò phải là danh sách, không phải một giá trị.

## What Changes

- **Bảng mới `dr_member_roles`** (migration `0360`): vai trò nghiệp vụ của nhân viên trong một công ty, nhiều dòng cho mỗi người. Vai trò: `ba`, `tech_lead` (danh sách cố định có CHECK; thêm vai sau này bằng migration).
- **Approver kiểu mới `role`** ở lõi Paperclip: cấu hình stage `approver: { kind: "role", roles: ["ba", "tech_lead"] }`; người duyệt phải có **ít nhất một** vai trong danh sách. Cần vá `packages/shared` (validator), `server/src/services/pipelines.ts` (`normalizeStageConfig`, `assertActorCanApproveStageExit`: hàm này hiện đồng bộ và không có DB nên phải thành bất đồng bộ trong giao dịch) và hai chỗ gọi nó (`transitionCaseInTransaction`, `reviewCase`).
- **Ngoại lệ có chủ đích**: chủ sở hữu công ty (membership `owner`) và instance admin luôn duyệt được mọi stage, để một công ty chưa gán vai không bị khóa.
- **Pipeline `dev-request`**: `triage_review` và `ba_review` cho `ba` hoặc `tech_lead`; `plan_review` chỉ `tech_lead`. Các review của stage chưa có agent (Dev, QA) giữ `any_human` đến khi làm P3.
- **API quản lý vai trò** (`/api/companies/:id/devflow/member-roles`): xem, gán, gỡ; chỉ owner hoặc instance admin; mỗi thay đổi ghi `activity_log`. Script `scripts/devflow/set-member-roles.mjs` cho thao tác dòng lệnh.
- **Màn hình quản lý vai trò trên Board UI** (`/roles`, mục "Roles" ở sidebar): bảng nhân viên của công ty kèm vai, owner và instance admin bật tắt `ba`, `tech_lead` cho từng người; người khác chỉ xem. Dùng đúng API ở trên, không có đường ghi riêng.
- **Ba màn hình duyệt** nhận `canDecide` trong chi tiết case và tắt nút quyết định kèm lý do khi người xem không có vai; server vẫn là nơi chặn (403 `review_required`).
- **Cập nhật pipeline đã seed** của công ty có sẵn (RESKI, DevFlow Verify): cấu hình stage nằm trong DB nên đổi file JSON không đủ; script seed cập nhật `approver` của ba stage, chạy lại được.

## Capabilities

### New Capabilities
- `approver-roles`: nhân viên có một hoặc nhiều vai trò nghiệp vụ trong công ty; stage duyệt đòi vai trò; owner và instance admin là ngoại lệ; thay đổi vai trò có audit.

### Modified Capabilities
(không có; spec `ba-spec` và `tech-plan` mô tả hành vi duyệt chung, vai trò nằm ở capability mới)

## Impact

- `packages/db`: bảng `dr_member_roles`, migration `0360` (**đổi schema, cần chủ dự án duyệt trước khi code**).
- `packages/shared`: validator approver kiểu `role`.
- `server/src/services/pipelines.ts`: vá lõi (bất đồng bộ hóa kiểm tra approver); chạy lại test hồi quy `pipelines-*`.
- `server/src/devflow/`: `roles/` (service, routes), `dev-request-pipeline.json`, `canDecide` trong ba service duyệt.
- `ui/`: ba trang duyệt (nút quyết định theo `canDecide`); trang mới `Roles`, API client, mục sidebar.
- `scripts/devflow/`: `set-member-roles.mjs`, cập nhật script seed.
- **Rủi ro triển khai**: nếu đổi cấu hình stage trước khi gán vai, chỉ owner và admin duyệt được. Thứ tự: gán vai cho nhân viên hiện có, rồi mới cập nhật pipeline đã seed.
- Không dependency mới.

## Ngoài phạm vi
Vai trò theo hệ thống hoặc theo pipeline; vai trò cho requester của portal; SSO và nhóm (P4); stage Dev và QA.
