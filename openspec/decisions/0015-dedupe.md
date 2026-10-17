# 0015. Tìm yêu cầu trùng: trigram luôn bật, vector khi có cấu hình, prompt v2

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt (chủ dự án duyệt thiết kế bước 7 và cấu hình local: vLLM cho LLM; bge-m3 qua TEI cho embedding)
- **Người quyết định:** chủ dự án (Technical Lead)

## Quyết định
- Server tìm tối đa 5 ứng viên cùng công ty rồi đưa cho model xếp hạng; model không được nêu mã nào ngoài danh sách.
- `pg_trgm` (đã có từ migration 0051) luôn dùng, bỏ dấu tiếng Việt; vector (pgvector) chỉ khi bảng `dr_embeddings` có, có cấu hình embedding và embed thành công; lùi về trigram khi thiếu bất kỳ điều kiện nào.
- Embedding mặc định dự kiến bge-m3 trên TEI local (giao thức `/v1/embeddings`); API ngoài (OpenAI, Google AI Studio) không dùng mặc định vì dữ liệu yêu cầu ở lại local; đổi chỉ cần đổi env (Google AI Studio qua endpoint tương thích OpenAI: chưa xác nhận có embeddings).
- Prompt sang v2 (v1 giữ nguyên); định nghĩa ưu tiên/độ khó vẫn tạm thời.
- Thêm `DEVFLOW_LLM_EXTRA_BODY` và cắt khối `<think>` để chạy được Qwen3 trên vLLM.

## Hệ quả
- Ngưỡng 0.3 (trigram) và 0.65 (cosine) là điểm khởi đầu, phải hiệu chỉnh bằng cặp yêu cầu trùng thật.
- Quét tuần tự theo công ty; cần chỉ mục khi dữ liệu lớn.
- Đổi model embedding là embed lại (khóa `(case_id, kind, model)` cho phép nhiều model cùng tồn tại).
- Chi tiết: `kb/triage-agent.md`.
