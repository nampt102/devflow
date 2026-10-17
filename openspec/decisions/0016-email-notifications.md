# 0016. Email trạng thái cho requester: outbox theo sự kiện, nodemailer

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt (chủ dự án duyệt dependency `nodemailer` và bảng `dr_email_outbox`; SMTP Gmail sẽ tạo sau)
- **Người quyết định:** chủ dự án (Technical Lead)

## Quyết định
- Bảng `dr_email_outbox` (migration 0358): mỗi sự kiện pipeline có tối đa một dòng (unique `event_id`), chủ đề và nội dung được ghi lúc xếp hàng, cô lập công ty bằng khóa ngoại kép (ADR 0010).
- Dependency mới `nodemailer` (chuẩn, hỗ trợ Gmail 465/587); không tự viết client SMTP.
- Chỉ gửi khi nhãn trạng thái tiếng Việt dành cho requester đổi; gộp các bước liên tiếp trong 60 giây thành một thư; không gửi lịch sử cũ; chỉ gửi cho requester của case; nội dung không có đề xuất Triage hay dữ liệu nội bộ.
- Lỗi chỉ lưu loại; backoff và bỏ cuộc sau 5 lần; giao hàng ít nhất một lần.

## Hệ quả
- Chưa gửi qua Gmail thật; cần tạo mật khẩu ứng dụng và thử.
- Thiếu: giới hạn tần suất theo người nhận, email cho nhân viên duyệt, HTML, hủy đăng ký.
- Chi tiết: `kb/email-notifications.md`.
