# Data model mở rộng cho Workflow Core

> **ĐỀ XUẤT, chưa duyệt, chưa có migration.** Khi bắt đầu plan-p1 bước 3 sẽ chuyển thành `design.md` của một change OpenSpec.

**Trạng thái: ĐỀ XUẤT, chưa duyệt, chưa có migration.** Mọi thay đổi schema đi qua `pnpm db:generate` / `pnpm db:migrate` (Drizzle, `packages/db`).

## Nguyên tắc
1. **Tái dùng pipelines của Paperclip**, không tạo state machine thứ hai. Một "yêu cầu" = một `pipeline_case` trong pipeline `dev-request`.
2. Bảng mới chỉ chứa phần Paperclip chưa có: dữ liệu nghiệp vụ có cấu trúc, output của agent, audit override, prompt version, embedding.
3. Mọi bảng có `company_id` (cách ly multi-company, giống bảng hiện có).
4. Dữ liệu dashboard query được nằm trong **cột/bảng**, không chôn trong `fields` jsonb.

## Ánh xạ khái niệm

| Khái niệm DevFlow | Tái dùng của Paperclip | Ghi chú |
|---|---|---|
| Ticket cha | `pipeline_cases` (parent_case_id = null) | `case_key` làm mã hiển thị, ví dụ `REQ-123` |
| Stage | `pipeline_stages` | 7 stage, xem dưới |
| Gate duyệt | stage `kind = review` + `config.approveToStageKey/rejectToStageKey/requestChangesToStageKey` | |
| Agent đề xuất | `pipeline_cases.pending_suggestion` | Chỉ là đề xuất |
| Lịch sử | `pipeline_case_events` | Tái dùng; bổ sung audit field-level nếu thiếu |
| Task con (Dev) | `issues` + `pipeline_case_issue_links` (role `work`) | |
| Run của agent | bảng run/heartbeat có sẵn | Liên kết qua `run_id` |
| Chi phí | cost events có sẵn | Join theo run |

## Pipeline `dev-request` (seed, cấu hình không phải code)

| position | key | kind | Ai làm | Gate |
|---|---|---|---|---|
| 100 | `triage` | working | Triage agent | |
| 150 | `triage_review` | review | Lead/BA | approve → `ba_spec`; request_changes → `triage` |
| 200 | `ba_spec` | working | BA agent | |
| 250 | `ba_review` | review | BA | |
| 300 | `tech_plan` | working | Planner agent | |
| 350 | `plan_review` | review | Tech Lead | |
| 400 | `dev` | working | Coding agent / dev | |
| 450 | `code_review` | review | Dev khác | |
| 500 | `qa` | working | QA agent + QA người | |
| 550 | `qa_signoff` | review | QA | |
| 900 | `done` | done | Agent tổng hợp | |
| 1000 | `cancelled` | cancelled | | |

Stage "Intake" (stage 0) là hành động tạo case từ portal, không cần stage riêng: case sinh ra ở `triage`.
Phần P1 chỉ dùng `triage`, `triage_review`, `done`, `cancelled`; các stage sau được seed sẵn nhưng chưa chạy.

## Bảng mới (đề xuất)

### `dr_requests` — dữ liệu nghiệp vụ của yêu cầu (1–1 với `pipeline_cases`)
| Cột | Kiểu | Ghi chú |
|---|---|---|
| case_id | uuid PK/FK → pipeline_cases | |
| company_id | uuid FK | |
| requester_id | uuid FK → `dr_requesters` | người gửi |
| description | text | mô tả gốc của user |
| business_impact | text null | |
| classification | text null | bug / feature / request (do triage, sau khi duyệt) |
| priority | text null | urgent/high/medium/low |
| difficulty | text null | gợi ý độ khó |
| requires_human | boolean | cờ "bắt buộc người làm" |
| requires_human_reasons | text[] | vd `sqlserver_migration`, `production_change` |
| duplicate_of_case_id | uuid null | chỉ set sau khi duyệt |
| source | text | portal / email... |
| created_at, updated_at | timestamptz | |

### `dr_requesters` — user nghiệp vụ (không phải board user)
`id`, `company_id`, `email`, `display_name`, `auth_subject` (liên kết better-auth/SSO sau), `created_at`.
Requester chỉ đọc case của mình qua API portal. **Quyết định mở: dùng bảng user của better-auth + role, hay bảng riêng.** (xem plan-p1)

### `dr_attachments`
`id`, `company_id`, `case_id`, `storage_key`, `filename`, `mime`, `size_bytes`, `uploaded_by`. Chưa rõ Paperclip có storage file dùng lại được không (cần spike).

### `dr_agent_outputs` — output có cấu trúc của agent (dạng thứ 2 bên cạnh comment)
| Cột | Ghi chú |
|---|---|
| id, company_id, case_id | |
| stage_key | `triage`, `ba_spec`... |
| agent_id, run_id | liên kết run và chi phí |
| prompt_id, prompt_version | prompt nào, version nào sinh ra output |
| schema_version | |
| data | jsonb, theo schema từng stage (validate bằng Zod) |
| comment_text | bản dễ đọc |
| status | `proposed` / `accepted` / `overridden` / `superseded` |
| created_at | |

Một case có thể có nhiều output cho cùng stage (khi request_changes, chạy lại); chỉ bản mới nhất `proposed`.

### `dr_overrides` — audit + thước đo chất lượng agent
`id`, `company_id`, `case_id`, `output_id`, `stage_key`, `field` (vd `priority`), `agent_value` jsonb, `final_value` jsonb, `actor_user_id`, `reason` text null, `created_at`.
Tỷ lệ override = số field bị đổi / số field agent đề xuất, nhóm theo agent, prompt_version, stage.
Mỗi lần duyệt (kể cả không đổi gì) vẫn ghi `pipeline_case_events`; bảng này chỉ lưu **khác biệt**.

### `dr_prompts`
`id`, `company_id` null (null = dùng chung), `role` (triage/ba/planner/qa), `version` int, `body` text, `output_schema` jsonb, `status` draft/active/retired, `created_by`, `created_at`. Unique `(company_id, role, version)`. Cần xem skills/instruction revisions của Paperclip có thay thế được không (chưa xác nhận); nếu được thì bỏ bảng này.

### `dr_embeddings` (P1 hoặc P2, xem quyết định)
`id`, `company_id`, `source_type` (case/doc), `source_id`, `model`, `embedding vector(n)`, `content_hash`, `created_at`. Cần pgvector.

### `dr_stage_durations` (view, không phải bảng)
Dẫn xuất từ `pipeline_case_events` (thời điểm vào/ra stage) cho dashboard: thời gian ở mỗi stage, ticket kẹt, lead time.

## Kiểm tra bất biến (test bắt buộc)
- Không chuyển stage khi chưa có approval ở review stage trước đó.
- Agent không thể tự approve (đã có `assertActorCanApproveStageExit`, viết test hồi quy cho pipeline `dev-request`).
- Mọi approve/override tạo đúng một event và (nếu đổi giá trị) một dòng `dr_overrides`.
- Case của công ty A không đọc/ghi được từ công ty B.
- Requester chỉ thấy case của mình.

## Chưa chắc
- `pipeline_case_events` đã ghi field-level diff chưa (nếu chưa, port ý tưởng activity diff từ Plane).
- Bảng mới nên nằm trong core `packages/db` hay trong plugin DB namespace (Paperclip hỗ trợ). Đề xuất core vì sở hữu source lâu dài.
- Approver theo role: `config.reviewerKind` hiện thấy `human`; cần đọc `pipelines.ts` để biết có mở rộng sang role được không.
