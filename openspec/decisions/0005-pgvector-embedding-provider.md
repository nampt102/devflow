# 0005. pgvector ngay ở P1; embedding API + local theo config (D3)

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Dedupe ticket cần tìm kiếm theo ngữ nghĩa. Paperclip chỉ có tìm kiếm lexical (pg_trgm).

## Quyết định
Dùng pgvector ngay ở P1. Một lớp embedding provider đọc config: API thương mại hoặc endpoint local OpenAI-compatible (vLLM). Lưu cột model cho mỗi vector.

## Lý do và hệ quả
Vector của model khác nhau không so sánh được: đổi provider thì re-index, không trộn khi tìm. Số chiều vector chốt khi làm migration. Cần Postgres có extension vector (xem 0009). Model embedding chưa chọn.
