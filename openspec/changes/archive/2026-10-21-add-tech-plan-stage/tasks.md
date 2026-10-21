## 1. Duyệt

- [x] 1.1 Chủ dự án duyệt proposal, design (D1–D7) và spec `tech-plan`

## 2. Tách khung chạy agent (không đổi hành vi BA)

- [x] 2.1 Chạy toàn bộ test BA (`devflow-ba*.test.ts`) trên code hiện tại, ghi số test làm mốc
- [x] 2.2 Tạo `server/src/devflow/agent-stage/`: chuyển `runner.ts`; `agent.ts` tham số theo role (cấu hình chuẩn, `denyRules(role)`, `unsafeAgentReason`, `findStageAgent`, thư mục transcript); `workspace.ts` (dựng, clone, dọn workspace và transcript)
- [x] 2.3 `run-loop.ts` (chạy, thử lại khi sai schema, sổ chi phí, ghi output có kiểm version, chuyển stage, trần ngày, ghi lỗi) và `worker.ts` tham số hóa; khóa chung `dr-agent-stage-worker`
- [x] 2.4 Viết lại `ba/` trên khung chung; mọi test BA ở 2.1 pass với kỳ vọng không đổi; đột biến: bỏ dọn transcript, bỏ kiểm version trước khi ghi output, bỏ một luật chặn đều bị bắt
- [x] 2.5 Luật chặn chéo theo D2 (BA chặn workspace và transcript của Tech Plan và ngược lại); test đơn vị cho cả hai role

## 3. Agent Planner và prompt

- [x] 3.1 `prompts/plan.v1.ts`: SYSTEM (chỉ đọc, an toàn dữ liệu, cách làm, định nghĩa S/M/L, mỗi tiêu chí nghiệm thu có task hoặc mục test), `buildRequestFile` có spec BA đã duyệt và phản hồi trong ranh giới, hash ghim bằng test
- [x] 3.2 `plan/schema.ts`: Zod strict theo D5; kiểm mã trùng, phụ thuộc lạ, tự trỏ, vòng, hệ thống không được gán, `system: null` khi không gán hệ thống, đường dẫn ra ngoài repo; thông báo lỗi không chứa văn bản của agent; comment markdown tiếng Việt; test đơn vị
- [x] 3.3 `plan/agent.ts` (cấu hình chuẩn D3 từ env) và route `GET …/devflow/plan-agent`; `scripts/devflow/setup-plan-agent.mjs` dùng chung lõi với `setup-ba-agent.mjs` (dùng lại secret `devflow-ba-anthropic`)

## 4. Worker Tech Plan

- [x] 4.1 `plan/plan-service.ts` trên khung chung: tìm case ở `tech_plan` chưa có đề xuất, đọc spec đã duyệt (`no_approved_spec` là lỗi cấu hình), dựng request.md, ghi output stage `tech_plan`, chuyển sang `plan_review`; test trên Postgres nhúng với runner giả (thành công, sai schema hai lần, hết ngân sách, case đã đổi stage, không có spec đã duyệt, không có hệ thống)
- [x] 4.2 Test cách ly: hai worker không chạy cùng lúc (khóa chung), trần ngày Tech Plan không chặn BA và ngược lại, công ty B không thấy dữ liệu công ty A
- [x] 4.3 `plan/start.ts` và khởi động trong `index.ts`; biến `DEVFLOW_PLAN_ENABLED`, `_MODEL`, `_MAX_USD_PER_RUN`, `_MAX_USD_PER_DAY`, `_INTERVAL_MS` trong compose và `.env.example`

## 5. Duyệt kế hoạch

- [x] 5.1 `plan/review-service.ts` và routes `plan-queue|plan-count|plan-cases/:id|…/decision`: sửa trường văn bản và tiêu đề/mô tả/cỡ task, 422 khi đổi cấu trúc task, `dr_overrides`, `data.approved`, 409 khi thua đua, không tự duyệt, lý do request_changes vào lượt sau; test gồm cách ly công ty
- [x] 5.2 Trang Board UI "Plan review" (`pages/PlanReview.tsx`, `lib/plan-review.ts`, `api/devflowPlan.ts`): hàng chờ có nhãn New, task theo hệ thống với cỡ và phụ thuộc, trích dẫn link theo SHA, sửa, approve/request_changes/reject, số đếm sidebar; test logic; `pnpm check:token-gates` không lỗi ở file mới
- [x] 5.3 Metrics `plan-metrics` (tham số hóa `ba/metrics.ts`) với panel "Quality and cost"; staff digest thêm hàng chờ `plan_review` (`staff.notified_plan`)

## 6. Kiểm chứng và tài liệu

- [x] 6.1 Typecheck server và UI; test DevFlow liên quan pass (gồm pgvector)
- [x] 6.2 Build image, chạy lại `setup-ba-agent.mjs` và chạy `setup-plan-agent.mjs` cho các công ty; lượt chạy thật cho REQ-1 của RESKI, ghi chi phí (0,178 USD). Smoke script Tech Plan: chủ dự án quyết định bỏ qua (2026-10-21); lượt chạy thật thay cho smoke
- [x] 6.3 `kb/tech-plan.md`, cập nhật `kb/ba-spec.md` (khung chung, khóa chung), runbook (biến env, bước setup), ADR mới cho Tech Plan, `status.md`
