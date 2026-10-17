# 0004. Bảng mới nằm trong core packages/db (D2)

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Có thể đặt bảng mới trong core hoặc trong plugin DB namespace của Paperclip.

## Quyết định
Đặt trong packages/db, qua migration Drizzle (pnpm db:generate, pnpm db:migrate). Mọi bảng có company_id.

## Lý do và hệ quả
Sở hữu source lâu dài, không phụ thuộc plugin SDK. Mọi thay đổi schema cần chủ dự án duyệt trước.
