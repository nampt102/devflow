# Spike P2: chạy agent `claude_local` qua Paperclip (2026-10-19)

Mục tiêu (ADR 0020): xác nhận BA Spec/Tech Plan chạy được bằng adapter của Paperclip trên stack Docker hiện tại. Kịch bản: clone repo `nampt102/devflow` (nhánh `chore/project-kit`) vào `/paperclip/spike/repo` trong container, tạo agent `claude_local` (model `claude-haiku-5-5`, key Anthropic qua secret) qua API, gọi `POST /api/agents/:id/wakeup`, đọc `GET /api/heartbeat-runs/:id`.

## Kết quả (đã xác nhận bằng chạy thật)
- **Chạy được trong image hiện tại**: CLI `claude` 2.1.302 đã có trong image, chạy bằng user `node`; không cần sửa Dockerfile. `git` và `gh` có sẵn.
- **Chất lượng**: một lượt BA (111 giây, `maxTurnsPerRun` 25) cho spec dài, có trích dẫn `file:dòng` đúng vào code thật (ví dụ `portal-service.ts:17-27`, `status-labels.ts:5-22`), nêu phương án A/B, câu hỏi mở, và tự ghi nhận chỗ chưa kiểm chứng. Không sửa file nào. Kết quả nằm ở `run.resultJson.summary` (markdown tự do).
- **Chi phí được Paperclip ghi nhận**: `costStatus: "reported"`, `billingType: metered_api`, `costUsd` ≈ 1,33 USD cho lượt phân tích repo cỡ này (≈137 nghìn token vào, 21 nghìn token ra, hơn 1 triệu token đọc cache), 0,11 USD cho lượt thăm dò ngắn. Khác Triage (`unpriced`), ngân sách tiền của Paperclip có thể chặn được agent adapter. Cần xem bảng giá model trước khi tin con số.
- Secret bắt buộc là tham chiếu: server từ chối `ANTHROPIC_API_KEY` dạng `plain` ("Strict secret mode"); tạo secret công ty rồi dùng `{type:"secret_ref", secretId, version:"latest"}`.
- Agent mới không được dùng `adapterConfig.promptTemplate`; chỉ dẫn đặt trong `instructionsBundle` (`AGENTS.md`).

## Phát hiện cần xử lý khi thiết kế P2
1. **Không có chế độ chỉ đọc mặc định.** `dangerouslySkipPermissions` mặc định `true`; thử `extraArgs: ["--disallowedTools","Write,Edit,..."]` **không chặn** được Write/Bash (agent vẫn tạo được file trong workspace). Chặn thật cần: (a) token GitHub chỉ đọc, không có thông tin xác thực để push (đã thấy `git push` lỗi vì thiếu credential), (b) workspace là bản clone dùng một lần, dọn sau mỗi lượt, (c) cấu hình `filesystemScope: "workspace"` và `networkScope: "allowlist"` (bubblewrap; xem `doc/spec/agent-runs.md`). **`bwrap` chưa có trong image** và chưa thử trong Docker Desktop (cần quyền tạo user namespace): chưa xác nhận.
2. **Mạng ra ngoài chưa bị chặn**: `curl https://example.com` chỉ lỗi vì chứng chỉ trong container, không phải vì chính sách. Repo và docs là dữ liệu không tin cậy (prompt injection) nên cần `networkScope` hoặc chấp nhận rủi ro có kiểm soát.
3. **Đầu ra không có schema.** Adapter trả `summary` markdown; muốn JSON/Zod như Triage thì phải bắt agent in khối JSON cuối rồi parse + kiểm + chạy lại khi sai (chưa thử). `--max-budget-usd` truyền qua `extraArgs` chưa kiểm chứng là có hiệu lực.
4. **Gắn vào pipeline chưa làm.** Spike chỉ chạy `wakeup` độc lập (`livenessState: "blocked"`, `issueId: null`). Cần xác định cách tạo run từ stage `ba_spec` (cơ chế `automation`/`assigneeAgentId` hoặc issue liên kết `pipeline_case_issue_links`) và cách DevFlow lấy kết quả ghi vào `dr_agent_outputs`.
5. **Dọn dẹp:** hai agent "Spike BA …" trong công ty `DevFlow Verify` chưa xóa được (API trả 409, có run); hai secret thử đã xóa. Clone ở `/paperclip/spike/repo` trong volume `/paperclip`.

## Việc tiếp theo để chốt thiết kế
- Thử `bwrap` (cài vào image) với `filesystemScope`/`networkScope` trong Docker Desktop.
- Thử đầu ra JSON có kiểm tra và `--max-budget-usd`.
- Thử gắn run vào một case pipeline thật (stage BA Spec).
- Chạy lại với model local nếu muốn (adapter OpenAI-compatible chưa kiểm chứng).

# Vòng 2 (2026-10-19)

## Bubblewrap (`filesystemScope`/`networkScope`)
- `apt-get install bubblewrap` trong image chạy được (Debian 13, bwrap 0.12.0), nhưng **mặc định không dùng được trong container**: `bwrap: No permissions to create a new namespace` (seccomp mặc định của Docker chặn user namespace).
- Trên container thử cùng image: chạy được khi thêm `--security-opt seccomp=unconfined` (không cần thêm capability, không cần apparmor=unconfined); `bwrap --ro-bind / / --unshare-pid --unshare-net` in được `sandbox-ok`. **Đánh đổi:** tắt bộ lọc seccomp của cả container server. Chưa tích hợp vào stack và chưa chạy qua adapter (`filesystemScope: "workspace"`, `networkScope: "allowlist"` cần `engine: cli`); cần chủ dự án quyết định có chấp nhận hay dùng profile seccomp riêng.

## Điều khiển chạy agent
- **Mặc định adapter dùng engine ACP, bỏ qua `extraArgs`.** Vòng 1 `--disallowedTools` và `--max-budget-usd` không có tác dụng vì lý do này. Đặt `adapterConfig.engine: "cli"` thì `extraArgs` được truyền cho `claude`.
- `engine: "cli"` + `--disallowedTools Write,Edit,NotebookEdit`: tool Write bị chặn thật, nhưng agent vòng qua bằng Bash (`echo > file` vẫn tạo được file). **Chặn tool không đủ cho "chỉ đọc"**: cần bubblewrap, hoặc workspace dùng một lần + kiểm `git status --porcelain` sạch sau mỗi lượt + token GitHub chỉ đọc.
- `--max-budget-usd 0.05` (engine cli) **có hiệu lực**: run dừng ở 0,056 USD, `status: failed`, `subtype: error_max_budget_usd`, nhưng `errorCode` trả `claude_auth_required` (gây hiểu nhầm; DevFlow phải đọc `resultJson.subtype`).
- **Đầu ra JSON**: yêu cầu "chỉ một object JSON, đúng các khóa" cho kết quả hợp lệ 5/5 lần (haiku), có trích dẫn file:dòng đúng; vẫn phải kiểm bằng Zod strict và chạy lại khi sai.

## Gắn vào stage của pipeline (thử trên pipeline tạm trong công ty `DevFlow Verify`)
- Cấu hình: routine (`POST /api/companies/:id/routines`, `assigneeAgentId` = agent `claude_local`) + `PATCH /api/pipelines/:id/stages/:stageId` với `config.onEnter = {type:"run_routine", routineId}`.
- Case vào stage `ba_spec` (ingest với `stage: "ba_spec"`) → **tự tạo issue** (DEV-1) gán cho agent kèm "Pipeline Case Context" (title, fields, case_id, JSON context pack) và **tự chạy** agent sau ~5 giây; link `automation` giữa case và issue; event `automation_executed`.
- **Kết quả nằm ở bình luận của agent trên issue** (toàn văn JSON, ~3,7 KB, chứ không phải `resultJson` vốn bị cắt 500 ký tự). Cách lấy: `GET /api/issues/:id/comments`, bình luận cuối của agent. `GET /api/issues/:id/documents` rỗng.
- **Vòng sửa disposition gây nhiễu**: agent không đổi trạng thái issue/case nên Paperclip đánh thức lại 2 lần (3 run, đều thành công, chi phí mỗi run 0,005 đến 0,007 USD theo `costUsd` báo cáo) rồi để issue ở `blocked` với bình luận "disposition repair exhausted". Cần quyết định: dạy agent (qua instructions và skill `paperclip`) đóng issue và chuyển case bằng API, hoặc để DevFlow đóng issue sau khi đã lưu đầu ra. Chưa thử.
- Case vẫn ở `ba_spec` sau run: agent chỉ đề xuất, không tự chuyển (đúng nguyên tắc); chưa thử luồng `pendingSuggestion` hoặc để DevFlow chuyển case sang `ba_review` sau khi parse đầu ra.

## Việc còn lại trước change proposal P2
1. Quyết định bubblewrap/seccomp (hoặc chấp nhận workspace dùng một lần + kiểm `git status`).
2. Cách đóng vòng issue (agent đóng, hay DevFlow đóng) và cách DevFlow chuyển case sang `ba_review`.
3. Tồn đọng dọn dẹp: agent "Spike BA …", pipeline "Spike BA …", routine và issue DEV-1 trong công ty `DevFlow Verify`.
