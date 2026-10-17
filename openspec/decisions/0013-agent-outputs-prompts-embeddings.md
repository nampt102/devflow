# 0013. Đầu ra agent, override và embedding: prompt dạng file, embedding tạo có điều kiện

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt (chủ dự án duyệt thiết kế migration #2)
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Bước 5 cần nơi lưu đề xuất có cấu trúc của agent, phần người sửa và vector cho dedupe (ADR 0005). Đã kiểm chứng: Postgres nhúng (DB của mọi test và của `pnpm dev` mặc định) không có pgvector nên `CREATE EXTENSION vector` không điều kiện làm hỏng mọi test; Paperclip không còn lưu phiên bản prompt (`agent_instruction_revisions` là di sản, thay bằng "persistent agent files"); `pipeline-case-outputs` chỉ là read model gom tài liệu của issue.

## Quyết định
- **Migration 0357** thêm `dr_agent_outputs` (đề xuất có cấu trúc theo stage, kèm `prompt_role/version/hash`), `dr_overrides` (chỉ phần khác biệt, một dòng mỗi field) và `dr_embeddings`. Cô lập công ty bằng khóa ngoại kép như ADR 0010.
- **Không có `dr_prompts`.** Prompt là file có version trong repo (`server/src/devflow/prompts/`, sẽ tạo ở bước 6); mỗi đầu ra ghi `prompt_role`, `prompt_version` và `prompt_hash` (sha256). Khi người không phải dev cần sửa prompt trên giao diện thì thêm bảng sau.
- **`dr_embeddings` chỉ được tạo nơi pgvector có sẵn**: migration kiểm `pg_available_extensions` trong một khối `DO` rồi mới `CREATE EXTENSION` và tạo bảng. Cột `vector` **không cố định số chiều** (một dòng mỗi case, loại, model); chỉ mục HNSW tạo riêng cho từng model bằng biểu thức ép kiểu số chiều sau khi chọn model. P1 chỉ embed nội dung yêu cầu (`kind = 'request'`).
- Mỗi stage của mỗi case có tối đa một đề xuất `proposed` (unique có điều kiện); `data` là object ≤ 64 KB, `comment_text` ≤ 20.000 ký tự; `accepted` và `overridden` bắt buộc ghi người và thời điểm quyết định.

## Hệ quả
- Code dùng embedding (bước 7) phải kiểm `to_regclass('dr_embeddings')` và lùi về tìm kiếm chữ (pg_trgm) khi thiếu.
- Test embedding chạy trên DB pgvector thật, bỏ qua nếu thiếu: `DEVFLOW_PGVECTOR_URL=postgres://paperclip:paperclip@localhost:5432/postgres` (tạo DB tạm, áp dụng toàn bộ migration, xóa sau khi xong). Test trên Postgres nhúng chứng minh migration vẫn áp dụng sạch khi không có pgvector.
- Cần quyền tạo extension: user mặc định của image Docker là superuser nên được; trên Postgres quản lý cần extension được phép (chưa xác nhận).
- Xóa agent hoặc run thì đầu ra giữ lại với `agent_id`/`run_id` rỗng (set null); xóa case xóa luôn đầu ra, override và embedding của nó. Chưa thử đường set null với agent thật (cần dựng bản ghi agent).
