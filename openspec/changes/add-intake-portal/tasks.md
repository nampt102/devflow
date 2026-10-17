## 1. Nền tảng (không đổi schema)

- [x] 1.1 Build lại image từ HEAD, xác nhận migration 0355 đã áp dụng (bảng `dr_*` có trong DB)
- [x] 1.2 Guard `assertRequester` + test (user không phải requester, requester bị vô hiệu, nhiều công ty)
- [x] 1.3 Service portal: gửi yêu cầu (cấp số, `ingestCase`, ghi `dr_requests`, activity, bù trừ khi lỗi) + test
- [x] 1.4 API danh sách và chi tiết với DTO allowlist + test không rò rỉ + nhãn trạng thái tiếng Việt
- [x] 1.5 Test cách ly: requester A/B, board route, user không phải requester

## 2. File đính kèm

- [x] 2.1 Upload qua portal với giới hạn size/MIME/số lượng, kiểm asset cùng công ty + test

## 3. Mời requester (cần duyệt DDL `dr_requester_invites`)

- [x] 3.1 Chủ dự án duyệt DDL (2026-10-17; điều chỉnh: bỏ `accepted_requester_id` và CHECK vì xung đột với xóa user/requester)
- [x] 3.2 Migration 0356 + API tạo/liệt kê/thu hồi link (nhân viên), chấp nhận link (requester) + test token một lần, hết hạn, thu hồi, vai trò, race
- [x] 3.3 Kiểm chứng đăng ký khi `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` (xem `kb/requester-access.md`)
- [x] 3.4 Đăng ký tài khoản qua lời mời (`POST /api/portal/invites/:token/register`, phương án A đã duyệt 2026-10-17): một giao dịch, 409 khi email có sẵn, giới hạn 10 lần/phút/IP; **chưa đóng đăng ký công khai**
- [ ] 3.5 (đề xuất, chưa làm) Cách tạo tài khoản cho nhân viên mới khi đăng ký công khai đã đóng (endpoint hoặc CLI do admin dùng); cần có trước khi bật `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`

## 4. Web portal

- [x] 4.1 Workspace `portal/` (React + Vite, chỉ tiếng Việt), lockfile sinh trong container (chỉ thêm khối importer), Dockerfile
- [x] 4.2 Màn hình: đăng nhập/chấp nhận lời mời, gửi yêu cầu, danh sách, chi tiết
- [x] 4.3 Phục vụ tĩnh `/portal` trong `app.ts` trước fallback board

## 5. Hoàn tất

- [x] 5.1 Smoke test end-to-end trên stack Docker (trình duyệt); KB `kb/intake-portal-web.md`; status; ADR 0011
