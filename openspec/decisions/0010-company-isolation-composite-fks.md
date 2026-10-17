# 0010. Cách ly công ty ở tầng DB bằng khóa ngoại kép (id, company_id)

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt (áp dụng cho các bảng `dr_*`)
- **Người quyết định:** chủ dự án (duyệt migration #1 kèm các điều chỉnh)

## Bối cảnh
Paperclip cách ly công ty ở tầng ứng dụng (`assertCompanyAccess`), không có RLS (xem `kb/spike-pipelines.md`). Các bảng DevFlow nối nhiều bảng có `company_id` riêng (case, requester, duplicate, attachment); một lỗi code có thể nối chéo công ty.

## Quyết định
Mọi liên kết của bảng `dr_*` tới `pipeline_cases` / `dr_requesters` dùng **khóa ngoại kép** `(x_id, company_id)` trỏ tới unique index `(id, company_id)` ở bảng đích. Thêm một unique index `pipeline_cases_id_company_uq` vào bảng có sẵn (chỉ thêm index, không đổi cột). Thêm `request_number` theo công ty (bảng đếm `dr_request_counters`) để có mã `REQ-n` cho user nghiệp vụ. `dr_attachments` dùng lại bảng `assets` của Paperclip thay vì lưu metadata file riêng; `dr_requesters` trỏ tới bảng `user` của better-auth (ADR 0007).

## Lý do và hệ quả
- DB tự từ chối liên kết chéo công ty, kiểm chứng bằng test trên Postgres thật (`packages/db/src/dr-requests-migration.test.ts`).
- Hạn chế: xóa một case đang là "bản gốc" của case trùng bị chặn (FK `no action`); `dr_attachments.asset_id` chưa có khóa kép tới `assets` (assets không có unique `(id, company_id)`), nên khớp công ty giữa asset và case vẫn phải kiểm ở service.
- Phải xem lại nếu Paperclip sau này thêm RLS.
- Lưu ý khi sinh migration: drizzle-kit đặt `ADD CONSTRAINT` trước `CREATE UNIQUE INDEX` mà khóa kép cần; đã sắp xếp lại tay trong `0355_devflow_requests.sql` (có test giữ thứ tự). Các migration sau dùng khóa kép phải kiểm tra tương tự.
