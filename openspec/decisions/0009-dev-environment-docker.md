# 0009. Môi trường dev bằng Docker (D8)

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Build script của Paperclip dùng lệnh kiểu Unix; Windows cần Git Bash/WSL. Cần Postgres có pgvector (0005).

## Quyết định
Dev chạy trong Docker; Postgres dùng image có extension vector (vd pgvector/pgvector) thay cho embedded Postgres.

## Lý do và hệ quả
AGENTS.md của Paperclip nói dev dùng PGlite nhưng DevFlow dùng Docker Postgres. Bước 0 phải kiểm tra docker/ và Dockerfile; có thể cần compose riêng.
