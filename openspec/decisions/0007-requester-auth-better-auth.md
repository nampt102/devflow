# 0007. Requester dùng better-auth hiện có + role (D5)

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
User nghiệp vụ cần đăng nhập portal nhưng không được vào board. Paperclip dùng better-auth (email/password), chưa có SSO/OIDC.

## Quyết định
Dùng better-auth với role requester; requester chỉ đọc case của mình qua API portal. Thiết kế để thay bằng SSO sau.

## Lý do và hệ quả
Ít việc nhất. Cần kiểm chứng tách quyền requester khỏi board ở spike/bước 4.
