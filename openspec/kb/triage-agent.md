# Triage agent (bước 6, phần không phụ thuộc model)

Trạng thái: code + test xong (2026-10-17); **chưa chạy với model thật** (chưa có endpoint). Quyết định: `decisions/0014-triage-agent.md`. Bước 7 (prompt v2, dedupe) ở cuối file.

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
- Bước 7 (dedupe) đã điền danh sách ứng viên trong `triageCase` (xem cuối file); prompt đang dùng là v2.
- Bước 8 phải đánh dấu output cũ (`accepted`/`overridden`/`superseded`) khi người quyết định, nếu không worker sẽ không phân loại lại case bị `request_changes`. Lý do request_changes chưa được đưa vào prompt (việc của bước sau).
- Không dùng `pendingSuggestion` ở P1: nộp từ stage làm việc sang review không cần ai duyệt; đầu ra là nội dung để người quyết ở review stage.

## Kiểm chứng
`server/src/__tests__/devflow-triage-unit.test.ts` (25 ca: schema, quy tắc, hash, boundary, client với LLM giả) và `devflow-triage.test.ts` (19 ca trên Postgres nhúng: ghi output, agent idle + cost unpriced, cờ hợp, injection, thử lại, 429/500/timeout, đua hai worker, cách ly công ty, log không lộ nội dung, backoff/bỏ cuộc, breaker, khóa advisory). 5 đột biến (bỏ hợp cờ, bỏ strict, bỏ làm sạch boundary, bỏ bắt unique, bỏ lọc công ty) đều bị test bắt. LLM giả: `server/src/devflow/triage/fake-llm.ts` (`startFakeLlm`); chưa có script chạy riêng.

# Bước 7: tìm yêu cầu trùng (dedupe), prompt v2

Quyết định: `decisions/0015-dedupe.md`. Code: `server/src/devflow/triage/dedupe.ts`, `embed-client.ts`, `server/src/devflow/prompts/triage.v2.ts`. **Chưa chạy với model/embedding thật** (chưa có endpoint).

- Triage dùng **prompt v2** (v1 giữ nguyên, hash v1 vẫn ghim). v2 thêm khối "existing requests" do server cấp; model chỉ xếp hạng và giải thích, không tự tìm; `caseKey` ngoài danh sách bị Zod từ chối.
- **Lexical (`pg_trgm`) luôn bật**: `similarity` trên tiêu đề và trên (tiêu đề + mô tả, 1000 ký tự đầu), đã bỏ dấu tiếng Việt cả hai phía (`translate` trong SQL, `foldText` trong app); ngưỡng `DEVFLOW_DEDUPE_MIN_TRIGRAM` (0.3). Quét tuần tự trong công ty (chấp nhận ở P1).
- **Vector (pgvector)** chỉ khi: bảng `dr_embeddings` tồn tại, có `DEVFLOW_EMBED_BASE_URL` + `DEVFLOW_EMBED_MODEL`, và embed thành công; cosine ≥ `DEVFLOW_DEDUPE_MIN_VECTOR` (0.65, **điểm khởi đầu chưa hiệu chỉnh**, cần cặp trùng thật). Hợp hai danh sách, xếp theo điểm mạnh hơn, tối đa `DEVFLOW_DEDUPE_LIMIT` (5). Thiếu pgvector thì không gọi embedding (không trả tiền cho vector không lưu được).
- Phạm vi: cùng công ty, pipeline `dev-request`, loại chính nó và case `cancelled`; case `done` vẫn được xét. Không gửi thông tin người gửi. Tiêu đề và đoạn mô tả của yêu cầu cũ đi qua cùng làm sạch và khối ranh giới như dữ liệu không tin cậy.
- `dr_agent_outputs.data` giữ thêm `dedupeMode` (`trigram` | `trigram+vector`) và `candidateScores` (điểm trigram/vector của từng ứng viên) để người duyệt thấy số liệu thật, không chỉ lời model.
- Embedding: `/embeddings` kiểu OpenAI (TEI, vLLM, OpenAI). Lưu `dr_embeddings` (`ON CONFLICT … DO UPDATE` chỉ khi `content_hash` đổi). Lỗi embedding không làm hỏng triage (ghi `agent.embed_failed`, tìm ứng viên vẫn chạy bằng trigram). Worker backfill 20 yêu cầu thiếu vector mỗi lượt quét, dừng ở lỗi đầu tiên. Chi phí embedding ghi `cost_events` (`billing_code=devflow:embed`, `unpriced`).
- Qwen (vLLM): thêm `DEVFLOW_LLM_EXTRA_BODY` (JSON gộp vào request, ví dụ `{"chat_template_kwargs":{"enable_thinking":false}}`) và client tự cắt khối `<think>…</think>` ở đầu câu trả lời (khối không đóng được coi là bị cắt). **Chưa kiểm chứng với Qwen thật**; cần xem vLLM của bạn có bật reasoning parser hay không.
- Hai yêu cầu nộp gần như cùng lúc có thể không thấy nhau (chưa commit); trigram vẫn bắt được những cái đã commit.
- Kiểm chứng: 65 test (đơn vị, Postgres nhúng, và pgvector thật qua `DEVFLOW_PGVECTOR_URL`); 6 đột biến bị bắt (bỏ lọc công ty, bỏ loại `cancelled`, bỏ làm sạch ứng viên, bỏ ngưỡng trigram, bỏ lọc model/chiều vector, bỏ kiểm bảng vector).
- Chưa làm: chỉ mục HNSW/GIN, dedupe liên công ty, tự gộp, đo chất lượng với yêu cầu thật, đưa lý do `request_changes` vào prompt.

## Chạy thật lần đầu (2026-10-17, claude-haiku-5-5 qua endpoint tương thích OpenAI, 20 yêu cầu mẫu tổng hợp)
- Cấu hình chạy được: `DEVFLOW_LLM_BASE_URL=https://api.anthropic.com/v1`, `RESPONSE_FORMAT=none`, **không gửi `temperature`** (model trả 400 "deprecated"; sửa bằng `DEVFLOW_LLM_TEMPERATURE` tùy chọn, mặc định bỏ). 21/21 yêu cầu ra đề xuất hợp lệ ngay lần đầu, ~6 giây mỗi yêu cầu, trung bình 1128 token vào và 945 token ra (nhiều hơn cần cho JSON ngắn; chưa rõ model có "suy nghĩ" hay không).
- Dedupe (trigram, chưa có vector): cả 3 cặp trùng đều được cấp cho model và model nêu đúng (kể cả cặp không dấu, điểm 1.00; cặp diễn đạt khác nhau 0.38 và 0.60 đều ≥ 0.3). Ngưỡng 0.3 cho 1–2 ứng viên không liên quan (0.31–0.35) ở các yêu cầu khác; model không nêu chúng là trùng.
- Cờ "cần người làm": các ca SQL Server, sửa dữ liệu production, phân quyền, tích hợp, lương đều được gắn. Phát hiện lỗi quy tắc: bỏ dấu làm "sập" trùng "SAP", "lượng" trùng "lương", "thuê" trùng "thuế" (false positive) → sửa bằng quy tắc không bỏ dấu cho các từ này (`rules.ts`, test mới).
- Chống injection (3 yêu cầu: lệnh trong mô tả, JSON giả + boundary giả, lệnh trong trường tác động): cả 3 bị model nhận ra, bỏ qua và ghi vào `assumptions`; không có ưu tiên urgent, không có trùng giả, không ai chuyển stage ngoài `triage_review`. Mới thử 3 mẫu, chưa phải bằng chứng đủ.
- Điểm yếu thấy được: model hay chọn `medium`; yêu cầu "hỏi giờ làm việc của IT" (không phải yêu cầu phát triển) vẫn được phân loại `request`/`low`, vì schema chưa có lựa chọn "ngoài phạm vi"; `requiresHuman=true` đôi khi không kèm lý do. Cần bộ mẫu thật và người duyệt để đo.

## Đổi prompt (ví dụ thay định nghĩa ưu tiên và độ khó TEMPORARY)
Định nghĩa nằm trong khối `DEFINITIONS (TEMPORARY, ...)` của `SYSTEM_PROMPT` ở `server/src/devflow/prompts/triage.v3.ts`. Không sửa trực tiếp: test ghim hash của từng phiên bản nên sửa v3 làm test hỏng, và dữ liệu cũ (`dr_agent_outputs.prompt_version`, số liệu theo phiên bản) sẽ mất ý nghĩa. Cách đổi:
1. Sao chép `triage.v3.ts` thành `triage.v4.ts`; đổi `PROMPT_VERSION = "v4"`; sửa khối định nghĩa (bỏ chữ TEMPORARY khi đã là định nghĩa chính thức).
2. Trong `triage/triage-service.ts` đổi dòng import từ `../prompts/triage.v3.js` sang `triage.v4.js`.
3. Cập nhật test: `devflow-triage.test.ts` (`promptVersion`, import) và thêm khối ghim hash v4 trong `devflow-triage-unit.test.ts` (chạy một lần để lấy hash rồi dán vào).
4. Chạy bộ test `devflow-triage*`, build lại image. Đề xuất mới sẽ ghi `prompt_version=v4`; mục "Quality" tách tỷ lệ sửa theo phiên bản nên so được v3 với v4.
Chưa có cách đổi định nghĩa mà không build lại; nếu cần chỉnh thường xuyên, có thể đọc phần định nghĩa từ một tệp cấu hình (đề xuất làm sau khi có định nghĩa chính thức).
