# Trạng thái dự án

> Đọc file này đầu tiên mỗi phiên. Cập nhật cuối mỗi bước/phiên. Lịch sử chi tiết ở `changes/archive/` và git log.

**Cập nhật lần cuối:** 2026-10-19

## Phase hiện tại
**P1**: Intake Portal + Workflow Core + Triage agent, pilot 1 công ty. P0 (khám phá Paperclip/Plane, docs, khung project-kit) đã xong.

## Bước đang làm
Các bước 0–10 của P1 đã code, kiểm bằng test và chạy thử trên stack Docker thật (portal, Triage với Claude, dedupe, màn hình duyệt, số liệu, smoke `scripts/devflow/smoke-p1.mjs` 17/17). **Chưa có pilot thật**: còn các việc chuẩn bị ở `kb/runbook.md` mục 12. Change OpenSpec `add-intake-portal` đã archive ngày 2026-10-18 (`openspec/changes/archive/2026-10-18-add-intake-portal`, spec chính ở `openspec/specs/intake-portal`).

## Bước tiếp theo
1. Chuẩn bị pilot theo danh sách kiểm tra `kb/runbook.md` mục 12: chọn công ty, SMTP Gmail (mật khẩu ứng dụng) và gửi thử một email thật, LLM theo chính sách dữ liệu (local cho dữ liệu thật), ~20 yêu cầu mẫu thật và vài cặp trùng để hiệu chỉnh ngưỡng dedupe, xác nhận sao lưu tự động.
2. Quyết định của chủ dự án: định nghĩa ưu tiên và độ khó của công ty (prompt v4 thay bản TEMPORARY); có bật `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` không (và kiểm thử luồng bootstrap); có cần màn hình quản trị tài khoản và màn hình tạo link mời cho nhân viên không.
3. P2 (BA Spec + Planner agent, các gate còn lại, email mở rộng): đang brainstorm. Đã chốt hướng ở ADR 0020 (adapter của Paperclip, repo GitHub, docs markdown trong `docs/`, danh mục Hệ thống gán ở Triage review). Spike `claude_local` vòng 1 và 2 xong (`kb/spike-p2-adapter.md`): chạy được, đầu ra JSON ổn, stage tự tạo issue và chạy agent; còn quyết định bubblewrap/seccomp và cách đóng vòng issue, rồi change proposal P2. Role BA/Tech Lead cho approver là bản vá chờ làm.

## Backlog cải tiến
Các vấn đề nhỏ và cải tiến chưa làm nằm ở `openspec/backlog.md` (mã số, nguồn, mức ưu tiên A/B/C). Chủ dự án báo trong chat, Claude ghi vào đó.

## Việc bị chặn / chờ quyết định
- Còn thiếu cho pilot: xác nhận người nhận thấy thư (SMTP đã gửi thật); vLLM local (đã chạy thử bằng API Claude và OpenAI embedding, chưa với vLLM/TEI).
- Telemetry của Paperclip: **đã chốt tắt** trong cấu hình Docker (`PAPERCLIP_TELEMETRY_DISABLED=1`, ADR 0019); chưa quan sát lưu lượng ra ngoài thực tế.
- Triage chạy thật bằng worker nội bộ (không qua adapter của Paperclip); các agent adapter (BA, Dev, QA) chưa thử ở runtime vì thuộc P2 trở đi.
- Model embedding: đang thử `text-embedding-3-small` (OpenAI); bge-m3 qua TEI là lựa chọn local, chưa thử. Số chiều không chặn vì `dr_embeddings` không cố định số chiều (chỉ mục HNSW tạo riêng sau khi chọn model, ADR 0013).

## Bảng tiến độ P1

| # | Bước | Trạng thái | Change / PR | Ghi chú |
|---|---|---|---|---|
| 0 | Dựng môi trường Docker (Postgres + pgvector), chạy Paperclip, bật `enablePipelines`, chạy tutorial | done: stack chạy trên Docker Desktop (server :3100, migrations OK, pgvector 0.8.7 có sẵn; extension chưa tạo) | | Chưa rõ Docker của repo hỗ trợ pgvector; có thể cần compose riêng |
| 1 | Spike Pipelines: approver theo role, quyền agent key, event field-level, request_changes, test hiện có | done: đọc code + smoke API thật (tạo công ty, pipeline 4 stage, case, transition, review approve → done đều 200) | | Pipelines đang experimental; kết quả chốt lại D1 |
| 2 | Seed pipeline `dev-request` (12 stage; P1 dùng `triage`, `triage_review`, `done`, `cancelled`) + test state machine/gate | done: định nghĩa JSON + 8 test (pass, đột biến bị bắt) + script seed/verify 7/7 pass trên stack thật | | |
| 3 | Migration #1: `dr_requests`, `dr_requesters`, `dr_attachments` (+ `dr_request_counters`) | done: `0355_devflow_requests.sql`, 11 test cách ly công ty pass trên Postgres nhúng; chưa áp dụng vào stack Docker | | Chủ dự án duyệt schema trước |
| 4 | Intake Portal tiếng Việt, tách khỏi board: đăng nhập requester, form, upload, trạng thái ticket | done (change `add-intake-portal`, gồm task 3.5): API, tệp, lời mời, web `portal/`; smoke trên Docker và trình duyệt pass | `add-intake-portal` | Chưa có màn hình nhân viên tạo link; đăng ký công khai vẫn mở (ADR 0012) |
| 5 | Migration #2 (`0357_devflow_agent_outputs`): `dr_agent_outputs`, `dr_overrides`, `dr_embeddings` (tạo có điều kiện khi có pgvector); bỏ `dr_prompts` (prompt là file có version) | done: 47 test trên Postgres nhúng và 5 test trên pgvector thật pass; 6 đột biến bị bắt; ADR 0013 | | Đã áp dụng vào stack Docker qua server khởi động (extension vector 0.8.7 được tạo, 3 bảng có mặt) |
| 6 | Triage agent: prompt v1 có version, output JSON (Zod) + comment; provider API/local theo config | phần không phụ thuộc model done: client LLM, prompt v1 (hash ghim), schema strict, cờ quy tắc, worker (backoff, breaker, khóa advisory), agent idle để ghi chi phí; 44 test pass, 5 đột biến bị bắt; ADR 0014. **Chưa chạy với model thật** | | Cần endpoint/model; định nghĩa ưu tiên/độ khó là tạm thời; không dùng `pendingSuggestion` ở P1 |
| 7 | Dedupe bằng pgvector + LLM xếp hạng (embedding API/local theo config) | done (chưa chạy với model/embedding thật): trigram luôn bật + vector khi có cấu hình, prompt v2, backfill; 65 test pass (gồm pgvector thật), 6 đột biến bị bắt; ADR 0015 | | Ngưỡng 0.3/0.65 chưa hiệu chỉnh; đổi provider = re-index |
| 7b | Email requester khi đổi trạng thái (SMTP qua env) | done (chưa gửi thử qua SMTP thật): migration 0358 `dr_email_outbox`, worker xếp hàng + gửi bằng nodemailer, SMTP giả khi test; 18 test pass, 8 đột biến bị bắt; ADR 0016 | | Chủ dự án sẽ tạo SMTP Gmail (mật khẩu ứng dụng); chưa có giới hạn tần suất theo người nhận |
| 8 | Màn hình duyệt triage cho Lead/BA (hàng chờ, sửa field, approve/reject/request_changes, đánh dấu trùng), ghi override | done (đã kiểm thủ công trên trình duyệt với stack thật): API `/devflow/triage-*`, hook `beforeCommit` ở core (nguyên tử), prompt v3 (lý do request_changes), trang Board UI `triage`; 198 test server + 7 test UI pass, 8 đột biến bị bắt; ADR 0017 | | Chưa có role BA/Tech Lead, snooze, duyệt hàng loạt; UI tiếng Anh |
| 9 | Số liệu cơ bản: tỷ lệ override theo field, thời gian ở triage | done (đã xem trên stack thật với dữ liệu thử, chưa có dữ liệu pilot): `GET /devflow/triage-metrics` + mục "Quality" trong trang Triage review; không có migration; 8 test server + test UI pass, 7 đột biến bị bắt; ADR 0018 | | Mẫu nhỏ, chưa có độ tin cậy thống kê hay biểu đồ theo thời gian |
| 10 | Pilot hardening: log lỗi agent, ngân sách token, tài liệu vận hành | done (kiểm bằng test và smoke trên stack thật; chưa có pilot): trần token ngày mỗi công ty, công tắc `DEVFLOW_WORKERS_ENABLED`, Telemetry tắt mặc định, lỗi gần đây trong mục Quality, `smoke-p1.mjs` 17/17, runbook, quét bí mật sạch, diễn tập khôi phục DB; ADR 0019 | | Còn thiếu để pilot thật: SMTP Gmail, LLM theo chính sách dữ liệu, mẫu thật hiệu chỉnh ngưỡng, xác nhận sao lưu tự động, quyết định đóng đăng ký (xem `kb/runbook.md` mục 12) |

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
- 0010 Cách ly công ty bằng khóa ngoại kép (id, company_id)
- 0011 Intake Portal: link mời một lần, /api/portal/*, app portal/ riêng
- 0012 Đăng ký công khai mở cho đến khi có cách tạo tài khoản nhân viên
- 0013 Đầu ra agent, override, embedding: prompt dạng file, embedding tạo có điều kiện
- 0014 Triage agent: client LLM mỏng, worker quét định kỳ, không dùng pendingSuggestion ở P1
- 0015 Dedupe: trigram luôn bật, vector khi có cấu hình, prompt v2
- 0016 Email trạng thái: outbox theo sự kiện, nodemailer
- 0017 Màn hình duyệt triage: trang Board UI, quyết định nguyên tử qua hook của core
- 0018 Số liệu triage: tính từ dữ liệu có sẵn, tỷ lệ override trên đề xuất được duyệt
- 0019 Pilot hardening: Telemetry tắt, trần token ngày, công tắc dừng worker
- 0020 P2: BA Spec và Tech Plan qua adapter của Paperclip; repo và docs gán theo Hệ thống
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
6. Telemetry của Paperclip: đã tắt mặc định trong cấu hình Docker (ADR 0019); chưa quan sát lưu lượng thực tế.

## Lộ trình tổng
P1 (đang chuẩn bị) → P2 BA Spec + Planner agent, gate còn lại, email mở rộng → P3 Dev agent (worktree/PR), QA agent, dashboard → P4 Governance đầy đủ, SSO, mở rộng toàn group.

## Gần đây
- 2026-10-19: Spike P2 vòng 2: mặc định engine ACP bỏ qua `extraArgs` (cần `engine: cli`); `--max-budget-usd` hiệu lực với cli; chặn tool Write không đủ chỉ-đọc (agent vòng qua Bash); bubblewrap chỉ chạy khi `seccomp=unconfined` (chưa tích hợp, chờ quyết định); case vào `ba_spec` tự tạo issue và chạy agent, kết quả JSON nằm ở bình luận của agent trên issue; Paperclip đánh thức lại 2 lần (disposition repair) vì agent không đóng issue.
- 2026-10-19: Spike P2: agent `claude_local` chạy được trong image hiện tại, BA spec chất lượng tốt có trích dẫn file:dòng đúng (111 giây, ~1,3 USD với haiku); phát hiện: không có chế độ chỉ đọc mặc định (`--disallowedTools` không chặn được), cần token chỉ đọc + workspace dùng một lần + bubblewrap (chưa có trong image), đầu ra là markdown tự do, chưa gắn vào stage (`kb/spike-p2-adapter.md`).
- 2026-10-19: Brainstorm P2: chốt chạy BA/Tech Plan qua adapter của Paperclip (không dùng worker nội bộ), repo GitHub + docs markdown trong `docs/`, danh mục Hệ thống theo công ty gán ở Triage review (ADR 0020). Chưa code; spike adapter là bước tiếp theo.
- 2026-10-18: A-11 xong: trang Board UI "Portal access" (link mời requester, tạo tài khoản nhân viên và reset mật khẩu cho instance admin; bí mật hiện một lần), thêm `GET /api/admin/users?companyId=`; không đổi schema (`kb/admin-accounts.md`). Hết các việc backlog trước P2.
- 2026-10-18: Làm các mục backlog trước P2: B-01 (số đếm sidebar, nhãn New và sắp xếp, email nhân viên gom 5 phút tới `DEVFLOW_STAFF_NOTIFY_EMAILS` hoặc owner/admin), B-08 (agent Triage ghi rõ là nội bộ), B-22 (lần chạy email đầu bỏ qua lịch sử), A-13 (kiểm bootstrap khi đóng đăng ký: phải bootstrap trước rồi mới đóng), A-24 (sao lưu tự động xác nhận và khôi phục thử); 226 test server pass. Chờ: A-11 (màn hình mời và tài khoản, cần duyệt thiết kế); A-19 và A-25 được chủ dự án cho bỏ qua lúc này; A-14 (định nghĩa ưu tiên/độ khó) chờ nội dung từ chủ dự án.
- 2026-10-18: Portal làm lại giao diện (skill ui-ux-pro-max): token và phông giống Board, chuyển sáng/tối chung khóa `paperclip.theme`, form có kiểm tra khi rời ô, kéo thả tệp, khung xương khi tải, trạng thái rỗng; logic và API không đổi; 18 test portal pass, xem trên trình duyệt ở sáng, tối và 375px (`kb/intake-portal-web.md`).
- 2026-10-18: Bước 10 xong: trần token ngày mỗi công ty (`overBudgetCompanies`, worker bỏ qua công ty đã chạm trần), `DEVFLOW_WORKERS_ENABLED`, Telemetry tắt mặc định, `recentFailures` trong metrics và UI, `scripts/devflow/smoke-p1.mjs` (chạy 17/17 trên stack thật; lần đầu lộ ra việc duyệt phải gỡ dấu trùng khi agent đã nêu bản trùng), runbook, quét bí mật (sạch), diễn tập pg_dump/pg_restore (số dòng khớp); 14 test mới, 7 đột biến bị bắt (ADR 0019, `kb/runbook.md`). **P1 hoàn tất về mặt code**; còn các việc chuẩn bị pilot ở runbook mục 12.
- 2026-10-18: Bước 9 xong: `triage-review/metrics.ts` (tỷ lệ override theo field và phiên bản prompt, sửa đổi hay gặp, quyết định, trùng, p50/p90 thời gian, hàng chờ, lỗi agent và token), route `triage-metrics`, mục Quality ở trang Triage review; 8 test server pass, 7 đột biến bị bắt (ADR 0018, `kb/triage-metrics.md`).
- 2026-10-18: Bước 8 xong (đã duyệt thử REQ-8 trên trình duyệt thật: override, `dr_requests`, `ba_spec` đúng; cờ `enablePipelines` không có nút trong UI, bật bằng API, xem `kb/tech-stack.md`): `devflow/triage-review/` (hàng chờ, chi tiết, quyết định), vá `reviewCase` thêm `beforeCommit` (4 dòng), prompt v3, `ui/src/pages/TriageReview.tsx` + `lib/triage-review.ts`; 198 test server (gồm hồi quy `pipelines-*`) + 7 test UI pass, 8 đột biến bị bắt (ADR 0017, `kb/triage-review.md`).
- 2026-10-17: Bước 7b xong: migration 0358 `dr_email_outbox`, `devflow/email/` (mailer nodemailer, soạn thư tiếng Việt, worker xếp hàng + gửi với backoff, SMTP giả), dependency `nodemailer@10.1.2` (lockfile +19 dòng); 18 test (12 server + 6 db) pass, 8 đột biến bị bắt. Chưa thử Gmail thật; image Docker chưa build lại (ADR 0016, `kb/email-notifications.md`).
- 2026-10-17: Chạy thật Triage với claude-haiku-5-5 (20 yêu cầu mẫu tổng hợp): 21/21 đề xuất hợp lệ, dedupe trigram bắt đúng 3 cặp trùng, 3 mẫu injection bị bỏ qua. Lỗi tìm được và sửa: model từ chối `temperature` (nay tùy chọn), quy tắc cờ nhầm "sập"/SAP, "lượng"/"lương". Chi tiết cuối `kb/triage-agent.md`. Image chạy hiện tại chưa có bản sửa quy tắc cờ (cần build lại).
- 2026-10-17: Bước 7 xong: `dedupe.ts` (pg_trgm bỏ dấu + pgvector có điều kiện), `embed-client.ts`, prompt v2, backfill embedding trong worker, `DEVFLOW_LLM_EXTRA_BODY` + cắt `<think>` cho Qwen3/vLLM; 65 test pass (kể cả trên pgvector thật), 6 đột biến bị bắt. Chưa chạy với vLLM/TEI thật; chưa build lại image Docker (ADR 0015, `kb/triage-agent.md`).
- 2026-10-17: Bước 6 (phần không phụ thuộc model) xong: `server/src/devflow/prompts/triage.v1.ts`, `devflow/triage/` (schema Zod strict, quy tắc cờ, client, LLM giả, service, worker), 44 test (25 đơn vị + 19 trên Postgres nhúng) pass, 5 đột biến bị bắt. Phát hiện khi làm: unique index một `proposed` mỗi stage là cơ chế chống đua (supersede trong giao dịch sẽ làm mất cả hai output khi hai worker chạy song song). Agent idle xác nhận bằng đọc code, chưa chạy scheduler thật. Chưa chạy với model thật; chưa build lại image Docker (ADR 0014, `kb/triage-agent.md`).
- 2026-10-17: Bước 5 xong: migration 0357 (`dr_agent_outputs`, `dr_overrides`, `dr_embeddings`); Postgres nhúng không có pgvector nên embeddings tạo trong khối `DO` có điều kiện; bỏ `dr_prompts`; kiểm chứng trên Postgres nhúng (migration áp dụng sạch khi không có pgvector) và trên DB pgvector thật; 6 đột biến bị bắt (ADR 0013).
- 2026-10-17: Đọc sâu repo tham khảo Autonomous-Company (MIT, chỉ lấy ý tưởng): ghi chú ở `kb/ref-autonomous-company.md`. Đáng áp dụng nhất cho bước 6: khung prompt có cấu trúc kèm bước tự phản biện, coi nội dung yêu cầu là dữ liệu không tin cậy, LLM giả để test agent; không áp dụng triết lý tự trị.
- 2026-10-17: Task 3.5 xong (phương án X): `POST /api/admin/users` và `reset-password` cho instance admin (mật khẩu sinh một lần, reset xóa phiên); 8 test mới, 8 đột biến bị bắt; kiểm chứng HTTP trên stack thật khi đóng đăng ký: 15/15 pass (đăng ký công khai bị từ chối, admin tạo nhân viên có quyền board, reset, requester đăng ký qua lời mời); đã trả stack về trạng thái mở. Lưu ý: giới hạn đăng nhập có sẵn của better-auth làm kịch bản kiểm chứng gặp 429.
- 2026-10-17: Kiểm tra task 3.4 trên trình duyệt thật: tìm ra lỗi "đăng ký xong vẫn báo link đã dùng", sửa bằng accept idempotent cho đúng người dùng link (30 test server pass, đột biến bị bắt), kiểm tra lại: đăng ký mới, email có sẵn, mở lại link, cách ly giữa user đều đúng.
- 2026-10-17: Task 3.4 xong (phương án A, ADR 0012): `POST /api/portal/invites/:token/register` tạo tài khoản + requester trong một giao dịch, 409 khi email có sẵn, giới hạn 10 lần/phút/IP; 9 test mới và 6 đột biến bị bắt; giao diện nhận lời mời tạo tài khoản qua endpoint này; đăng ký công khai vẫn mở.
- 2026-10-17: Portal nhóm 4 xong: package `portal/` (React+Vite, tiếng Việt), phục vụ ở `/portal`, lockfile chỉ thêm một khối importer; image build lại, migration 0355/0356 áp dụng vào DB thật; luồng mời → đăng ký → gửi yêu cầu kèm tệp chạy trong trình duyệt; 36 test server + 12 test portal pass. Xem `kb/intake-portal-web.md`.
- 2026-10-17: Portal nhóm 3 xong: migration 0356 `dr_requester_invites` (bỏ `accepted_requester_id`/CHECK so với DDL trình duyệt vì xung đột với xóa user), API mời/thu hồi/nhận link, 7 test + 4 test đăng ký đóng; đăng ký đóng vẫn tạo được tài khoản qua server (task 3.4 đề xuất).
- 2026-10-17: Portal nhóm 2 xong: upload file (multipart, tối đa 5 file, 10 MB, ảnh/PDF/Office/txt/csv, kiểm tra nội dung khớp loại, chỉ chủ sở hữu tải được); 13 test pass, đột biến bị bắt.
- 2026-10-17: Áp dụng project-kit vào DevFlow; chuyển docs vào `openspec/kb/`; ghi D1–D8 thành ADR 0003–0009.
- 2026-10-17: Hoàn tất P0: clone Paperclip (MIT) và Plane (AGPL, đặt ở `../_ref/plane`), viết kiến trúc, gap analysis, data model đề xuất, kế hoạch P1.
