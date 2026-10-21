## Why

Từ 2026-10-20, yêu cầu có BA spec đã duyệt chuyển sang stage `tech_plan` rồi dừng ở đó vì chưa có gì chạy (REQ-1 của RESKI đang nằm chờ). P2 cần một agent đọc spec đã duyệt và code của các hệ thống được gán, rồi đề xuất kế hoạch kỹ thuật để Tech Lead duyệt ở `plan_review` trước khi sang Dev. Hướng đã chốt ở ADR 0020; cơ chế chạy agent đã kiểm chứng với BA Spec (ADR 0021, `kb/ba-spec.md`).

## What Changes

- **Khung chạy agent dùng chung cho các stage** (tách từ code BA, không đổi hành vi BA): runner gọi `wakeup` và đọc run, dựng và dọn workspace (clone repo, `.devflow/request.md`, transcript của Claude Code), kiểm cấu hình agent, worker có backoff, breaker, trần USD ngày. BA và Tech Plan chỉ khác prompt, schema đầu ra, stage và cấu hình.
- **Một lượt agent cùng lúc cho cả instance, mọi stage** (BA và Tech Plan dùng chung khóa), và luật chặn đọc workspace của stage kia, để dữ liệu công ty khác không bao giờ nằm cạnh agent.
- **Agent "DevFlow Planner" mỗi công ty**: `claude_local`, `engine: cli`, chỉ `Read,Grep,Glob`, cùng danh sách chặn như BA, model mặc định `claude-sonnet-5-5` (`DEVFLOW_PLAN_MODEL`), ngân sách riêng mỗi lượt và mỗi ngày. Tạo bằng `scripts/devflow/setup-plan-agent.mjs` (cùng cách với BA).
- **Tech Plan worker**: case ở `tech_plan` chưa có đề xuất → workspace gồm repo của hệ thống đã gán và `request.md` có **spec BA đã duyệt** (`data.approved`) → agent trả JSON (prompt `plan.v1`, Zod strict) → ghi `dr_agent_outputs` stage `tech_plan` → chuyển sang `plan_review`.
- **Nội dung kế hoạch**: tóm tắt, hướng giải quyết, danh sách task kỹ thuật theo hệ thống (file cần sửa có trích dẫn `path:line`, phụ thuộc giữa task, cỡ S/M/L), thay đổi dữ liệu, thay đổi API, kế hoạch test, rủi ro, câu hỏi mở, độ tin cậy.
- **Màn hình Plan review** (Board UI, cùng khuôn BA review): xem kế hoạch, trích dẫn link GitHub theo SHA, sửa các trường văn bản và tiêu đề/mô tả/cỡ của task, approve (`dev`) / reject (`cancelled`) / request_changes (`tech_plan`, lý do vào lượt sau). Ghi `dr_overrides`, kế hoạch đã duyệt lưu ở `data.approved`.
- Email nhân viên gom thêm hàng chờ `plan_review`; số liệu và chi phí Tech Plan trong mục Quality.

## Capabilities

### New Capabilities
- `tech-plan`: agent Planner đề xuất kế hoạch kỹ thuật từ spec BA đã duyệt và code của hệ thống được gán; nhân viên duyệt ở `plan_review`.

### Modified Capabilities
(không có; `ba-spec` giữ nguyên hành vi, chỉ tách code dùng chung)

## Impact

- `server/src/devflow/`: thư mục dùng chung mới cho khung chạy agent (tách từ `ba/`), `plan/` (service, schema, review, metrics, routes, start), `prompts/plan.v1.ts`; khởi động worker trong `index.ts`; staff digest.
- `ui/`: trang Plan review, số đếm sidebar.
- `scripts/devflow/`: `setup-plan-agent.mjs`, smoke Tech Plan.
- `docker/`: biến `DEVFLOW_PLAN_*`.
- **Không có migration**: `dr_agent_outputs` và `dr_overrides` đã nhận `stage_key` bất kỳ. Không đổi core Paperclip, không dependency mới.
- Sau khi triển khai phải chạy lại `setup-ba-agent.mjs` cho mỗi công ty (danh sách chặn của BA thêm workspace Tech Plan).
- Chi phí: sonnet đắt hơn haiku nhiều lần; có trần mỗi lượt và mỗi ngày.

## Ngoài phạm vi
Dev agent (P3; case sau `plan_review` dừng ở `dev`); approver theo role Tech Lead (B-06); trả kế hoạch về BA Spec từ `plan_review` (pipeline chỉ cho quay về `tech_plan`); sửa cấu trúc task (thêm, xóa, đổi phụ thuộc, đổi file) trên giao diện; xuất task sang Jira hay issue tracker; model local.
