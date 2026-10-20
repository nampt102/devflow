## Why

Sau P1, một yêu cầu đã duyệt ở Triage dừng ở stage `ba_spec` và không ai làm tiếp. P2 cần một agent BA đọc yêu cầu, tài liệu nghiệp vụ và code của hệ thống liên quan, rồi đề xuất BA spec để người duyệt ở `ba_review`. Hướng đã chốt ở ADR 0020 và kết quả spike ở `kb/spike-p2-adapter.md` (agent `claude_local` chạy qua adapter của Paperclip, chỉ có tool đọc).

Change này chỉ làm **BA Spec**. Tech Plan dùng lại cùng cơ chế ở change sau (`add-tech-plan-stage`), để mỗi lần duyệt nhỏ hơn.

## What Changes

- **Danh mục Hệ thống theo công ty** (bảng mới `dr_systems`, `dr_request_systems`, **cần duyệt DDL trước migration**): mỗi hệ thống là một repo GitHub (URL, branch, thư mục docs, secret chứa token chỉ đọc). Trang Board UI "Systems" để quản lý.
- **Gán hệ thống ở Triage review**: Triage đề xuất hệ thống liên quan (prompt `triage.v4`), người duyệt xác nhận hoặc đổi khi approve. Có thể để trống.
- **BA worker do DevFlow điều khiển** (giống Triage worker): tìm case ở `ba_spec` chưa có đề xuất, dựng workspace (clone nông các repo đã gán, ghi lại commit SHA, file `.devflow/request.md`), gọi `wakeup` agent BA, đọc kết quả của run, kiểm bằng Zod strict, ghi `dr_agent_outputs` (stage `ba_spec`), rồi chuyển case sang `ba_review`.
- **Agent "DevFlow BA (internal)" mỗi công ty**: `claude_local`, `engine: cli`, chỉ tool `Read,Grep,Glob`, chặn đọc ngoài workspace bằng `--disallowedTools`, `--max-budget-usd` mỗi lượt, prompt có version `ba.v1` (hash ghim bằng test).
- **Màn hình BA review** (Board UI): xem spec và trích dẫn `file:dòng` (link GitHub theo SHA), sửa field, đổi hệ thống, approve (`tech_plan`) / reject (`cancelled`) / request_changes (`ba_spec`, lý do đưa vào lượt chạy sau). Ghi `dr_overrides`, quyết định nguyên tử qua hook `beforeCommit` đã có.
- **Chi phí và an toàn**: trần USD mỗi ngày mỗi công ty cho agent adapter (tính từ `cost_events`), công tắc `DEVFLOW_WORKERS_ENABLED` dừng cả BA worker, lỗi gần đây hiện ở mục Quality.
- Email nhân viên gom thêm hàng chờ `ba_review`.

## Capabilities

### New Capabilities
- `ba-spec`: hệ thống được gán cho yêu cầu, agent BA đề xuất spec có trích dẫn, nhân viên duyệt ở `ba_review`.

### Modified Capabilities
(không có; `intake-portal` không đổi, requester vẫn chỉ thấy nhãn trạng thái)

## Impact

- `packages/db`: migration mới (`dr_systems`, `dr_request_systems`), test cách ly công ty.
- `server/src/devflow/`: `systems/` (CRUD, clone), `ba/` (worker, service, schema, agent), `prompts/ba.v1.ts`, `prompts/triage.v4.ts`, route mới; mở rộng triage-review (gán hệ thống), metrics, staff digest.
- `ui/`: trang Systems, trang BA review, chọn hệ thống trong Triage review.
- `docker/`: biến môi trường cho agent BA (model, key, ngân sách).
- Không đổi core Paperclip ngoài hook đã có. Không có dependency mới.

## Ngoài phạm vi
Tech Plan; approver theo role BA/Tech Lead; model local cho agent adapter (`opencode_local`); bubblewrap hoặc runner tách riêng; requester trả lời câu hỏi mở trên portal; Confluence/SharePoint.
