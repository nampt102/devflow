## Context

- Pipeline `dev-request` đã có stage `ba_spec` (working) và `ba_review` (review, approve → `tech_plan`, reject → `cancelled`, request_changes → `ba_spec`). Hiện chưa có gì chạy ở `ba_spec`.
- Spike (`kb/spike-p2-adapter.md`, 4 vòng) đã xác nhận: `claude_local` chạy trong image hiện tại; `engine: cli` mới nhận `extraArgs`; `--tools Read,Grep,Glob` bỏ hẳn tool ghi, shell và web; `--disallowedTools Read(//…/**)` chặn được đường dẫn; `--max-budget-usd` dừng run (`resultJson.subtype = error_max_budget_usd`, `errorCode` báo nhầm `claude_auth_required`); đầu ra JSON hợp lệ 5/5 lần; kết quả đầy đủ lấy từ `GET /api/heartbeat-runs/:id`; chi phí được Paperclip ghi (`costStatus: reported`).
- ADR 0020 + chủ dự án duyệt Option 3 (chỉ tool đọc) ngày 2026-10-19.

## Goals / Non-Goals

**Goals:** đề xuất BA spec có trích dẫn đúng cho mỗi yêu cầu đã qua Triage; người duyệt sửa hoặc trả lại có lý do; ghi audit và override; chi phí có trần; agent không ghi, không gọi mạng ngoài model, không đọc dữ liệu instance.

**Non-Goals:** Tech Plan, approver theo role, model local, cách ly bằng bubblewrap hay runner riêng (để P4).

## Decisions

### D1. DevFlow điều khiển toàn bộ lượt chạy, không dùng `onEnter`/routine
Agent chỉ có tool đọc nên không thể gọi API Paperclip để đóng issue hay chuyển case. Vì vậy DevFlow làm mọi bước: dựng workspace, gọi `POST /agents/:id/wakeup` (không gắn issue), đọc run, ghi output, chuyển case.
- Lý do: tránh vòng "disposition repair" (3 run cho một case, issue bị `blocked`) đã thấy khi dùng routine; worker quét theo trạng thái nên bắt được mọi đường vào `ba_spec` (approve từ Triage, request_changes từ `ba_review`, chuyển tay).
- Phương án bỏ: routine `onEnter` (sinh issue, cần agent tự đóng); worker nội bộ không qua adapter (ADR 0020 đã loại).

### D2. Workspace: thư mục cố định mỗi agent, chạy tuần tự
- `adapterConfig.cwd` cố định theo agent: `/paperclip/devflow/ws/<companyId>/ba`. Trước mỗi lượt, worker xóa và dựng lại thư mục: `repos/<systemKey>/` (clone `--depth 1` branch đã cấu hình, ghi SHA), `.devflow/request.md`.
- Một công ty chỉ chạy **một lượt BA cùng lúc** (khóa advisory theo công ty). `ponytail:` giới hạn thông lượng khoảng 1 spec mỗi 1–3 phút mỗi công ty; nâng cấp bằng workspace theo run (execution workspace của Paperclip, chưa kiểm chứng) khi cần.
- Clone bằng header xác thực truyền qua `git -c http.extraHeader=…` (không lưu vào `.git/config`), sau đó `git remote remove origin`. Token lấy từ secret công ty qua `resolveSecretValue` của Paperclip (**chưa xác nhận** dùng được từ code DevFlow, kiểm ở task 2.3).

### D3. Cấu hình agent (an toàn)
```
adapterType: claude_local
adapterConfig: { cwd, model: DEVFLOW_BA_MODEL (mặc định claude-haiku-5-5), engine: "cli",
  maxTurnsPerRun: 40, timeoutSec: 900,
  extraArgs: ["--tools","Read,Grep,Glob",
              "--disallowedTools", "<Read|Grep|Glob>(//paperclip/instances/**), …(//proc/**), …(//etc/**), …(//root/**), …(//home/**)",
              "--max-budget-usd", DEVFLOW_BA_MAX_USD_PER_RUN (mặc định 1.0)],
  env: { ANTHROPIC_API_KEY: secret_ref } }
instructionsBundle: AGENTS.md = SYSTEM của prompt ba.vN
```
- Key Anthropic: biến `DEVFLOW_AGENT_ANTHROPIC_API_KEY`; khi agent được tạo, DevFlow lưu vào secret công ty `devflow-agent-anthropic` (bắt buộc dạng secret_ref).
- `ensureBaAgent` đồng bộ cấu hình và instructions khi phiên bản prompt đổi (giống `ensureTriageAgent`).
- Rủi ro còn lại: nội dung trong repo/yêu cầu có thể dụ agent chép đoạn file trong workspace vào spec; người duyệt là chốt chặn. Không có kênh gửi ra ngoài.

### D4. Đầu vào và đầu ra
- `.devflow/request.md`: mã REQ, tiêu đề, mô tả, ảnh hưởng nghiệp vụ, tên file đính kèm, giá trị Triage đã duyệt, danh sách hệ thống (key, repo, SHA, thư mục docs), lý do request_changes gần nhất nếu có. Nội dung requester nằm giữa ranh giới ngẫu nhiên như Triage (dữ liệu, không phải lệnh).
- Agent trả **một object JSON** cuối cùng; DevFlow lấy object JSON cuối trong `resultJson.result`, kiểm bằng Zod strict:
  ```
  { summary, businessGoal, inScope[], outOfScope[], userStories[{asA, iWant, soThat}],
    acceptanceCriteria[], affectedAreas[{system, path, line, why}], dataChanges[],
    risks[], openQuestions[], confidence: "low"|"medium"|"high" }
  ```
  Văn bản tiếng Việt, tên file/hàm giữ nguyên. Kiểm thêm: `system` phải thuộc danh sách đã gán, `path` không chứa `..`.
- `dr_agent_outputs`: `stage_key = ba_spec`, `prompt_role = ba`, `data` = object trên + `{ repos: [{system, sha}] }`, `comment_text` = markdown dựng từ data, `run_id`, `agent_id`.
- Lỗi: JSON sai → chạy lại 1 lần kèm thông báo lỗi kiểm tra; hết ngân sách (`subtype`), timeout, lỗi adapter → backoff như Triage, sau 3 lần thì bỏ cuộc và hiện trong "lỗi gần đây". Không có hệ thống nào được gán vẫn chạy (spec chỉ dựa trên yêu cầu, ghi rõ trong openQuestions).

### D5. Chuyển stage và duyệt
- Sau khi ghi output, worker gọi `transitionCase` `ba_spec → ba_review` (actor hệ thống DevFlow) trong cùng giao dịch với insert output (hoặc bù trừ nếu core không cho chung giao dịch, kiểm ở task 3.4).
- BA review dùng lại khung Triage review: hàng chờ, chi tiết, sửa field, quyết định qua `reviewCase` + `beforeCommit` (cập nhật trạng thái output `accepted`/`overridden`, ghi `dr_overrides` theo field, lưu hệ thống đã đổi). request_changes bắt buộc có lý do; lý do được ghi vào `request.md` của lượt sau.
- Approve đưa case tới `tech_plan` (chưa có agent; nằm chờ đến change sau).

### D6. Hệ thống và gán ở Triage
- `triage.v4`: thêm đầu vào danh sách hệ thống (key, tên, mô tả) và đầu ra `suggestedSystemKeys` (≤ 3, phải thuộc danh sách). Định nghĩa ưu tiên/độ khó vẫn là bản TEMPORARY (A-14 sẽ thành v5).
- Triage review: ô chọn nhiều hệ thống, điền sẵn từ đề xuất; khi approve, ghi `dr_request_systems` trong hook `beforeCommit`.

### D7. Chi phí
- `--max-budget-usd` mỗi lượt (D3).
- Trần ngày mỗi công ty `DEVFLOW_AGENT_MAX_USD_PER_DAY` (mặc định 20): tổng `cost_events` của agent BA trong ngày UTC; vượt thì worker bỏ qua công ty đến 0h UTC, ghi activity một lần mỗi ngày (giống trần token Triage).

## DDL đề xuất (chờ duyệt)

```sql
CREATE TABLE dr_systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key text NOT NULL,                       -- slug, ví dụ "hr-portal"
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  repo_url text NOT NULL,                  -- https://github.com/<owner>/<repo>
  default_branch text NOT NULL DEFAULT 'main',
  docs_path text NOT NULL DEFAULT 'docs',
  token_secret_id uuid,                    -- company_secrets.id, token chỉ đọc; null = repo public
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dr_systems_key_check CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT dr_systems_repo_check CHECK (repo_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  CONSTRAINT dr_systems_docs_check CHECK (docs_path !~ '(^/|\.\.)')
);
CREATE UNIQUE INDEX dr_systems_id_company_uq ON dr_systems (id, company_id);
CREATE UNIQUE INDEX dr_systems_company_key_uq ON dr_systems (company_id, key);

CREATE TABLE dr_request_systems (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  case_id uuid NOT NULL,
  system_id uuid NOT NULL,
  assigned_by_user_id text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, system_id),
  FOREIGN KEY (case_id, company_id) REFERENCES pipeline_cases (id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (system_id, company_id) REFERENCES dr_systems (id, company_id) ON DELETE CASCADE
);
CREATE INDEX dr_request_systems_company_idx ON dr_request_systems (company_id, system_id);
```
- Khóa ngoại kép theo ADR 0010. Một hệ thống là một repo (đủ cho pilot; nhiều repo mỗi hệ thống thì thêm bảng sau).
- Không khóa ngoại tới `company_secrets` (kiểm tra cùng công ty ở service); xóa secret làm clone lỗi rõ ràng.
- Xóa hệ thống: đặt `active = false` thay vì xóa, để lịch sử output vẫn đọc được tên.

## Risks / Trade-offs

- [Agent đọc được mọi file không bị chặn trong container] → danh sách chặn ở D3, người duyệt kiểm spec; cách ly mạnh hơn ở P4.
- [Chạy tuần tự mỗi công ty] → đủ cho pilot; số liệu thời gian chờ ở mục Quality cho biết khi nào cần song song.
- [Chi phí thật khi model lớn] → mặc định haiku, trần mỗi lượt và mỗi ngày.
- [Adapter Paperclip đổi hành vi khi cập nhật upstream] → test tích hợp với adapter giả (`process`) và smoke trên stack thật.
- [`resolveSecretValue` dùng từ DevFlow chưa xác nhận] → task 2.3 kiểm trước khi làm clone.

## Open Questions (mặc định nếu không có ý kiến)
1. Model mặc định cho BA: `claude-haiku-5-5` (đã thử, rẻ) hay `claude-sonnet-5-5`? Mặc định haiku, đổi bằng env.
2. Ngôn ngữ spec: tiếng Việt (mặc định).
3. Trang Systems: chỉ instance admin hay mọi nhân viên của công ty? Mặc định mọi nhân viên có quyền board của công ty.
