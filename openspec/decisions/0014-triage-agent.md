# 0014. Triage agent: client LLM mỏng, worker quét định kỳ, không dùng pendingSuggestion ở P1

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt (chủ dự án duyệt thiết kế bước 6)
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Bước 6 cần phân loại yêu cầu bằng model qua API thương mại hoặc vLLM (D6). Adapter của Paperclip bọc CLI agent, không hợp việc JSON vào/JSON ra; không có hàng đợi nền cho code lõi; `pendingSuggestion` chỉ là gợi ý chuyển stage cần người resolve.

## Quyết định
- Client `/chat/completions` bằng `fetch` (không thêm dependency), cấu hình bằng env, không đưa công cụ cho model.
- Prompt là module TypeScript có version, hash ghim bằng test; định nghĩa mức ưu tiên/độ khó **tạm thời** cho đến khi chủ dự án xác nhận.
- Đầu ra Zod strict; cờ "cần người làm" = hợp của model và quy tắc từ khóa phía server.
- Worker quét định kỳ trong server (15 giây), idempotent nhờ unique index một `proposed` mỗi stage; khóa advisory chỉ để tránh gọi model trùng giữa các instance; circuit breaker và backoff trong bộ nhớ.
- Không dùng `pendingSuggestion` ở P1: sau khi ghi `dr_agent_outputs`, hệ thống nộp case sang `triage_review` bằng actor `system` (actor `agent` đòi `runId` mà ta không có); người quyết ở review stage.
- Mỗi công ty có một agent "DevFlow Triage" idle (heartbeat tắt) chỉ để gắn chi phí (`cost_events`, `unpriced`).

## Hệ quả
- Chưa chạy với model thật; cần endpoint/model và khoảng 20 yêu cầu mẫu để đo tỷ lệ override.
- Bước 8 phải đánh dấu output đã quyết, nếu không case bị `request_changes` không được phân loại lại.
- Trạng thái thất bại (backoff, breaker, bỏ cuộc) mất khi khởi động lại server.
- Chi tiết: `kb/triage-agent.md`.
