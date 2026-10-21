# Tech Plan (P2, change `add-tech-plan-stage`)

Trạng thái: code + test xong (2026-10-20); chưa build image và chưa chạy thật trên stack. Quyết định: `decisions/0022-tech-plan-stage.md` (và 0020, 0021 cho phần chung với BA).

## Luồng
BA review approve → stage `tech_plan` → worker Tech Plan chạy agent "DevFlow Planner" trên bản clone của các hệ thống đã gán, với spec BA **đã duyệt** (`data.approved`) → đề xuất kế hoạch (`dr_agent_outputs`, stage `tech_plan`) → stage `plan_review` → nhân viên duyệt (sửa, approve, request_changes, reject) → approve sang `dev` (chưa có agent Dev).

## Khung dùng chung với BA (`server/src/devflow/agent-stage/`)
- `agent.ts`: cấu hình chuẩn theo role (`ba`, `plan`), `denyRules(role)`, kiểm agent trước mỗi lượt, tìm agent của công ty theo `metadata.devflowRole`.
- `workspace.ts`: thư mục `/paperclip/devflow/ws/<role>` (dọn trước/sau mỗi case, kể cả transcript Claude Code), clone nông các hệ thống.
- `run-loop.ts`: một case (đọc ngữ cảnh, dựng `request.md`, chạy, thử lại một lần khi JSON sai, sổ `agent.<role>_run`, ghi đề xuất có kiểm version, chuyển sang stage review, trần ngày).
- `worker.ts`: quét định kỳ, backoff, bỏ cuộc sau 3 lần, breaker; **khóa advisory chung `dr-agent-stage-worker`** nên BA và Tech Plan không bao giờ chạy cùng lúc.
- `metrics.ts`: chất lượng, chi phí, luồng theo stage.

## Agent Planner và an toàn
- Tạo bằng `node scripts/devflow/setup-plan-agent.mjs --company <id>` (cấu hình chuẩn từ `GET /api/companies/:id/devflow/plan-agent`; lõi chung với `setup-ba-agent.mjs` ở `scripts/devflow/lib/setup-stage-agent.mjs`; dùng lại secret `devflow-ba-anthropic`).
- Giống BA: `engine: cli`, chỉ `Read,Grep,Glob`, chặn đường dẫn nhạy cảm, `--max-budget-usd` (mặc định 2), 80 lượt tool, 20 phút. Thêm **chặn chéo**: Planner không đọc được `/paperclip/devflow/ws/ba` và transcript của nó; BA không đọc được `/paperclip/devflow/ws/plan` và transcript của nó.
- Sau khi triển khai bản này phải **chạy lại `setup-ba-agent.mjs`** cho mọi công ty (luật chặn của BA đổi), nếu không worker BA từ chối với `agent_instance_not_denied`.

## Prompt và đầu ra (`prompts/plan.v1.ts`, `plan/schema.ts`)
- `request.md`: phân loại đã duyệt, hệ thống được gán (thư mục, docs, commit), yêu cầu, **spec BA đã duyệt** và phản hồi của người duyệt, mỗi phần nằm giữa ranh giới ngẫu nhiên mỗi lượt.
- Đầu ra JSON strict: `summary`, `approach`, `tasks` (1 đến 30; `id` T1..T99, `system`, `title`, `description`, `size` S/M/L, `files` {path, line, change}, `dependsOn`), `dataChanges`, `apiChanges`, `testPlan` (ít nhất 1), `risks`, `openQuestions`, `confidence`. Bị từ chối nếu mã task trùng, phụ thuộc lạ, tự trỏ, có vòng, hệ thống không được gán, đường dẫn ra ngoài repo; không gán hệ thống thì mọi task `system: null` và không có file.
- Cỡ: S dưới nửa ngày, M một đến hai ngày, L trên hai ngày. Mỗi tiêu chí nghiệm thu của spec phải có task hoặc mục test.

## Duyệt kế hoạch (`plan/review-service.ts`, trang `/plan-review`)
API `GET …/devflow/plan-queue|plan-count|plan-metrics|plan-cases/:id|plan-agent`, `POST …/plan-cases/:id/decision`. Cùng khung với BA review (quyết định nguyên tử, 409 khi thua đua, không tự duyệt, 404 khi không có quyền với công ty). Duyệt kế hoạch đòi vai `tech_lead` (hoặc owner; ADR 0023), chi tiết trả `canDecide` và `requiredRoles`, thiếu vai thì nút tắt và API 403. Sửa được tóm tắt, hướng giải quyết, thay đổi dữ liệu/API, kế hoạch test, rủi ro, câu hỏi mở, và tiêu đề/mô tả/cỡ của từng task; thêm, bớt, đổi thứ tự task trả 422. Override ghi theo trường (`tasks` là một trường), kế hoạch đã duyệt ở `data.approved`. Trang hiện spec BA đã duyệt để đối chiếu, task theo hệ thống với cỡ và phụ thuộc, file trích dẫn link theo SHA. Email nhân viên có thư riêng (`staff.notified_plan`).

## Biến môi trường
`DEVFLOW_PLAN_MODEL` (mặc định `claude-sonnet-5-5`), `DEVFLOW_PLAN_MAX_USD_PER_RUN` (2), `DEVFLOW_PLAN_MAX_USD_PER_DAY` (20 trong compose; sổ `agent.plan_run`, tách khỏi BA), `DEVFLOW_PLAN_INTERVAL_MS`, `DEVFLOW_PLAN_ENABLED`; dùng chung `DEVFLOW_AGENT_WORKSPACE_ROOT`, `DEVFLOW_WORKERS_ENABLED`.

## Kiểm chứng
Test tự động (trong container): `devflow-plan-unit` (prompt ghim hash, schema, chặn chéo), `devflow-plan` (service và worker trên Postgres nhúng: thành công, sai schema hai lần, không có spec đã duyệt, không hệ thống, case đổi stage, phản hồi, khóa chung với BA, trần ngày tách, cách ly công ty), `devflow-plan-review` (hàng chờ, chi tiết, quyết định, override task, 422, 409, cách ly), `devflow-staff-notify`; UI `plan-review`. Đột biến bị bắt: bỏ dọn transcript, bỏ kiểm version, bỏ chặn chéo.

## Giới hạn đã biết
- Tuần tự toàn instance cho mọi stage.
- Cỡ S/M/L là ước lượng của agent, chưa hiệu chỉnh với thực tế.
- Chưa có agent Dev: case dừng ở `dev` sau khi duyệt kế hoạch.
