## Context

- Pipeline `dev-request` đã có `dev` (working) → `code_review` (review: approve → `qa`, reject → `cancelled`, request_changes → `dev`, bắt lý do) → `qa` → `qa_signoff` → `done`. Kế hoạch đã duyệt nằm ở `data.approved` của đề xuất stage `tech_plan` (task theo hệ thống, file, phụ thuộc, kế hoạch test).
- Khung chung `server/src/devflow/agent-stage/` (workspace, run-loop, worker với khóa chung `dr-agent-stage-worker`, metrics) chạy BA và Planner; cả hai **chỉ đọc**, cùng chạy trong container server, an toàn nhờ chỉ có `Read,Grep,Glob` (ADR 0020, 0021).
- Agent Dev cần `Edit`, `Write`, `Bash`: chặn bằng danh sách tool không còn đủ. Chủ dự án chọn **runner riêng** (2026-10-21) và sẽ cấp **token GitHub có quyền ghi**.
- Paperclip có execution target `remote` qua SSH (`packages/adapter-utils/src/execution-target.ts`, `ssh.ts`) và môi trường (`environments`, `defaultEnvironmentId` của agent). **Chưa kiểm chứng** `claude_local` chạy được qua SSH tới một container trong cùng compose, cách cấu hình môi trường, và cách `cwd`, biến môi trường, transcript hoạt động ở phía xa.

## Goals / Non-Goals

**Goals:** hiện thực kế hoạch đã duyệt thành PR nháp trên nhánh riêng, có kết quả lệnh kiểm tra; người duyệt quyết định ở `code_review`; agent không chạm được dữ liệu của server hay công ty khác, không có token GitHub, không đẩy được vào nhánh chính; chi phí có trần.

**Non-Goals:** QA, merge, deploy, model local, chạy song song, toolchain mọi ngôn ngữ.

## Decisions

### D1. Runner riêng, agent chạy qua execution target SSH của Paperclip
- Service compose `devflow-runner`: image riêng (Debian, git, Node 24, Claude Code CLI, Python 3; Dart/Flutter nếu spike cho thấy chạy được với dung lượng chấp nhận), `sshd` chỉ nhận khóa của server, user không phải root, **không** biến môi trường bí mật, **không** volume `/paperclip`, thư mục làm việc `/work` (volume riêng của runner).
- Agent Dev có `defaultEnvironmentId` trỏ tới môi trường SSH `devflow-runner` (tạo bằng script setup). Lượt chạy: Paperclip mở SSH, chạy `claude` trên runner, nhận lại stream; DevFlow đọc `resultJson` như BA/Planner.
- **Cập nhật sau spike (2026-10-21, `kb/spike-p3-runner.md`):** workspace **nằm ở server**, không phải ở runner. DevFlow dựng thư mục `/paperclip/devflow/ws/dev` (clone bằng token đọc, nhánh `devflow/<REQ>`); mỗi lượt Paperclip **đóng gói thư mục này sang runner, chạy agent ở đó, rồi ghi các commit mới về lại thư mục ở server** và dọn bên runner. `cwd` của agent là cùng một đường dẫn ở cả hai phía (runner có sẵn thư mục `/paperclip/devflow/ws` rỗng của riêng nó). Nhờ vậy token ghi chỉ ở server, agent không bao giờ thấy.
- **Cập nhật 2026-10-22 (spike bố cục workspace, task 3.4):** Paperclip chỉ gửi qua lại được **commit** của repo ở `cwd` và của các repo nằm trong `cwd/.paperclip-repositories/<tên>/` (mỗi repo một git bundle, hai chiều). Vì vậy: (1) `cwd` (`/paperclip/devflow/ws/dev`) phải là một repo git "neo" có một commit rỗng, `.devflow/` và `.paperclip-repositories/` nằm trong `.git/info/exclude`; (2) các repo của hệ thống nằm ở `.paperclip-repositories/<key>/` (không phải `repos/<key>/`) và **clone đầy đủ** vì không thể tạo bundle từ clone nông (`--depth`) hoặc một phần (đã thử: bundle thiếu object); (3) cấu hình git cục bộ của repo (user.name/email) **không** được chuyển sang runner, nên tác giả commit đặt qua biến môi trường của agent (`GIT_CONFIG_COUNT/KEY/VALUE`: chế độ secret nghiêm ngặt của Paperclip từ chối khóa có chữ "auth" như `GIT_AUTHOR_*`, phát hiện khi chạy thật 2026-10-22); (4) `.devflow/request.md` đến runner như file thường; (5) kiểm bằng chạy thật: agent commit trong repo lồng nhau trên nhánh `devflow/REQ-9`, commit hiện ở server. Hệ quả: prompt `dev.v1` và `request.md` dùng đường dẫn `.paperclip-repositories/<key>/` (v1 chưa chạy lần nào nên sửa tại chỗ, hash ghim lại).
- Một lượt Dev chạy lần lượt từng hệ thống được gán nếu có nhiều hệ thống, mỗi hệ thống một nhánh và một PR; (chưa làm: song song).
- Còn mở: transcript của Claude Code trên runner (`~/.claude/projects/<cwd>`) dùng chung giữa các công ty vì `cwd` giống nhau; cần dọn trong runner (task 3.6/5.2).
- Khóa SSH: cặp khóa sinh lúc cài, khóa riêng là secret của instance (không vào repo), khóa công khai mount vào runner.
- **Spike trước tiên** (task 1): nếu `claude_local` qua SSH không chạy được, không truyền được `env`, hoặc cần vá lõi lớn, dừng lại và trình phương án dự phòng: runner có API HTTP nội bộ do DevFlow gọi trực tiếp (mất phần ghi run/chi phí của Paperclip, phải tự ghi), chờ chủ dự án chọn.

### D2. Mạng ra ngoài của runner theo danh sách cho phép
- Runner ở mạng compose `internal: true` (không có đường ra mặc định) cộng một proxy HTTP(S) (ví dụ Squid hoặc tinyproxy) cho phép đúng các host: `api.anthropic.com`, `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, kho package theo toolchain (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `pub.dev`, `storage.googleapis.com` cho Flutter). `HTTP(S)_PROXY` đặt trong runner.
- Danh sách nằm trong file cấu hình của runner, đổi được không cần build lại server. **Chưa kiểm chứng**: Claude Code và các trình cài package đi qua proxy ổn định.

### D3. Agent không có token; DevFlow push và mở PR
- Clone: DevFlow (ở server, như BA) clone repo vào `/paperclip/devflow/ws/dev/repos/<key>` bằng **token chỉ đọc**, tạo nhánh `devflow/<REQ-n>` từ branch mặc định; nếu nhánh đã có trên GitHub (lượt sau request_changes) thì lấy nhánh đó và làm tiếp.
- Agent sửa, chạy lệnh kiểm tra, `git commit` cục bộ (git config tên "DevFlow Dev"). Không có remote có quyền ghi trong workspace.
- Sau lượt chạy (Paperclip đã ghi commit về server; chỉ dựa vào `git log`/`git diff <baseSha>..HEAD`, **không** tin chỉ mục hay cây làm việc vì spike thấy chúng lệch sau khi ghi về), DevFlow kiểm: chỉ có commit mới trên đúng nhánh; không có thay đổi ở **đường dẫn cấm** (mặc định `.github/workflows/**`, `.env*`, `**/*.pem`, `**/*.key`, thêm được theo hệ thống); tổng dòng đổi ≤ trần (mặc định 3000); không file nhị phân lớn hơn 1 MB. Vi phạm → không push, lỗi rõ loại (`forbidden_paths`, `diff_too_large`), đề xuất vẫn ghi để người duyệt thấy lý do.
- **Trước khi push**, DevFlow gọi GitHub API kiểm **nhánh mặc định có bảo vệ** (bắt buộc qua PR); không có → từ chối (`repo_unprotected`), trừ khi hệ thống được chủ dự án bật `allow_unprotected` (repo riêng gói miễn phí không có branch protection, ví dụ RESKI; spike 1.4). Khi đó DevFlow vẫn chỉ đẩy `devflow/*`, mở PR nháp, không merge, và đề xuất ghi cảnh báo "nhánh mặc định không được bảo vệ". Push bằng **token ghi** truyền qua header cho đúng một lệnh `git push` (như clone ở ADR 0021), chỉ tới `refs/heads/devflow/*`.
- **Hiện thực (3.5):** `dev/diff-check.ts` chỉ đọc `git diff <base>..HEAD` (không đọc chỉ mục/cây làm việc): đúng nhánh (HEAD là ref `devflow/<REQ>`), `base` là tổ tiên của HEAD (không viết lại lịch sử), đường dẫn cấm mặc định (workflow CI, `.env*`, `*.pem`, `*.key`, Jenkinsfile, `.gitmodules`...) cộng đường dẫn cấm theo hệ thống (so khớp không phân biệt hoa thường, đổi tên được tách thành xóa + thêm), không submodule, tổng dòng đổi ≤ 3000, file nhị phân ≤ 1 MB. `dev/github.ts` (`fetch`, không thư viện): quyền push của token ghi, cờ `protected` của nhánh mặc định (chỉ đọc cờ; chi tiết quy tắc cần quyền admin nên **không** kiểm "bắt buộc qua PR" riêng), PR nháp, cập nhật, bình luận, đóng; `pushBranch` chỉ đẩy `HEAD:refs/heads/devflow/*`, không force, không hook, token ở header của một tiến trình git. `dev/publish.ts` ghép: kiểm diff → (không commit thì dừng) → quyền push → bảo vệ nhánh (hoặc `allow_unprotected` kèm cảnh báo trong PR) → push → tạo hoặc cập nhật PR. Nội dung agent đưa vào PR được chèn ký tự rỗng sau `@` để không gọi tên ai.
- Mở PR **nháp** qua REST GitHub (`fetch`, không thêm thư viện): tiêu đề `[REQ-n] <tiêu đề>`, nội dung gồm tóm tắt, task đã làm, lệnh kiểm tra và kết quả, link về DevFlow, nhãn `devflow`. Lượt sau request_changes thì cập nhật PR có sẵn (thêm bình luận tóm tắt lượt mới).

### D4. Bật theo hệ thống, token ghi riêng, lệnh kiểm tra
- `dr_systems` thêm `dev_enabled`, `write_token_secret_id`, `test_command`, `forbidden_paths` (DDL dưới). Trang Systems có công tắc "Cho phép agent Dev", ô token ghi (nhập một lần, lưu thành secret công ty), ô lệnh kiểm tra (ví dụ `cd backend && npm test`), ô đường dẫn cấm thêm.
- Case ở `dev` có hệ thống đã gán **không** bật Dev → worker bỏ qua hệ thống đó; không còn hệ thống nào → lỗi cấu hình `no_dev_system` (thử lại calmly như BA, không tốn tiền).
- Lệnh kiểm tra trống → agent tự suy ra từ repo (README, hướng dẫn) và ghi lệnh đã dùng; Planner nay cũng được hướng dẫn ghi lệnh kiểm tra vào kế hoạch.

### D5. Cấu hình agent Dev
```
adapterType: claude_local, defaultEnvironmentId: <devflow-runner SSH>
adapterConfig: { cwd: "/work/dev", model: DEVFLOW_DEV_MODEL (mặc định claude-sonnet-5-5), engine: "cli",
  maxTurnsPerRun: 200, timeoutSec: 3600,
  extraArgs: ["--tools", "Read,Grep,Glob,Edit,Write,Bash", "--max-budget-usd", DEVFLOW_DEV_MAX_USD_PER_RUN (mặc định 5)],
  env: { ANTHROPIC_API_KEY: secret_ref } }
```
- Kiểm trước mỗi lượt (như `unsafeBaAgentReason`): đúng môi trường runner, đúng `cwd`, đúng danh sách tool, có ngân sách, có hướng dẫn gắn, prompt đúng phiên bản. Agent Dev **không bao giờ** chạy trong container server: không có môi trường runner → từ chối `agent_not_on_runner`.
- Trần ngày mỗi công ty `DEVFLOW_DEV_MAX_USD_PER_DAY` (mặc định 50), sổ `agent.dev_run` riêng.
- Vẫn một lượt agent cùng lúc toàn instance (khóa chung); `ponytail:` một lượt Dev có thể dài tới 60 phút và chặn BA/Planner trong lúc đó; tách khóa theo nơi chạy (server/runner) khi thông lượng không đủ.

- **Hiện thực worker (3.6):** `dev/dev-service.ts` dùng lại khung `stageService` (danh sách chờ, phản hồi, sổ `agent.dev_run`, trần ngày, ghi đề xuất và chuyển `code_review` qua hàm `submit` mới tách ra) và `createStageWorker` (khóa chung `dr-agent-stage-worker`, backoff, breaker). Mỗi lượt: kiểm agent (`devAgentProblem`), lấy spec BA và kế hoạch đã duyệt (`data.approved`), chọn hệ thống có Dev bật và có task trong kế hoạch, lấy token ghi **trước khi tốn tiền**, rồi **từng hệ thống một**: workspace → agent → phân tích báo cáo (thử lại một lần) → kiểm diff và đẩy nhánh. Diff bị chặn (đường dẫn cấm, quá lớn, nhị phân lớn, submodule, sai nhánh, viết lại lịch sử) vẫn thành đề xuất để người duyệt đọc lý do, không đẩy gì. `repo_unprotected`, token ghi không đẩy được, lỗi GitHub là lỗi thất bại thử lại (loại cấu hình thì thử lại chậm, không bỏ cuộc). Không có commit nào: đề xuất ghi "không thay đổi", không PR. Hạn chế đã biết (`ponytail`): hệ thống nhiều repo chạy lại các hệ thống đã xong khi một hệ thống sau lỗi; PR/nhánh đã đẩy trước khi phát hiện case đã chuyển giai đoạn (stale) vẫn còn trên GitHub.
### D6. Đầu vào và đầu ra
- `request.md`: yêu cầu, phân loại, **spec BA đã duyệt**, **kế hoạch đã duyệt** (task, file, phụ thuộc, test plan), hệ thống (thư mục, nhánh, lệnh kiểm tra), phản hồi của người duyệt ở `code_review` lần trước; dữ liệu người dùng nằm giữa ranh giới ngẫu nhiên.
- JSON strict: `summary`, `tasks` [{`id` (phải thuộc kế hoạch), `status` done/partial/skipped, `notes`}], `checks` [{`system`, `command`, `passed`, `outputTail` ≤ 2000 ký tự}], `openQuestions`, `risks`, `confidence`. DevFlow tự bổ sung `repos` [{`system`, `branch`, `baseSha`, `headSha`, `filesChanged`, `additions`, `deletions`, `prUrl`, `prNumber`}].
- Không có commit mới → lượt hợp lệ nhưng không mở PR (người duyệt thấy "không thay đổi"); JSON sai → chạy lại một lần như BA.

### D7. Code review
- API `GET …/devflow/code-queue|code-count|code-metrics|code-cases/:id`, `POST …/code-cases/:id/decision`; trang `/code-review`. Không sửa nội dung (người sửa code trên GitHub); quyết định nguyên tử qua `beforeCommit`; cần vai `tech_lead` (cấu hình pipeline `code_review` approver `role`).
- request_changes: lý do vào lượt sau, agent làm tiếp trên cùng nhánh, PR cũ được cập nhật. reject: DevFlow đóng PR (không xóa nhánh). approve: case sang `qa`; merge vẫn do người trên GitHub.
- **Hiện thực (4.1):** `dev/review-service.ts` và `dev/routes.ts`: `code-queue`, `code-count`, `code-metrics`, `code-cases/:id` (báo cáo, các PR, kết quả kiểm tra, task của kế hoạch đã duyệt và tiêu chí BA để đối chiếu), `code-cases/:id/decision` (không có `final`: không sửa nội dung). Quyết định qua `beforeCommit`; vai `tech_lead` do cấu hình pipeline (4.2) và core kiểm. **Approve bị từ chối (422)** khi không có PR hoặc có repo mà DevFlow không đẩy (`no_pull_request`, `blocked_diff`): người duyệt chỉ có thể trả lại hoặc reject. Approve ghi `data.approved` (PR, task, kiểm tra) cho QA. Reject đóng các PR sau khi quyết định đã commit (token ghi của hệ thống); không đóng được thì quyết định vẫn giữ, ghi `code.pr_close_failed` và trả `closedPullRequests` để người đóng tay. request_changes giữ PR mở, lượt sau làm tiếp trên cùng nhánh.

## DDL đề xuất (chờ duyệt)

```sql
ALTER TABLE dr_systems
  ADD COLUMN dev_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN write_token_secret_id uuid,
  ADD COLUMN test_command text,
  ADD COLUMN forbidden_paths text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN allow_unprotected boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT dr_systems_test_command_check CHECK (test_command IS NULL OR char_length(test_command) BETWEEN 1 AND 500),
  ADD CONSTRAINT dr_systems_forbidden_paths_check CHECK (cardinality(forbidden_paths) <= 50),
  ADD CONSTRAINT dr_systems_dev_token_check CHECK (NOT dev_enabled OR write_token_secret_id IS NOT NULL);
```
- `allow_unprotected` mặc định false; chỉ có ý nghĩa khi `dev_enabled`. Do chủ dự án bật có chủ đích (API/UI hạn chế vai owner/instance admin).
- `dev_enabled` cần token ghi (CHECK). Không khóa ngoại tới secret (như `token_secret_id`).
- Thông tin PR nằm trong `data` của đề xuất (`dr_agent_outputs`), không thêm bảng.
- `test_command` là chuỗi chạy bằng `bash -lc` **trên runner, bởi agent** (agent vốn đã có Bash); DevFlow không tự chạy lệnh này ở server.

## Risks / Trade-offs

- [Agent có Bash: có thể chạy mã độc từ repo hay từ yêu cầu bị chèn lệnh] → runner không có secret ngoài key model, mạng theo danh sách, workspace dọn sau mỗi case, DevFlow kiểm diff trước khi push, người duyệt PR là chốt cuối.
- [Key model nằm trong runner] → có thể bị chép ra qua host được phép (api.anthropic.com với key khác)? Chấp nhận cho pilot; theo dõi chi phí theo key; P4 dùng proxy model có xác thực riêng.
- [Execution target SSH] → đã kiểm chứng ở spike (agent chạy trên runner, commit về lại server, chi phí được ghi); còn các việc nhỏ ở `kb/spike-p3-runner.md`.
- [Toolchain Flutter nặng (vài GB)] → bản đầu có thể chỉ Node/Python; nếu repo cần Flutter mà runner không có, agent ghi "không chạy được kiểm tra" và người duyệt quyết.
- [Một lượt Dev dài chặn BA/Planner] → chấp nhận cho pilot (D5).
- [Token ghi có thể push nhánh chính nếu repo không bảo vệ] → DevFlow kiểm bảo vệ trước khi push (D3) và chỉ push `refs/heads/devflow/*`; chủ dự án bật bảo vệ cho `main` và `test` trước khi cấp token.

## Open Questions (mặc định nếu không có ý kiến)
1. Toolchain bản đầu: Node 24 + Python 3 + Dart/Flutter (nếu spike cho dung lượng chấp nhận). Mặc định thử có Flutter vì RESKI cần.
2. Model Dev: `claude-sonnet-5-5`, 5 USD mỗi lượt, 50 USD mỗi ngày mỗi công ty.
3. Trần diff 3000 dòng, đường dẫn cấm mặc định như D3.
4. Người duyệt `code_review`: vai `tech_lead` (owner/instance admin vẫn qua như ADR 0023).
