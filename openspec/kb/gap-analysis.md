# Gap analysis: Paperclip so với 9 module DevFlow

Nguồn: `openspec/kb/paperclip-architecture.md` (đọc từ code, commit `5555817c2`) và `../_ref/notes/plane-reference.md`.
Ký hiệu: ✅ có sẵn · 🟡 có một phần · ❌ chưa có.

## Phát hiện quan trọng nhất

Paperclip đã có **Pipelines** (bảng `pipelines`, `pipeline_stages`, `pipeline_transitions`, `pipeline_cases`, `pipeline_case_events`...
trong `packages/db/src/schema/pipelines.ts`, `pipeline_cases.ts`, `pipeline_case_events.ts`). Đây gần đúng "Workflow Core" ta cần:
stage có `kind` working/review/done/cancelled, review stage có `requireApproval` + 3 lối ra (approve/reject/request_changes),
agent chỉ đề xuất qua `pendingSuggestion` (`autonomy: "auto"` bị chặn trong code), có `enforceTransitions`, version/lease, breakdown thành case con.

**Rủi ro:** tính năng này đang **Experimental** (`enablePipelines` mặc định false). Chưa ai đọc hết `server/src/services/pipelines.ts` (~5.200 dòng) hay chạy smoke test. Việc đầu tiên của P1 là spike xác nhận.

## Theo module

| # | Module | Trạng thái | Paperclip có gì | Còn thiếu |
|---|---|---|---|---|
| 1 | Intake Portal | ❌ | Chỉ có board UI (React) cho người vận hành. Auth là better-auth email/password | Portal riêng cho user nghiệp vụ: form tiếng Việt, upload ảnh/file, xem trạng thái ticket của mình, vai trò "requester" không vào được board. Plane có API intake công khai nhưng không có UI form trong bản clone |
| 2 | Workflow Core | 🟡 (khá nhiều) | Pipelines: stage, transition, review gate, approver (any_human/user/agent), event log, lease | Cấu hình pipeline 7 stage của ta; phân quyền "ai duyệt stage nào" theo vai trò Lead/BA/Tech Lead/QA (chỉ có any_human/user/agent, chưa rõ có theo role); trường nghiệp vụ có cấu trúc; liên kết ticket cha-con theo stage |
| 3 | Agent Runtime | 🟡 | Heartbeat, adapters: claude_local (Claude Code), codex, cursor, gemini, opencode, pi, http... | **Không có adapter OpenAI-compatible/vLLM riêng**: phải kiểm chứng `opencode_local`/`pi_local`/`http` hoặc viết adapter plugin. API thương mại trực tiếp: chưa xác nhận |
| 4 | Skills/Prompts | 🟡 | Hệ thống skills, instruction revisions (`doc/agent-instruction-revisions.md`) | Prompt Triage/BA/Planner/QA có version gắn với từng output; schema output chuẩn |
| 5 | Knowledge | 🟡 (yếu) | Tìm kiếm lexical Postgres (pg_trgm, `doc/SEARCH.md`) | **Không có embedding/vector**. Cần pgvector (chưa rõ embedded Postgres có hỗ trợ không) |
| 6 | Governance | ✅ (phần lớn) | Activity log, cost events, budgets, company approvals, `executionPolicy` | Số liệu "tỷ lệ override" theo agent/stage; gắn chi phí theo stage của request |
| 7 | Notification | ❌ | Kênh AgentMail là cho agent, không phải thông báo cho người | Email SMTP cho người duyệt/requester; lớp kênh trừu tượng để thêm Teams/Zalo. Plane dùng Celery, không dùng lại được |
| 8 | Dashboard | 🟡 | Dữ liệu cost, run, event có sẵn | Query theo stage, thời gian nằm ở stage, ticket kẹt, lead time, override, lỗi agent; 2 view (IT và lãnh đạo). UI chủ yếu tiếng Anh |
| 9 | Identity | 🟡 | Multi-company, cách ly bằng `assertCompanyAccess` (tầng ứng dụng, **không có RLS**) | SSO/OIDC (hiện chỉ email/password); vai trò theo công ty; test cách ly dữ liệu giữa các công ty |

## Khái niệm Paperclip: giữ, ẩn, bỏ

| Khái niệm | Quyết định | Lý do |
|---|---|---|
| Company | **Giữ** | Chính là "công ty trong tập đoàn", đơn vị cách ly dữ liệu |
| Pipelines/cases | **Giữ, làm lõi** | Xem trên |
| Issues | **Giữ** | Task con ở stage Dev; liên kết case↔issue có sẵn (`pipeline_case_issue_links`) |
| Agents, adapters, heartbeat | **Giữ** | Cơ chế chạy agent; heartbeat dùng làm trigger chạy bước agent, ẩn khái niệm khỏi user |
| Projects/workspaces | **Giữ** | Cần cho Dev agent (worktree/PR) ở P3 |
| Costs, budgets, activity log | **Giữ** | Governance |
| Plugins, skills | **Giữ** | Đường mở rộng không sửa lõi |
| Org chart, CEO/hire agent | **Ẩn** | Không hợp quy trình dev nội bộ |
| Goals/mission, onboarding | **Ẩn** | Như trên |
| Chat/voice/bot thử nghiệm, Cloud, telemetry | **Tắt/ẩn** | Không cần; telemetry cần xác nhận cách tắt (chưa rõ) |

## Phần nên tham khảo/port từ Plane (đã chốt: đọc code và viết lại, phần port theo AGPL)

| Phần | Paperclip đã có? | Kết luận |
|---|---|---|
| Ngữ nghĩa intake: pending/accepted/declined/snoozed/duplicate | Một phần (review gate) | **Port ý tưởng + UI hàng chờ triage**. Snooze/duplicate là mới |
| Activity diff (field cũ → mới) | Có `pipeline_case_events` + activity log | **Port cách ghi diff** nếu event hiện tại chưa ghi field-level; cần kiểm tra |
| Work item model (relations, sequence id) | Issues + pipeline_cases có sẵn | Gần như **không cần port**; chỉ lấy ý tưởng relation `duplicate` |
| Kanban | Chưa rõ | Dùng thẳng thư viện `@atlaskit/pragmatic-drag-and-drop` (Apache-2.0, chưa xác nhận license), không cần port |
| Saved views, analytics | Chưa có | Port ý tưởng ở P2–P3 |
| Notification/email | Không | Viết mới trên scheduler của Paperclip |

→ Phạm vi port từ Plane **nhỏ hơn dự kiến ban đầu**, chủ yếu là UI hàng chờ triage và quy tắc intake.

## Chưa chắc (cần spike ở P1)
- Pipelines có đủ ổn định không; agent key có quyền gì trên route pipelines.
- Approver theo role có mở rộng được không (plugin hay sửa lõi).
- `cases` (bảng riêng, cờ `enableCases`) liên quan gì `pipeline_cases`.
- vLLM chạy qua adapter nào.
- pgvector trên embedded Postgres.
- Build trên Windows (script dùng `rm -rf`/`cp`; có thể cần WSL/Git Bash).
