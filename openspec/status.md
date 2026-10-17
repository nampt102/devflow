# Trạng thái dự án

> Đọc file này đầu tiên mỗi phiên. Cập nhật cuối mỗi bước/phiên. Lịch sử chi tiết ở `changes/archive/` và git log.

**Cập nhật lần cuối:** 2026-10-17

## Phase hiện tại
**P1**: Intake Portal + Workflow Core + Triage agent, pilot 1 công ty. P0 (khám phá Paperclip/Plane, docs, khung project-kit) đã xong.

## Bước đang làm
Bước 2 **đã xong** (xem bảng, `kb/dev-request-pipeline.md`). Chờ chủ dự án duyệt schema trước bước 3.

## Bước tiếp theo
1. Chủ dự án duyệt `kb/data-model-proposed.md` (migration #1: `dr_requests`, `dr_requesters`, `dr_attachments`), kèm quyết định cho các bản vá (role approver, REQ-n, field-diff...) sẽ làm ở đâu.
2. Bước 3: migration #1 + test cách ly công ty (cần duyệt schema).
3. Song song được sau bước 3: bước 4 (portal) và bước 5.

## Việc bị chặn / chờ quyết định
- Còn thiếu (chưa chặn bước 0–2): model embedding, endpoint/model vLLM, thông tin SMTP (chủ dự án tự tạo/cập nhật env khi test).
- Telemetry của Paperclip (mặc định bật, gửi về endpoint của Paperclip): **để mở**, chưa quyết định tắt hay giữ; cần tìm cách tắt trong code trước khi quyết.
- Agent chưa được thử ở runtime (chưa có agent/adapter, chưa thử vLLM qua opencode_local/pi_local/http); quyền agent trên pipeline mới xác nhận qua code và test, chưa qua runtime.
- Số chiều vector và model embedding: chốt khi làm migration (bước 3/5).

## Bảng tiến độ P1

| # | Bước | Trạng thái | Change / PR | Ghi chú |
|---|---|---|---|---|
| 0 | Dựng môi trường Docker (Postgres + pgvector), chạy Paperclip, bật `enablePipelines`, chạy tutorial | done: stack chạy trên Docker Desktop (server :3100, migrations OK, pgvector 0.8.7 có sẵn; extension chưa tạo) | | Chưa rõ Docker của repo hỗ trợ pgvector; có thể cần compose riêng |
| 1 | Spike Pipelines: approver theo role, quyền agent key, event field-level, request_changes, test hiện có | done: đọc code + smoke API thật (tạo công ty, pipeline 4 stage, case, transition, review approve → done đều 200) | | Pipelines đang experimental; kết quả chốt lại D1 |
| 2 | Seed pipeline `dev-request` (12 stage; P1 dùng `triage`, `triage_review`, `done`, `cancelled`) + test state machine/gate | done: định nghĩa JSON + 8 test (pass, đột biến bị bắt) + script seed/verify 7/7 pass trên stack thật | | |
| 3 | Migration #1: `dr_requests`, `dr_requesters`, `dr_attachments` | todo | | Chủ dự án duyệt schema trước |
| 4 | Intake Portal tiếng Việt, tách khỏi board: đăng nhập requester, form, upload, trạng thái ticket | todo | | UI board gần như chưa có i18n |
| 5 | Migration #2: `dr_agent_outputs`, `dr_overrides`, `dr_prompts` (hoặc dùng skills Paperclip) + `dr_embeddings` (pgvector) | todo | | Phụ thuộc kết quả spike |
| 6 | Triage agent: prompt v1 có version, output JSON (Zod) + comment, `pendingSuggestion`; provider API/local theo config | todo | | Cần endpoint vLLM; chưa có adapter vLLM chuẩn |
| 7 | Dedupe bằng pgvector + LLM xếp hạng (embedding API/local theo config) | todo | | Đổi provider = re-index |
| 7b | Email requester khi đổi trạng thái (SMTP qua env) | todo | | SMTP giả khi test tự động |
| 8 | Màn hình duyệt triage cho Lead/BA (hàng chờ, sửa field, approve/reject/request_changes, snooze/duplicate), ghi override; port ngữ nghĩa/UI intake từ Plane | todo | | Port từ Plane ở mức M–L |
| 9 | Số liệu cơ bản: tỷ lệ override theo field, thời gian ở triage | todo | | |
| 10 | Pilot hardening: log lỗi agent, ngân sách token, tài liệu vận hành | todo | | Chủ dự án tự chọn công ty và tự chạy test |

Thứ tự: 0 → 1 → 2 → 3 → {4, 5} → 6 → 7 → 7b → 8 → 9 → 10.

## Quyết định chính (link tới `decisions/`)
- 0001 Fork Paperclip (MIT) làm lõi
- 0002 Đọc và port code Plane (không clean-room); hoãn xét AGPL
- 0003 Dùng Pipelines của Paperclip làm lõi workflow (D1)
- 0004 Bảng mới trong core `packages/db` (D2)
- 0005 pgvector ở P1; embedding API + local theo config (D3)
- 0006 Email "đổi trạng thái" cho requester ở P1 (D4)
- 0007 Requester dùng better-auth + role (D5)
- 0008 LLM cho agent: API thương mại + local theo config (D6)
- 0009 Dev bằng Docker (D8)
- D7 (không phải ADR): chủ dự án tự chọn công ty pilot và tự chạy test; Claude bàn giao code, test tự động, hướng dẫn chạy.

## Kết quả spike Pipelines (đọc code + smoke API; chi tiết `kb/spike-pipelines.md`)
Kết luận: **cần vá, không phải viết lại state machine**. Chưa thấy lý do bỏ D1. Bản vá cần làm (đều thêm vào core): approver theo role BA/Tech Lead (M; hiện chỉ any_human/user/agent), diff field-level cho audit (M), output có cấu trúc theo stage (M), `case_key` dạng REQ-n (S, hiện là UUID), portal requester (M-L; hiện mọi member đọc được mọi case), chặn agent sửa config stage (S), gate cờ `enablePipelines` ở server (S). Agent không vượt được review stage (có test).

## Rủi ro mở
0. File Pipelines rất lớn (service ~5k dòng, UI ~5k dòng): sửa khó, nhưng ta không theo upstream nên chấp nhận được.
1. Pipelines experimental, có thể phải vá lõi.
2. Chất lượng Triage agent: cần bộ mẫu thật; tỷ lệ override là thước đo.
3. UI board gần như chưa có i18n (chỉ 5 key): portal tách riêng.
4. Cách ly dữ liệu công ty chỉ ở tầng ứng dụng (không RLS): test bắt buộc, cân nhắc RLS ở P4.
5. AGPL ở phần port từ Plane: hoãn xét đến sau bản test; phải xem lại trước khi triển khai thật (ADR 0002).
6. Telemetry mặc định bật của Paperclip (xem mục chờ quyết định).

## Lộ trình tổng
P1 (đang chuẩn bị) → P2 BA Spec + Planner agent, gate còn lại, email mở rộng → P3 Dev agent (worktree/PR), QA agent, dashboard → P4 Governance đầy đủ, SSO, mở rộng toàn group.

## Gần đây
- 2026-10-17: Áp dụng project-kit vào DevFlow; chuyển docs vào `openspec/kb/`; ghi D1–D8 thành ADR 0003–0009.
- 2026-10-17: Hoàn tất P0: clone Paperclip (MIT) và Plane (AGPL, đặt ở `../_ref/plane`), viết kiến trúc, gap analysis, data model đề xuất, kế hoạch P1.
