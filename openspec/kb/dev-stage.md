# Dev stage (P3, change `add-dev-stage`)

Trạng thái: code + test xong (2026-10-22); **chưa chạy thật cả luồng** (smoke 5.1 chờ: cần hệ thống thử có token ghi và agent chạy thật). Quyết định: `decisions/0024-dev-stage-runner.md`. Kết quả spike: `kb/spike-p3-runner.md`. Chung khung với BA và Tech Plan: `kb/tech-plan.md`.

## Luồng
Plan review approve → stage `dev` → worker Dev, với từng hệ thống đã gán có **Dev bật** và có task trong kế hoạch: dựng workspace trên server (clone đầy đủ, nhánh `devflow/<mã yêu cầu>` mới hoặc lấy lại từ GitHub) → agent "DevFlow Dev" chạy ở runner qua SSH (Paperclip đóng gói workspace sang, ghi commit về) → báo cáo JSON → DevFlow kiểm diff, kiểm bảo vệ nhánh, đẩy nhánh, mở hoặc cập nhật **PR nháp** → đề xuất (`dr_agent_outputs`, stage `dev`) → stage `code_review` → người có vai `tech_lead` duyệt: approve → `qa` (chưa có agent QA), request_changes → `dev` (làm tiếp trên cùng nhánh, PR cũ được cập nhật), reject → `cancelled` và đóng PR. DevFlow không merge.

## Thành phần
- **Runner** (`docker/runner/`, `docker/docker-compose.runner.yml`): image `devflow-runner:local` (Node 24, Python 3 không có `python3-venv`, .NET SDK 8 và 10, git, Claude Code), sshd chỉ nhận khóa của DevFlow, host key trên volume, mạng `runner_net` (internal) + proxy Squid (`devflow-proxy`, `squid.conf`: Anthropic, GitHub, npm, PyPI, NuGet, pub.dev). Cache gói ở volume `runner_nuget`, `runner_npm`. Chưa có Flutter.
- **Hệ thống** (`dr_systems`, migration `0361`): `dev_enabled`, `write_token_secret_id`, `test_command`, `forbidden_paths`, `allow_unprotected`. API `PATCH …/devflow/systems/:id` (token ghi không bao giờ trả lại; `allowUnprotected` chỉ owner/admin; bật Dev không có token ghi → 422). Trang Systems có mục "Dev agent".
- **Agent** (`dev/agent.ts`, `prompts/dev.v1.ts`): `claude_local`, `engine: cli`, tool `Read,Grep,Glob,Edit,Write,Bash`, `--max-budget-usd` (5), 200 lượt, 60 phút, tác giả commit qua `GIT_CONFIG_*` (không dùng `GIT_AUTHOR_*`: Paperclip từ chối khóa có "auth"). **Kiểm trước mỗi lượt** (`unsafeDevAgentReason`): môi trường phải là SSH `devflow-runner` với host key ghim và đúng đường dẫn (`agent_not_on_runner`, `runner_environment_invalid`, `runner_host_key_not_pinned`), đúng tool (`agent_tools_changed`), có ngân sách, hướng dẫn gắn, prompt đúng hash. Tạo bằng `scripts/devflow/setup-dev-agent.mjs` (cấu hình chuẩn từ `GET …/devflow/dev-agent`).
- **Workspace** (`dev/workspace.ts`): `/paperclip/devflow/ws/dev` là repo neo (một commit rỗng, `.devflow/` và `.paperclip-repositories/` trong `.git/info/exclude`); repo hệ thống ở `.paperclip-repositories/<key>/`; `.devflow/request.md` có yêu cầu, spec BA và kế hoạch đã duyệt (chỉ task của hệ thống đó), phản hồi của người duyệt. Dọn trước và sau mỗi lượt.
- **Kiểm diff** (`dev/diff-check.ts`): chỉ đọc `git diff <base>..HEAD`: HEAD đúng nhánh, `base` là tổ tiên (không viết lại lịch sử), đường dẫn cấm mặc định (`.github/workflows/**`, `.github/actions/**`, `.circleci/**`, CI khác, `.env*`, `*.pem`, `*.key`, `*.pfx`, `id_rsa*`, `.gitmodules`) cộng đường dẫn cấm của hệ thống, không submodule, tổng dòng đổi ≤ 3000 (`DEVFLOW_DEV_MAX_DIFF_LINES`), nhị phân ≤ 1 MB. Vi phạm: **không đẩy gì**, đề xuất ghi lý do để người duyệt đọc.
- **GitHub** (`dev/github.ts`, `dev/publish.ts`): token ghi có quyền push, cờ `protected` của nhánh mặc định (hoặc `allow_unprotected` kèm cảnh báo trong PR), `git push HEAD:refs/heads/devflow/*` (token ở header của một tiến trình git, không force, không hook), PR nháp (nội dung agent được chèn ký tự rỗng sau `@` để không gọi tên ai), cập nhật + bình luận ở lượt sau, nhãn `devflow` (cố gắng, không bắt buộc).
- **Worker** (`dev/dev-service.ts`, `dev/start.ts`): dùng `stageService` (danh sách chờ, phản hồi, sổ `agent.dev_run`, trần ngày, ghi đề xuất) và `createStageWorker` (khóa chung `dr-agent-stage-worker`, backoff, bỏ cuộc sau 3 lần, breaker). Lấy token ghi **trước khi tốn tiền**. Báo cáo sai schema hoặc thiếu task: chạy lại một lần với lý do.
- **Code review** (`dev/review-service.ts`, `dev/routes.ts`, trang `/code-review`): `code-queue|code-count|code-metrics|code-cases/:id`, `POST …/decision` (không sửa nội dung). Chi tiết có PR, báo cáo, kết quả kiểm tra, task của kế hoạch đối chiếu với báo cáo, tiêu chí BA. **Approve bị từ chối (422)** khi không có PR hoặc có diff bị chặn. Reject đóng PR sau khi quyết định commit (không đóng được thì quyết định vẫn giữ, ghi `code.pr_close_failed` và trả `closedPullRequests` để người đóng tay). Pipeline: `code_review` approver `role: tech_lead`. Email nhân viên: thư riêng (`staff.notified_code`).

## Lỗi hay gặp (`activity_log` `agent.dev_failed`, mục "Recent problems" của trang)
| Kind | Ý nghĩa | Xử lý |
|---|---|---|
| `no_agent`, `agent_not_on_runner`, `runner_environment_invalid`, `runner_host_key_not_pinned`, `agent_tools_changed`, `agent_prompt_outdated` | Agent chưa tạo, sai nơi chạy, bị đổi, hoặc prompt cũ | Chạy `setup-dev-runner.mjs` rồi `setup-dev-agent.mjs` cho công ty. Thử lại chậm, không bỏ cuộc |
| `no_approved_plan`, `no_dev_system` | Chưa có kế hoạch đã duyệt, hoặc không hệ thống nào bật Dev có task | Bật Dev ở trang Systems, kiểm hệ thống đã gán ở Triage review |
| `system_missing_token` | Secret token đã bị xóa | Nhập lại token ghi ở trang Systems |
| `repo_unprotected` | Nhánh mặc định không có bảo vệ | Bật bảo vệ nhánh, hoặc owner bật `allow_unprotected` |
| `write_token_cannot_push`, `github_auth`, `github_forbidden` | Token ghi sai quyền, hết hạn, hoặc không thấy repo | Tạo lại token (quyền Contents và Pull requests: read & write) |
| `push_rejected`, `github_rejected`, `push_failed`, `github_error` | GitHub từ chối hoặc lỗi mạng | Thử lại tự động; kiểm nhánh `devflow/*` có bị người sửa tay không |
| `run_failed`, `run_timeout`, `wake_skipped`, `budget_exhausted`, `invalid_output` | Lượt chạy hỏng (đã tốn tiền) | Thử lại với backoff, bỏ cuộc sau 3 lần; xem transcript ở Paperclip |

Diff bị chặn (`forbidden_paths`, `diff_too_large`, `binary_too_large`, `submodule_change`, `wrong_branch`, `history_rewritten`) **không** là lỗi: thành đề xuất không có PR để người duyệt gửi lại hoặc reject.

## Biến môi trường
`DEVFLOW_DEV_ENABLED`, `DEVFLOW_DEV_MODEL` (`claude-sonnet-5-5`), `DEVFLOW_DEV_MAX_USD_PER_RUN` (5), `DEVFLOW_DEV_MAX_USD_PER_DAY` (50 trong compose; sổ `agent.dev_run`), `DEVFLOW_DEV_MAX_DIFF_LINES` (3000), `DEVFLOW_DEV_INTERVAL_MS` (30000); dùng chung `DEVFLOW_AGENT_WORKSPACE_ROOT`, `DEVFLOW_WORKERS_ENABLED`.

## Kiểm chứng
Test tự động (chạy trong container Linux vì có symlink): `devflow-dev-unit` (prompt ghim hash, schema, cấu hình và kiểm agent), `devflow-dev-workspace` (clone đầy đủ, nhánh làm tiếp, không remote), `devflow-dev-publish` (kiểm diff, GitHub giả, push vào kho git cục bộ, PR), `devflow-dev` (toàn luồng trên Postgres nhúng với runner giả commit vào git thật, nhiều hệ thống, phản hồi, trần ngày, khóa chung), `devflow-code-review`, `devflow-staff-notify`; db `dr-systems-dev-migration`; UI `code-review`. Đột biến bị bắt ở: kiểm đường dẫn cấm, tách đổi tên, kiểm tổ tiên, kiểm bảo vệ nhánh, chỉ đẩy `devflow/*`, kiểm agent trên runner, token ghi trước khi chạy, lọc hệ thống bật Dev, chặn approve, đóng PR khi reject.
Đã chạy thật: runner qua SSH, workspace và commit về server (kể cả repo lồng nhau), proxy cho phép, .NET restore qua proxy, tạo/sửa PR nháp trên GitHub (spike 1.4), `setup-dev-runner.mjs` và `setup-dev-agent.mjs` trên công ty thử. **Chưa:** một lượt agent Dev thật từ đầu tới cuối (smoke 5.1), xem trang `/code-review` trên trình duyệt.

## Giới hạn đã biết
- Tuần tự toàn instance; một lượt Dev tới 60 phút chặn BA và Tech Plan của mọi công ty trong lúc đó.
- Hệ thống nhiều repo chạy lại phần đã xong khi lượt sau lỗi; PR đã đẩy trước khi phát hiện case đã chuyển giai đoạn vẫn còn trên GitHub.
- Transcript Claude Code trên runner dùng chung giữa các công ty; môi trường runner và secret khóa SSH là của instance (tạo lần đầu theo công ty chạy script).
- Cờ `protected` không nói quy tắc "bắt buộc qua PR"; quy tắc cần quyền admin nên không đọc.
- Chưa có Flutter trong image runner; Python không có `venv` (firewall công ty chặn gói).
- Agent BA và Planner không bị luật chặn đọc `/paperclip/devflow/ws/dev` (xem ADR 0024).
