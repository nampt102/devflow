## Context

- Xem proposal.md (Why). Code BA hiện nằm trong `server/src/devflow/ba/`:
  - `runner.ts`: wakeup và đọc `heartbeat_runs`, không có gì riêng của BA.
  - `agent.ts`: cấu hình chuẩn, `denyRules`, `unsafeBaAgentReason`, thư mục transcript.
  - `ba-service.ts`: dựng workspace, clone, chạy tối đa 2 lần, kiểm schema, ghi output, chuyển stage, sổ chi phí `agent.ba_run`, trần ngày.
  - `worker.ts`: backoff, breaker, lỗi cấu hình thử lại sau 5 phút, khóa advisory `dr-ba-worker`.
  - `review-service.ts`, `metrics.ts`, `routes.ts`, `start.ts`.
- Workspace BA là một thư mục chung `/paperclip/devflow/ws/ba`, chạy tuần tự, dọn trước và sau mỗi case cùng transcript của Claude Code (`$HOME/.claude/projects/-paperclip-devflow-ws-ba`). Không chặn cả `/paperclip/.claude` được vì Claude Code lưu kết quả tool lớn của lượt hiện tại ở đó (B-38).
- Pipeline `dev-request`: `tech_plan` (working) → `plan_review` (review; approve → `dev`, reject → `cancelled`, request_changes → `tech_plan`, cần lý do). Nhãn trạng thái cho requester của hai stage đã có.
- Spec đã duyệt nằm ở `dr_agent_outputs.data.approved` của output `ba_spec` có trạng thái `accepted` hoặc `overridden`. Unique index cho phép một output `proposed` mỗi `(case, stage)`.
- `stage_key` và `prompt_role` không bị ràng buộc giá trị, nên không cần migration.

## Goals / Non-Goals

**Goals:** kế hoạch có task trích dẫn đúng file của hệ thống đã gán và kiểm được bằng máy (mã task, phụ thuộc); BA giữ nguyên hành vi sau khi tách code; hai stage không bao giờ chạy cùng lúc và không đọc được workspace của nhau.

**Non-Goals:** chạy song song nhiều lượt agent; sửa cấu trúc task trên giao diện; tạo việc Dev từ task (P3); approver theo role.

## Decisions

### D1. Tách khung chạy agent thành `server/src/devflow/agent-stage/`
- `runner.ts`: chuyển nguyên `ba/runner.ts`, đổi tên kiểu thành `StageRunner` và `StageRunResult`; `requestedByActorId` theo stage.
- `agent.ts`: cấu hình chuẩn theo tham số (`role`, tên, thư mục workspace, model, ngân sách mỗi lượt, số lượt tool, timeout, hash prompt); `denyRules(role)`; `unsafeAgentReason(agent, expected)` trả đúng các mã lỗi hiện có; `findStageAgent(db, companyId, role)` theo `metadata.devflowRole`.
- `workspace.ts`: dựng và dọn workspace, clone repo (SHA, token từ secret), dọn transcript.
- `run-loop.ts`: vòng "ghi request.md → chạy → ghi sổ chi phí → kiểm schema → chạy lại một lần kèm lỗi kiểm tra", ghi output trong giao dịch có kiểm version, chuyển sang stage review, trần USD ngày, ghi lỗi. Tham số theo stage: `stageKey`, `reviewStageKey`, `role`, tên action (`agent.<role>_run`, `_proposed`, `_failed`, `_gave_up`, `_budget_paused`), hàm dựng request.md, hàm parse, hàm dựng comment.
- `worker.ts`: worker hiện tại, tham số hóa theo service và tên log.
- `ba/` chỉ còn phần riêng của BA (prompt, schema, review, metrics, routes, start) và gọi khung chung. **Test BA hiện có phải pass mà không đổi kỳ vọng** (chỉ đổi import nếu cần); đó là thước đo "không đổi hành vi".
- Phương án bỏ: chép `ba/` thành `plan/`. Khi đó có hai bản code an toàn phải sửa song song, đúng loại rủi ro đã gặp khi sửa B-38. Cũng bỏ việc tổng quát hóa màn hình review: hai stage có trường khác nhau, lợi ích thấp.

### D2. Một lượt agent mỗi instance cho mọi stage, và chặn chéo
- Hai worker (BA, Tech Plan) dùng **chung một khóa advisory** `dr-agent-stage-worker` (thay `dr-ba-worker`). Mỗi worker giữ khóa trong cả lượt quét, nên không bao giờ có hai lượt agent cùng lúc trong instance, kể cả khi chạy nhiều server.
- Mục tiêu là cách ly **giữa các công ty**: mỗi workspace dùng chung cho cả instance, nên tại một thời điểm không biết dữ liệu trong đó của công ty nào, phải chặn cả thư mục. Agent cùng công ty cũng không đọc thư mục của nhau, vì không cần (Planner nhận spec BA qua `request.md`).
- Lớp thứ hai: danh sách chặn của mỗi agent thêm workspace và thư mục transcript của stage kia (BA chặn `/paperclip/devflow/ws/plan` và `/paperclip/.claude/projects/-paperclip-devflow-ws-plan`; Planner chặn hai thư mục tương ứng của BA). `unsafeAgentReason` đòi đủ luật, nên **agent BA hiện có phải chạy lại `setup-ba-agent.mjs`** sau khi triển khai.
- Phương án bỏ: một worker quét cả hai stage (tránh được tranh khóa nhưng gộp hai công tắc, hai trần và hai bộ đếm lỗi vào một chỗ). Hai worker tranh một khóa có thể làm Tech Plan chờ khi BA có hàng dài; chấp nhận cho pilot.

### D3. Agent Planner
- `claude_local`, `engine: cli`, `cwd = /paperclip/devflow/ws/plan`, `--tools Read,Grep,Glob`, `--disallowedTools` theo D2, `--max-budget-usd` (`DEVFLOW_PLAN_MAX_USD_PER_RUN`, mặc định 2), `maxTurnsPerRun` 80, `timeoutSec` 1200, heartbeat tắt. Model `DEVFLOW_PLAN_MODEL`, mặc định `claude-sonnet-5-5`.
- Tên "DevFlow Planner", `metadata.devflowRole = "plan"`, hash prompt `plan.v1` ghim bằng test.
- `scripts/devflow/setup-plan-agent.mjs` dùng chung phần lõi với `setup-ba-agent.mjs` (tách hàm chung, giữ nguyên cách gọi của script BA). Key Anthropic dùng lại secret công ty `devflow-ba-anthropic` nếu đã có; nếu chưa có thì tạo từ `DEVFLOW_AGENT_ANTHROPIC_API_KEY`.
- Server công bố cấu hình chuẩn ở `GET /api/companies/:id/devflow/plan-agent`, giống BA.

### D4. Đầu vào
`.devflow/request.md` (prompt `plan.v1`):
- Phần của DevFlow: mã REQ; giá trị Triage đã duyệt; danh sách hệ thống (key, thư mục, docs, SHA).
- Phần dữ liệu, nằm giữa ranh giới ngẫu nhiên vì có nguồn gốc từ requester và agent:
  - tiêu đề, mô tả, ảnh hưởng nghiệp vụ;
  - **spec BA đã duyệt** (`data.approved`: tóm tắt, mục tiêu, phạm vi, user story, tiêu chí nghiệm thu, vùng ảnh hưởng, thay đổi dữ liệu, rủi ro, câu hỏi mở);
  - phản hồi của người duyệt kế hoạch lần trước, nếu có.
- Không tìm được spec đã duyệt (case bị chuyển tay vào `tech_plan`) → lỗi `no_approved_spec`. Lỗi này xử lý như lỗi cấu hình: thử lại sau 5 phút, ghi một lần, không bỏ cuộc.

### D5. Đầu ra (Zod strict)
```
{ summary (≤800), approach (≤3000),
  tasks: 1..30 × { id: "T1".."T99", title (≤200), system, description (≤1500),
                   size: "S"|"M"|"L",
                   files: ≤20 × { path, line|null, change (≤300) },
                   dependsOn: ≤10 × id },
  dataChanges ≤10, apiChanges ≤10, testPlan 1..20, risks ≤10, openQuestions ≤10,
  confidence: "low"|"medium"|"high" }
```
- Kiểm thêm sau schema:
  - mã task không trùng;
  - `dependsOn` chỉ trỏ tới mã có trong kế hoạch, không tự trỏ, không có vòng;
  - `system` thuộc danh sách đã gán. Khi yêu cầu không có hệ thống nào, `system` phải là `null` và `files` phải rỗng;
  - `path` không ra ngoài repo (giống BA).
- Thông báo lỗi chỉ chứa tên trường và tên luật, không chứa văn bản của agent, vì nó được đưa lại cho agent ở lần thử thứ hai.
- `S`, `M`, `L` là cỡ tương đối. Prompt mô tả: S là dưới nửa ngày, M là 1 đến 2 ngày, L là trên 2 ngày hoặc cần chia nhỏ. Không quy đổi ra giờ.
- `data` = object trên kèm `repos [{system, sha}]`, `model`, `runId`, chi phí và token; `comment_text` = markdown tiếng Việt.

### D6. Duyệt ở `plan_review`
- Cùng khuôn BA review: hàng chờ, chi tiết, quyết định qua `reviewCase` của core cùng hook `beforeCommit`, 409 khi thua đua, không tự duyệt yêu cầu của chính mình.
- Trường sửa được: `summary`, `approach`, `dataChanges`, `apiChanges`, `testPlan`, `risks`, `openQuestions`, và với từng task: `title`, `description`, `size`.
- Server từ chối (422) bản sửa có danh sách task khác về mã, thứ tự, hệ thống, file hoặc phụ thuộc. `dr_overrides` ghi một dòng cho trường `tasks` (toàn bộ giá trị trước và sau) và một dòng cho mỗi trường văn bản đã đổi.
- Approve lưu kế hoạch đã duyệt ở `data.approved` (đủ trường, kể cả `files` và `confidence`), trạng thái `accepted` hoặc `overridden`. request_changes và reject đặt trạng thái `superseded`; lý do của request_changes được đưa vào request.md của lượt sau.
- Không đổi hệ thống ở `plan_review`; muốn đổi thì xử lý ở BA review.
- Board UI: trang `PlanReview` (đường dẫn `/plan-review`, số đếm trên sidebar), dùng lại hàm link trích dẫn theo SHA và nhãn lỗi của BA review. Danh sách task hiển thị theo hệ thống, kèm phụ thuộc và cỡ.

### D7. Chi phí, số liệu, thông báo
- Sổ chi phí riêng `agent.plan_run`; trần ngày `DEVFLOW_PLAN_MAX_USD_PER_DAY` (mặc định 20) tách khỏi BA. Công tắc `DEVFLOW_PLAN_ENABLED`; `DEVFLOW_WORKERS_ENABLED=false` vẫn dừng tất cả.
- `ba/metrics.ts` tham số hóa theo cặp stage và tên action để có `GET …/plan-metrics` (tỷ lệ override theo trường, quyết định, thời gian duyệt, số lượt chạy, chi phí, lỗi gần đây không kèm nội dung). Trang Plan review có panel "Quality and cost".
- Staff digest thêm hàng chờ `plan_review` (sổ `staff.notified_plan`).

## Risks / Trade-offs

- [Tách code BA làm đổi hành vi BA] → test BA hiện có là hàng rào, chạy trước mọi thay đổi khác; thêm smoke P2 trên stack thật sau khi tách.
- [Sonnet đắt và chậm hơn] → trần mỗi lượt và mỗi ngày riêng, chi phí hiện ở panel; đổi model bằng env.
- [Hai worker tranh một khóa, Tech Plan chờ BA] → đủ cho pilot; nếu thời gian chờ ở `tech_plan` tăng, chuyển sang workspace theo lượt (execution workspace của Paperclip, chưa kiểm chứng).
- [Agent viết task không bám spec đã duyệt] → prompt yêu cầu mỗi tiêu chí nghiệm thu được ít nhất một task hoặc mục test đề cập; người duyệt là chốt chặn. Không kiểm bằng máy vì đối chiếu ngữ nghĩa không đáng tin.
- [Quên chạy lại setup cho agent BA sau khi triển khai] → worker từ chối với `agent_instance_not_denied`, hiện trong lỗi gần đây; runbook ghi bước này.
- [Case đến `dev` không có ai làm] → giống `tech_plan` trước change này; requester thấy nhãn "Đang phát triển"; đúng phạm vi P2.

## Migration Plan

1. Build image, `docker compose … up -d`.
2. Chạy lại `setup-ba-agent.mjs` cho từng công ty (danh sách chặn mới), rồi chạy `setup-plan-agent.mjs` cho từng công ty.
3. Case đang nằm ở `tech_plan` (REQ-1 của RESKI) được worker nhặt ở lượt quét đầu tiên; đó là lượt chạy thật đầu tiên, cần xem chi phí.
4. Lùi lại: `DEVFLOW_PLAN_ENABLED=false` dừng Tech Plan; BA không phụ thuộc Tech Plan. Không có migration nên không cần lùi dữ liệu.

## Open Questions

- Trần mặc định 2 USD mỗi lượt cho sonnet là ước đoán (lượt BA với haiku tốn 0,013 USD). Chỉnh sau lượt chạy thật đầu tiên, chỉ là đổi env.
