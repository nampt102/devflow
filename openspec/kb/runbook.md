# Runbook vận hành pilot P1

Cho người chạy pilot (D7: chủ dự án tự chọn công ty và tự chạy test). Mọi lệnh chạy ở thư mục gốc repo trừ khi ghi khác. Chi tiết từng phần: `triage-agent.md`, `triage-review.md`, `triage-metrics.md`, `email-notifications.md`, `admin-accounts.md`, `intake-portal-web.md`.

## 1. Chạy và dừng
- Build image từ git (LF) rồi chạy: `git archive HEAD | docker build -t devflow-paperclip:local -f Dockerfile -` rồi `cd docker && docker compose -f docker-compose.yml -f docker-compose.devflow.yml up -d`. Migration tự áp dụng khi server khởi động. Chi tiết và lỗi hay gặp: `tech-stack.md`.
- Dừng: `docker compose -f docker-compose.yml -f docker-compose.devflow.yml stop`. Dữ liệu nằm trong volume của `docker-db-1`.
- Kiểm tra sống: `curl http://localhost:3100/api/health` (`databaseBackup.status` nên là `ok`).
- **Bật Pipelines** (một lần cho mỗi instance, không có công tắc trong UI): `PATCH /api/instance/settings/experimental` với `{"enablePipelines": true}` bằng tài khoản admin instance. Seed pipeline: `node scripts/devflow/setup-dev-request-pipeline.mjs --company <id> --verify`.

## 2. Cấu hình (`docker/.env`, mẫu `docker/.env.example`; không đưa bí mật vào repo)
| Nhóm | Biến | Ghi chú |
|---|---|---|
| Triage | `DEVFLOW_LLM_BASE_URL`, `_MODEL`, `_API_KEY`, `_RESPONSE_FORMAT`, `_EXTRA_BODY`, `_TEMPERATURE`, `_MAX_OUTPUT_TOKENS`, `_TIMEOUT_MS` | Thiếu BASE_URL hoặc MODEL thì worker không chạy. Claude qua endpoint tương thích OpenAI: `RESPONSE_FORMAT=none`, không đặt temperature. |
| Embedding | `DEVFLOW_EMBED_BASE_URL`, `_MODEL`, `_API_KEY` | Thiếu thì dedupe chỉ dùng trigram. |
| Email | `DEVFLOW_SMTP_HOST/PORT/SECURE/USER/PASS/FROM`, `DEVFLOW_PORTAL_BASE_URL` | Thiếu HOST hoặc FROM thì không gửi email. |
| Giới hạn | `DEVFLOW_TRIAGE_MAX_TOKENS_PER_DAY` | Mỗi công ty, theo ngày UTC, tính Triage + embedding. Compose mặc định 500000; `0` là không giới hạn. |
| BA Spec | `DEVFLOW_BA_MODEL`, `DEVFLOW_BA_MAX_USD_PER_RUN`, `DEVFLOW_BA_MAX_USD_PER_DAY`, `DEVFLOW_BA_INTERVAL_MS`, `DEVFLOW_AGENT_WORKSPACE_ROOT`, `DEVFLOW_BA_ENABLED` | Mặc định haiku, 1 USD mỗi lượt, 20 USD mỗi ngày mỗi công ty (0 = không trần). Cần agent BA mỗi công ty: `node scripts/devflow/setup-ba-agent.mjs --company <id>` (đặt `DEVFLOW_AGENT_ANTHROPIC_API_KEY`, chạy lại sau mỗi lần đổi prompt BA). Xem `kb/ba-spec.md`. |
| Tech Plan | `DEVFLOW_PLAN_MODEL`, `DEVFLOW_PLAN_MAX_USD_PER_RUN`, `DEVFLOW_PLAN_MAX_USD_PER_DAY`, `DEVFLOW_PLAN_INTERVAL_MS`, `DEVFLOW_PLAN_ENABLED` | Mặc định sonnet, 2 USD mỗi lượt, 20 USD mỗi ngày mỗi công ty (tách khỏi BA). Cần agent Planner mỗi công ty: `node scripts/devflow/setup-plan-agent.mjs --company <id>` (dùng lại key của BA). Khi thêm hoặc đổi stage agent, chạy lại script setup của **mọi** agent (luật chặn chéo đổi). Xem `kb/tech-plan.md`. |
| Công tắc dừng | `DEVFLOW_WORKERS_ENABLED=false` | Dừng Triage, embedding, BA, Tech Plan và email cùng lúc (đặt rồi `up -d` lại). Portal và màn hình duyệt vẫn chạy. |
| Telemetry | `PAPERCLIP_TELEMETRY_DISABLED` | Compose đặt mặc định `1` (tắt). Xem mục 7. |
| Đăng ký | `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | Xem mục 8. |
Sau khi đổi `.env`: `docker compose -f docker-compose.yml -f docker-compose.devflow.yml up -d` để tạo lại container.

## 3. Kiểm tra nhanh sau khi chạy (hướng dẫn chạy cho D7)
`node --env-file=docker/.env scripts/devflow/smoke-p1.mjs --wait 180` (cần `DEVFLOW_TEST_ADMIN_*` là nhân viên và `DEVFLOW_TEST_PORTAL_*` là requester của cùng công ty). Script gửi một yêu cầu "Smoke test", chờ Triage đề xuất, duyệt với một chỉnh sửa, và kiểm tra: requester không đọc được API nhân viên, đề xuất không lộ ra portal, trạng thái requester đổi đúng, quyết định thứ hai bị từ chối, số liệu tăng. In PASS/FAIL từng bước; thoát mã 1 nếu có FAIL. **Tạo yêu cầu thật** nên chạy trên công ty thử. Đã chạy thành công trên stack Docker ngày 2026-10-18 (17/17).

### Bật email lần đầu trên instance đã có dữ liệu (đã gặp 2026-10-18)
Worker email gửi thư cho mọi sự kiện đổi trạng thái trong `DEVFLOW_EMAIL_MAX_AGE_HOURS` giờ gần nhất (mặc định 24). Khi bật SMTP trên instance có dữ liệu thử, các yêu cầu cũ của tài khoản test sẽ bị gửi thư thật, và nếu tài khoản test dùng địa chỉ giả (`@devflow.test`) Gmail vẫn nhận gửi rồi trả thư báo lỗi về hộp thư của tài khoản SMTP. Lần bật đầu tiên đã gửi 10 thư như vậy tới địa chỉ giả. Cách tránh: trước khi bật, đổi email các tài khoản test sang địa chỉ thật của bạn, và đặt `DEVFLOW_EMAIL_MAX_AGE_HOURS=1` cho lần khởi động đầu (hoặc đánh dấu bỏ qua các dòng `dr_email_outbox` đang `pending` bằng `update dr_email_outbox set status='skipped', last_error='cutover' where status='pending'` ngay sau khi khởi động, trước khi sweep gửi).

## 4. Theo dõi hằng ngày
- Màn hình **Triage review** → mục "Quality": hàng chờ, tỷ lệ override, thời gian, "Agent problems" và danh sách lỗi gần đây (mã REQ + loại lỗi).
- Truy vấn nhanh (trong `docker exec docker-db-1 psql -U paperclip -d paperclip`):
  - đề xuất chờ duyệt: `select count(*) from dr_agent_outputs where status='proposed';`
  - lỗi 24 giờ: `select action, details->>'kind', count(*) from activity_log where created_at > now() - interval '1 day' and action in ('agent.triage_failed','agent.triage_gave_up','agent.embed_failed','email.failed','agent.triage_budget_paused') group by 1,2;`
  - hàng đợi email: `select status, count(*) from dr_email_outbox group by 1;`
  - token hôm nay: `select billing_code, sum(input_tokens), sum(output_tokens) from cost_events where occurred_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' and billing_code like 'devflow:%' group by 1;`
- Log server: `docker logs docker-server-1 2>&1 | grep -i devflow`.

## 5. Xử lý sự cố
| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Yêu cầu nằm ở "Đã tiếp nhận", không có đề xuất | worker tắt (thiếu `DEVFLOW_LLM_*`, hoặc `DEVFLOW_WORKERS_ENABLED=false`), đạt trần token, circuit breaker mở, hoặc case bị bỏ cuộc | Xem log ("worker started", "daily token cap", "circuit breaker"). Bỏ cuộc và breaker nằm trong bộ nhớ: **khởi động lại server** để thử lại. |
| `agent.triage_failed` kind `client_error` | model từ chối tham số (ví dụ `temperature`) hoặc key/model sai | Chạy thử endpoint từ trong container, đọc thông báo lỗi; chỉnh `.env`. |
| kind `truncated` | câu trả lời của model dài hơn `DEVFLOW_LLM_MAX_OUTPUT_TOKENS` (mặc định 4000; 1500 đã gây lỗi này với tiếng Việt) | Tăng giá trị trong `.env` rồi `up -d`; xem thêm model có đang "suy nghĩ" dài không. |
| kind `invalid_output` | model trả JSON sai schema hai lần | Xem model/`RESPONSE_FORMAT`; với Qwen đặt `DEVFLOW_LLM_EXTRA_BODY` tắt thinking. |
| kind `rate_limited`, `timeout`, `server_error` | nhà cung cấp quá tải | Worker tự lùi và thử lại; kiểm tra hạn mức của nhà cung cấp. |
| `agent.triage_budget_paused` | đạt trần token ngày | Tự mở lại lúc 0h UTC; hoặc tăng `DEVFLOW_TRIAGE_MAX_TOKENS_PER_DAY` rồi `up -d`. |
| `agent.embed_failed` | key/endpoint embedding sai | Dedupe vẫn chạy bằng trigram; sửa key rồi worker backfill vector dần. |
| `email.failed` hoặc `dr_email_outbox.status='failed'` | SMTP sai (Gmail cần mật khẩu ứng dụng), người nhận bị từ chối | Xem `last_error` (chỉ loại lỗi). Sửa SMTP; các dòng `failed` không tự gửi lại. |
| Trang `/triage` quay về Dashboard | cờ `enablePipelines` tắt | Mục 1. |
| Duyệt báo "Already handled" | người khác đã quyết định hoặc đề xuất đã đổi | Tải lại hàng chờ. |
Dừng khẩn cấp phần agent: đặt `DEVFLOW_WORKERS_ENABLED=false` và `up -d`.

## 6. Sao lưu và khôi phục
- **Sao lưu tự động của Paperclip (đã xác nhận 2026-10-18):** bật mặc định, mỗi 60 phút, giữ 7 ngày; thư mục `/paperclip/instances/default/data/backups` trong container (volume `docker_paperclip-data`), tệp `paperclip-YYYYMMDD-HHMMSS.sql.gz` (SQL thuần, khoảng 0,4 đến 0,6 MB hiện tại). Chỉnh bằng `PAPERCLIP_DB_BACKUP_ENABLED`, `_INTERVAL_MINUTES`, `_RETENTION_DAYS`, `_DIR`. **Đã thử khôi phục bản mới nhất** vào DB trống bằng `gunzip -c file | psql`: 0 lỗi, số dòng khớp ở các bảng `dr_*`, `pipeline_cases`, `activity_log`. Lưu ý: bản sao nằm **cùng volume Docker và cùng ổ đĩa** với dữ liệu thật, nên chưa bảo vệ khi mất máy hoặc ổ đĩa; cần sao chép ra ngoài máy định kỳ. Khi Docker tắt thì không có bản sao (có khoảng trống giờ trong thư mục).
- Sao lưu thủ công: `docker exec docker-db-1 pg_dump -U paperclip -Fc -f /tmp/devflow.dump paperclip` rồi `docker cp docker-db-1:/tmp/devflow.dump .`.
- **Đã diễn tập khôi phục (2026-10-18):** dump (1,7 MB) → `pg_restore` vào DB mới trong cùng server pgvector → số dòng giống hệt ở các bảng `dr_requests` (21), `dr_requesters`, `dr_attachments`, `dr_agent_outputs`, `dr_overrides`, `dr_embeddings` (21, extension `vector` có), `dr_email_outbox`, `dr_requester_invites`, `pipeline_cases` (27), `pipeline_case_events`, `cost_events`, `activity_log`; số migration giống (357). Quy trình: `create database restore_check`; `pg_restore -d restore_check --no-owner file.dump`; so số dòng; `drop database restore_check`. Chưa diễn tập khôi phục lên máy khác hoặc khôi phục tệp đính kèm (nằm ngoài DB, trong thư mục lưu trữ của server).
- Tệp đính kèm nằm ở `/paperclip/instances/default/data/storage/<companyId>/…`, **cùng volume `docker_paperclip-data`** với thư mục sao lưu DB. Sao lưu volume này (và volume `docker_pgdata` nếu muốn sao chép DB thô) ra ngoài máy; bản dump `.sql.gz` không chứa tệp đính kèm.

## 7. Telemetry của Paperclip
Mặc định bật và gửi về endpoint của Paperclip. Tắt bằng `PAPERCLIP_TELEMETRY_DISABLED=1` (hoặc `DO_NOT_TRACK=1`), đã đọc trong `packages/shared/src/telemetry/config.ts`. Compose override của DevFlow đặt mặc định tắt. Chưa quan sát lưu lượng ra ngoài thực tế để xác nhận.

## 8. Đóng đăng ký công khai
Đăng ký công khai đang **mở** theo mặc định (ADR 0012). Khi mở, người lạ tạo được tài khoản nhưng không có quyền gì. Thứ tự đúng để đóng (đã kiểm chứng 2026-10-18 trên một instance thử với DB trống):
1. **Bootstrap admin đầu tiên khi đăng ký còn mở** (đăng ký rồi claim instance). Trên instance mới với `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, đăng ký bị từ chối (`400 EMAIL_PASSWORD_SIGN_UP_DISABLED`) và nhận lời mời bootstrap đòi người dùng đã đăng nhập, nên **không có cách nào tạo admin đầu tiên qua HTTP**.
2. Sau khi đã có admin, đặt `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` và `up -d`.
3. Nhân viên mới: admin gọi `POST /api/admin/users` (kèm `companyIds`, mật khẩu trả một lần). Người đã có tài khoản vẫn đăng nhập bình thường. Requester vào qua link mời (đăng ký theo lời mời vẫn chạy khi đã đóng, xem `admin-accounts.md`).


## 9. Chính sách dữ liệu
Triage gửi nội dung yêu cầu (tiêu đề, mô tả, tác động, tên tệp, đoạn mô tả của yêu cầu tương tự) tới nhà cung cấp LLM và embedding đã cấu hình. **Pilot với dữ liệu thật nên dùng vLLM và embedding chạy local**; API ngoài (Anthropic, OpenAI, Google) chỉ dùng với dữ liệu mẫu hoặc khi chủ dự án chấp thuận chính sách dữ liệu. Không gửi nội dung tệp đính kèm, không gửi email hay tên người gửi tới model. Nhân viên thấy tên (không email) của requester trong màn hình duyệt.

## 10. Xoay khóa và bí mật
Key LLM/embedding/SMTP chỉ nằm trong `docker/.env` (gitignore). Đổi key: sửa `.env` rồi `up -d`. `BETTER_AUTH_SECRET` đổi sẽ làm mất hiệu lực phiên đăng nhập. Mật khẩu tài khoản do admin tạo chỉ hiện một lần; reset bằng API (`admin-accounts.md`).

## 11. Quét bí mật (2026-10-18)
Quét 30 commit của DevFlow (từ `935c17b6e`) và cây tệp: không có giá trị nào trong `docker/.env` xuất hiện trong commit hay tệp được theo dõi; không có khóa dạng Anthropic, OpenAI, Google, GitHub, Slack, AWS hay khối private key trong commit của DevFlow. Các mẫu khớp trong cây tệp đều là dữ liệu giả trong test kế thừa từ Paperclip. Một cảnh báo là biến `password` trong `admin-accounts.ts` (không phải giá trị cố định). Kho `nampt102/devflow` **công khai**: không đẩy `docker/.env`, không dán key vào issue hay PR. Chưa quét lịch sử upstream của Paperclip (không phải của DevFlow).

## 12. Danh sách kiểm tra trước pilot
- [x] Chọn công ty pilot (2026-10-19): **RESKI** (`bef2beba-1090-4d3f-a99c-6f932b9066ea`, tiền tố `RES`), pipeline `dev-request` đã seed (`--verify` 8/8; bước verify để lại một case thử `verify …` trong công ty), có requester thử. Còn: tạo tài khoản nhân viên thật.
- [x] P2 (2026-10-19): hệ thống `reski` (repo riêng `MotivesSystem/reski_membership`, docs `knowledge-base`, token chỉ đọc), agent BA đã tạo, REQ-1 ra spec thật (xem `ba-spec.md`). Còn: duyệt spec ở trang BA review. Người duyệt phải đăng nhập GitHub có quyền đọc repo thì link trích dẫn mới mở được (repo riêng trả 404).
- [ ] Chọn nhà cung cấp LLM theo chính sách dữ liệu (mục 9); đặt `DEVFLOW_LLM_*`, thử bằng `smoke-p1.mjs`.
- [x] Gmail: đã đặt `DEVFLOW_SMTP_*` và gửi thật thành công (2026-10-18, xem `email-notifications.md`); còn xác nhận người nhận thấy thư trong hộp thư.
- [ ] Cung cấp ~20 yêu cầu mẫu thật và vài cặp trùng để hiệu chỉnh ngưỡng dedupe (0.3 trigram, 0.65 vector); xác nhận định nghĩa ưu tiên và độ khó (prompt v4 thay bản TEMPORARY).
- [x] Sao lưu tự động đã xác nhận (mục 6); còn làm: sao chép bản sao và tệp đính kèm ra ngoài máy.
- [x] Luồng bootstrap khi đóng đăng ký đã kiểm (mục 8: phải bootstrap trước, rồi mới đóng); còn quyết định thời điểm đóng.
- [ ] Xem xét AGPL (ADR 0002) trước khi triển khai ngoài thử nghiệm.

## 13. Vai trò người duyệt BA / Tech Lead (ADR 0023)
Ai được duyệt ở Triage review, BA review (cần `ba` hoặc `tech_lead`) và Plan review (cần `tech_lead`). Owner của công ty và instance admin luôn duyệt được. Một người có thể giữ cả hai vai.
- **Thứ tự triển khai (quan trọng):** build image và khởi động (migration `0360` tự áp) → **gán vai trước** → rồi mới đổi `approver` của pipeline. Quên bước gán thì chỉ owner duyệt được, không ai bị khóa vĩnh viễn.
- **Gán vai:** trang `/roles` ("Roles" ở sidebar; chỉ owner hoặc instance admin tick được, nhân viên khác chỉ xem), hoặc `node scripts/devflow/set-member-roles.mjs --company <id> --email <email> --roles ba,tech_lead` (danh sách thay thế vai cũ; `--roles none` để gỡ hết; `--list` để xem mọi người). Mỗi thay đổi ghi `activity_log` `devflow.roles_changed`.
- **Đổi approver của công ty đã seed:** `node scripts/devflow/setup-dev-request-pipeline.mjs --company <id>` (chỉ sửa trường `approver` của ba stage, chạy lại không đổi gì). Hoàn tác: thêm `--any-human`; bảng vai giữ nguyên.
- **Kiểm:** đăng nhập bằng tài khoản staff không có vai: trang duyệt hiện lý do và tắt nút, gọi API quyết định trả 403, case không đổi.
- Người rời công ty giữ dòng vai nhưng không duyệt được (mất quyền truy cập công ty); chưa tự dọn.

## 14. Agent Dev, runner và PR nháp (ADR 0024, `kb/dev-stage.md`)
Agent Dev viết code ở runner riêng và DevFlow mở PR nháp; không bao giờ merge. Mọi bước dưới đây làm **một lần cho instance**, trừ bước 3 đến 5 làm cho từng công ty và từng hệ thống.
1. **Mạng và CA:** build runner cần ra internet (apt, npm, `dot.net`). Mạng công ty ký lại TLS thì đặt CA gốc vào `docker/certs/*.pem` (như image server); gói `.deb` bị chặn qua http thì bỏ gói đó (vì thế image không có `python3-venv`).
2. **Dựng runner:** `node scripts/devflow/setup-dev-runner.mjs --company <id>` (cần `DEVFLOW_TEST_ADMIN_EMAIL/PASSWORD` là instance admin). Script sinh cặp khóa SSH ở `docker/runner/keys/` (gitignored; **sao lưu khóa riêng**, mất thì chạy lại để sinh khóa mới), build và bật `devflow-runner`, `devflow-proxy`, nối server vào `runner_net`, ghim host key, lưu khóa riêng thành secret công ty `devflow-runner-ssh-key`, tạo môi trường Paperclip `devflow-runner` và probe. Chạy lại an toàn. Squid đôi khi khởi động trước DNS của Docker: script tự khởi động lại proxy một lần và kiểm `api.github.com` đi được còn `example.com` bị chặn. Thêm host cho phép (kho gói của hệ thống mới) trong `docker/runner/squid.conf` rồi khởi động lại `devflow-proxy`.
3. **Tạo agent Dev cho công ty:** `node scripts/devflow/setup-dev-agent.mjs --company <id>` (dùng lại key Anthropic của BA, cần `DEVFLOW_AGENT_ANTHROPIC_API_KEY` lần đầu). Chạy lại sau mỗi lần nâng cấp đổi prompt Dev, hoặc khi worker báo `agent_prompt_outdated`, `agent_not_on_runner`, `agent_tools_changed`.
4. **Token ghi cho từng hệ thống:** trên GitHub tạo fine-grained token **chỉ cho repo đó**, quyền *Contents: read & write* và *Pull requests: read & write* (không cần quyền admin, không cần Workflows). **Thiếu quyền Pull requests là lỗi hay gặp** (thử thật 2026-10-22: token chỉ có Contents đẩy được nhánh nhưng không mở được PR). DevFlow kiểm trước khi chạy agent (đẩy được, đọc được PR, nhánh mặc định có bảo vệ) và dừng với `github_forbidden` nên không tốn tiền; kiểm tay: `curl -H "Authorization: Bearer <token>" https://api.github.com/repos/<owner>/<repo>/pulls?per_page=1` phải trả 200. Ở trang Systems → sửa hệ thống → mục "Dev agent": dán token ghi (hiện một lần, lưu thành secret công ty, không bao giờ hiện lại), nhập lệnh kiểm tra (ví dụ `cd backend && npm test`) và đường dẫn cấm thêm nếu cần, rồi bật công tắc. Hệ thống chỉ có token ghi thì dùng token đó để clone.
5. **Bảo vệ nhánh mặc định:** DevFlow chỉ đẩy khi nhánh mặc định có bảo vệ (đẩy `devflow/*` và mở PR nháp là việc duy nhất nó làm, nhưng bảo vệ nhánh là lưới an toàn cho người merge). Bật *Branch protection rule* hoặc *Ruleset* bắt buộc qua pull request. **Repo riêng trên gói GitHub miễn phí không bật được** (API trả "Upgrade to GitHub Pro"): nâng gói, chuyển repo vào tổ chức có gói trả phí, hoặc để **owner của công ty** tick "Allow when the default branch is not protected" ở trang Systems (PR nháp sẽ ghi cảnh báo; chỉ merge sau khi có người duyệt).
6. **Vai và approver:** gán vai `tech_lead` cho người duyệt code (mục 13, trang `/roles`), rồi chạy lại `setup-dev-request-pipeline.mjs --company <id>` để `code_review` đòi vai đó. Trước khi gán vai, chỉ owner duyệt được.
7. **Bật và theo dõi:** worker Dev bật mặc định (`DEVFLOW_DEV_ENABLED=false` để tắt); trần `DEVFLOW_DEV_MAX_USD_PER_DAY` (50), mỗi lượt 5 USD. Sau khi duyệt kế hoạch, yêu cầu ở `dev` được lấy trong vài chục giây; một lượt có thể tới 60 phút và **giữ khóa chung nên BA và Tech Plan của cả instance chờ**. Trang `/code-review` có "Recent problems" (kind lỗi ở `kb/dev-stage.md`).
- **Kiểm nhanh runner:** `docker exec docker-devflow-runner-1 sh -c 'getent hosts db'` phải không tìm thấy; `curl -x http://devflow-proxy:3128 https://example.com` từ runner phải bị từ chối. Nhánh `devflow/*` và PR của agent nằm ở GitHub, xóa tay được; reject đóng PR nhưng giữ nhánh.
- **Xoay khóa SSH:** xóa `docker/runner/keys/runner_key*`, chạy lại `setup-dev-runner.mjs` (khóa mới, secret được xoay). **Xoay token ghi:** dán token mới ở trang Systems; thu hồi token cũ trên GitHub.
- **Dữ liệu:** agent Dev gửi mã nguồn và tài liệu của repo sang API Claude; áp dụng cùng chính sách dữ liệu ở mục 9. Toolchain trong image: Node, Python, .NET 8 và 10; **Flutter chưa có** (thêm vào `docker/runner/Dockerfile` trước khi bật Dev cho RESKI).
