# Triage agent (bước 6, phần không phụ thuộc model)

Trạng thái: code + test xong (2026-10-17); **chưa chạy với model thật** (chưa có endpoint). Quyết định: `decisions/0014-triage-agent.md`.

## Luồng
1. Worker quét mỗi 15 giây (`DEVFLOW_TRIAGE_INTERVAL_MS`): các case của pipeline `dev-request` đang ở stage `triage`, chưa có `dr_agent_outputs` trạng thái `proposed` (cũng nhặt lại case bị `request_changes` đưa về `triage`, miễn là output cũ đã được bước 8 đánh dấu khác `proposed`).
2. Với mỗi case: dựng prompt (`server/src/devflow/prompts/triage.v1.ts`), gọi `/chat/completions`, kiểm Zod strict (`triage/schema.ts`), hợp cờ quy tắc cố định (`triage/rules.ts`), ghi `dr_agent_outputs` (`proposed`, kèm `prompt_role/version/hash`, token, độ trễ), rồi chuyển case sang `triage_review` bằng actor `system`.
3. Người duyệt ở `triage_review` (bước 8). Agent không tự duyệt được: output sai schema bị bỏ, không có công cụ nào để model gọi.

## Cấu hình (env, `docker/.env.example`)
`DEVFLOW_LLM_BASE_URL`, `DEVFLOW_LLM_MODEL` (thiếu một trong hai: worker không chạy), `DEVFLOW_LLM_API_KEY`, `DEVFLOW_LLM_TIMEOUT_MS` (60000), `DEVFLOW_LLM_MAX_OUTPUT_TOKENS` (1500), `DEVFLOW_LLM_RESPONSE_FORMAT` = `json_object` (mặc định) | `json_schema` | `none`. Một cấu hình cho cả API thương mại lẫn vLLM (D6). **Chưa xác nhận:** vLLM/nhà cung cấp cụ thể có hỗ trợ `json_schema` hay `json_object` không; nếu không, dùng `none` (prompt vẫn đòi JSON, Zod vẫn kiểm).

## Prompt có version
- `triage.v1.ts` xuất `PROMPT_ROLE`, `PROMPT_VERSION`, `PROMPT_HASH` (sha256 của system prompt + JSON Schema + khuôn user message). Test ghim hash: sửa v1 làm test fail; muốn đổi prompt thì tạo `triage.v2.ts`.
- **Định nghĩa mức ưu tiên và độ khó là tạm thời** (đánh dấu `TEMPORARY` trong prompt). Cần chủ dự án xác nhận định nghĩa của công ty; khi đổi thì sang v2.

## Chống prompt injection
- Nội dung yêu cầu là dữ liệu: nằm giữa hai dòng bắt đầu bằng boundary ngẫu nhiên mỗi lần gọi; bỏ ký tự điều khiển; chuỗi giống boundary (`DATA-<hex>`) bị thay; giới hạn độ dài; P1 chỉ gửi tên tệp đính kèm (đã làm sạch), không gửi nội dung tệp.
- Model không có công cụ. Đầu ra bị Zod `.strict()` chặn khóa lạ (`toStageKey`, `approve`...), `duplicateCandidates` chỉ được dùng caseKey server đưa vào (P1: rỗng).
- Cờ "cần người làm" tính thêm bằng quy tắc từ khóa trên server (SQL Server, production, sửa dữ liệu trực tiếp, phân quyền, tích hợp, lương/kế toán), hợp (union) với cờ của model; `data` giữ riêng `modelRequiresHumanReasons` và `ruleFlags`. Quy tắc cố ý dễ báo thừa hơn báo thiếu; danh sách từ khóa là heuristic, chỉnh khi có dữ liệu override.
- Log lỗi chỉ ghi loại lỗi, không ghi nội dung yêu cầu hay đầu ra model; thông báo lỗi Zod chỉ có đường dẫn và mã luật, không lặp lại text của model (cũng là thứ gửi lại cho model khi thử lại).

## Lỗi, thử lại, chi phí
- Một lần gọi: JSON/schema sai hoặc bị cắt (`finish_reason=length`) thì thử lại một lần (không lặp lại câu trả lời cũ). Mỗi lần gọi đều ghi usage.
- Worker: backoff mũ theo từng case (30 giây, tối đa 15 phút), 429 theo `Retry-After` (tạm dừng cả worker), **5 lỗi liên tiếp mở circuit breaker 5 phút**, một case thất bại 5 lần thì bỏ (`agent.triage_gave_up`) đến khi server khởi động lại. Trạng thái này nằm trong bộ nhớ.
- Khóa advisory (`pg_try_advisory_xact_lock`) giữ trong một giao dịch mở suốt lượt quét để chỉ một instance gọi model; tính đúng đắn dựa vào unique index "một `proposed` mỗi stage" và kiểm version khi ghi, không dựa vào khóa.
- `activity_log`: `agent.triage_proposed`, `agent.triage_failed`, `agent.triage_gave_up` (details: loại lỗi, số lần, phiên bản prompt).
- Chi phí: mỗi công ty có một agent "DevFlow Triage" (`agents`, `status=idle`, `runtimeConfig.heartbeat.enabled=false`, `metadata.devflowRole=triage`) chỉ để gắn `cost_events` (`usage_kind=agent`, `cost_status=unpriced`, `cost_cents=0`: có token thật, không bịa giá). Xác nhận bằng đọc code: `parseHeartbeatPolicy` mặc định `enabled=false` nên scheduler bỏ qua; **chưa chạy scheduler thật để kiểm**.

## Liên quan bước sau
- Bước 7 (dedupe) điền `candidateCaseKeys` trong `triageCase`; hiện luôn rỗng.
- Bước 8 phải đánh dấu output cũ (`accepted`/`overridden`/`superseded`) khi người quyết định, nếu không worker sẽ không phân loại lại case bị `request_changes`. Lý do request_changes chưa được đưa vào prompt (việc của bước sau).
- Không dùng `pendingSuggestion` ở P1: nộp từ stage làm việc sang review không cần ai duyệt; đầu ra là nội dung để người quyết ở review stage.

## Kiểm chứng
`server/src/__tests__/devflow-triage-unit.test.ts` (25 ca: schema, quy tắc, hash, boundary, client với LLM giả) và `devflow-triage.test.ts` (19 ca trên Postgres nhúng: ghi output, agent idle + cost unpriced, cờ hợp, injection, thử lại, 429/500/timeout, đua hai worker, cách ly công ty, log không lộ nội dung, backoff/bỏ cuộc, breaker, khóa advisory). 5 đột biến (bỏ hợp cờ, bỏ strict, bỏ làm sạch boundary, bỏ bắt unique, bỏ lọc công ty) đều bị test bắt. LLM giả: `server/src/devflow/triage/fake-llm.ts` (`startFakeLlm`); chưa có script chạy riêng.
