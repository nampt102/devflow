# 0006. Email thông báo đổi trạng thái cho requester ở P1 (D4)

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Ban đầu email dự kiến ở P2. Paperclip chỉ có kênh AgentMail cho agent, không có SMTP cho người.

## Quyết định
Làm ở P1 một loại mail: thông báo cho requester khi ticket đổi trạng thái. SMTP đọc từ biến môi trường; chủ dự án tự tạo/cập nhật env khi test; repo chỉ có .env.example (tên biến), không commit giá trị thật.

## Lý do và hệ quả
Các loại mail khác để P2. Thiết kế lớp kênh để thêm Teams/Zalo sau. Test tự động dùng SMTP giả.
