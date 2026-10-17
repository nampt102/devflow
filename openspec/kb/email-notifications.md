# Email trạng thái cho requester (bước 7b)

Trạng thái: code + test xong (2026-10-17); **chưa gửi thử qua SMTP thật** (chủ dự án sẽ tạo SMTP Gmail sau). Quyết định: `decisions/0016-email-notifications.md`.

## Hành vi
- Worker quét mỗi 15 giây (`DEVFLOW_EMAIL_INTERVAL_MS`), chỉ chạy khi có `DEVFLOW_SMTP_HOST` và `DEVFLOW_SMTP_FROM`. Hai bước mỗi lượt, dưới một khóa advisory (`pg_try_advisory_xact_lock`):
  1. **Xếp hàng:** sự kiện `ingested`, `transitioned`, `transition_forced` của case pipeline `dev-request` có `dr_requests` → một dòng `dr_email_outbox` mỗi sự kiện (unique `event_id`, nên chạy lại hay nhiều instance không xếp trùng).
  2. **Gửi:** các dòng `pending` đến hạn, `FOR UPDATE SKIP LOCKED`, gửi bằng nodemailer.
- **Khi nào gửi:** khi **nhãn trạng thái tiếng Việt** (`portal/status-labels.ts`) của case đổi. Bước nội bộ giữ nguyên nhãn → `skipped` (`same_label`). Sự kiện mới hơn `DEVFLOW_EMAIL_DELAY_SECONDS` (60) được giữ lại, và trong một lượt chỉ sự kiện **mới nhất của mỗi case** được gửi (các cái trước là `skipped`/`superseded`), nên "đã tiếp nhận" rồi "đang chờ duyệt phân loại" trong vài giây chỉ ra một thư. Sự kiện cũ hơn `DEVFLOW_EMAIL_MAX_AGE_HOURS` (24) bị bỏ qua để bật email không gửi lại lịch sử.
- **Gửi cho ai:** chỉ requester của case (email tài khoản của họ); requester bị vô hiệu hóa hoặc thiếu email → `skipped` (`no_recipient`).
- **Nội dung:** tiếng Việt, văn bản thuần: mã `REQ-n`, tiêu đề (một dòng, tối đa 120 ký tự), nhãn trạng thái, link `${DEVFLOW_PORTAL_BASE_URL}/portal/requests/<số>`. Không có đề xuất Triage, mã stage nội bộ hay dữ liệu người khác. Tiêu đề không chèn được header (ký tự điều khiển bị bỏ).
- **Lỗi:** lỗi gửi chỉ lưu loại (`auth`, `connection`, `timeout`, `rejected`, `unknown`), không lưu phản hồi của server. Thử lại với backoff mũ (60 giây × 2^n, tối đa 1 giờ), bỏ cuộc sau 5 lần (`status=failed`, activity `email.failed` chỉ có loại lỗi và số lần). Lỗi `auth`/`connection`/`timeout` dừng cả lô để không dồn dập vào server.
- Giao hàng **ít nhất một lần**: server sập giữa lúc SMTP trả 250 và lúc commit có thể gửi lặp một thư.

## Cấu hình (`docker/.env.example`)
`DEVFLOW_SMTP_HOST`, `_PORT` (587; 465 khi `_SECURE=true`), `_SECURE`, `_USER`, `_PASS`, `_FROM`, `DEVFLOW_PORTAL_BASE_URL` (mặc định `PAPERCLIP_PUBLIC_URL`), `DEVFLOW_SMTP_TIMEOUT_MS`.
Gmail: bật xác minh 2 bước, tạo "mật khẩu ứng dụng", `HOST=smtp.gmail.com`, `PORT=587` (STARTTLS, `SECURE=false`) hoặc `465` với `SECURE=true`. **Chưa thử với Gmail thật.** Gmail có hạn mức gửi theo ngày (chưa xử lý; email chỉ gửi theo đổi trạng thái nên số lượng thấp).

## Dữ liệu
Migration `0358_devflow_email_outbox`: `dr_email_outbox` (khóa ngoại kép tới case và requester theo ADR 0010, `event_id` unique, `status` pending|sent|failed|skipped, CHECK `sent_at` khớp status, giới hạn độ dài). Dependency mới: `nodemailer@10.1.2` (+ `@types/nodemailer`), lockfile chỉ thêm khối của hai gói này.

## Kiểm chứng
`packages/db/src/dr-email-outbox-migration.test.ts` (6 ca) và `server/src/__tests__/devflow-email.test.ts` (12 ca: nodemailer thật + SMTP giả `devflow/email/fake-smtp.ts`): một thư cho chuỗi bước nhanh và không gửi lại, nhãn trùng, trễ/quá cũ/loại sự kiện, requester vô hiệu hóa và cách ly công ty, backoff rồi gửi được, bỏ cuộc không lộ nội dung, dừng lô khi sai đăng nhập, xác thực, hai worker và khóa advisory. 8 đột biến bị bắt (bỏ gộp, bỏ tuổi tối đa, bỏ trễ, bỏ kiểm vô hiệu hóa, bỏ nhãn trùng, bỏ dừng lô, bỏ khóa, bỏ backoff).
Chưa làm: giới hạn tần suất theo người nhận, email cho nhân viên duyệt, mẫu HTML, hủy đăng ký.
