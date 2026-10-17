## 1. Nền tảng (không đổi schema)

- [x] 1.1 Build lại image từ HEAD, xác nhận migration 0355 đã áp dụng (bảng `dr_*` có trong DB)
- [x] 1.2 Guard `assertRequester` + test (user không phải requester, requester bị vô hiệu, nhiều công ty)
- [x] 1.3 Service portal: gửi yêu cầu (cấp số, `ingestCase`, ghi `dr_requests`, activity, bù trừ khi lỗi) + test
- [x] 1.4 API danh sách và chi tiết với DTO allowlist + test không rò rỉ + nhãn trạng thái tiếng Việt
- [x] 1.5 Test cách ly: requester A/B, board route, user không phải requester

## 2. File đính kèm

- [ ] 2.1 Upload qua portal với giới hạn size/MIME/số lượng, kiểm asset cùng công ty + test

## 3. Mời requester (cần duyệt DDL `dr_requester_invites`)

- [ ] 3.1 Chủ dự án duyệt DDL
- [ ] 3.2 Migration + API tạo link (nhân viên), chấp nhận link (requester) + test token một lần/hết hạn
- [ ] 3.3 Kiểm chứng đăng ký khi `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`

## 4. Web portal

- [ ] 4.1 Workspace `portal/` (React + Vite, i18n vi), cập nhật lockfile trong container, Dockerfile
- [ ] 4.2 Màn hình: đăng nhập/chấp nhận lời mời, gửi yêu cầu, danh sách, chi tiết
- [ ] 4.3 Phục vụ tĩnh `/portal` trong `app.ts` trước fallback board

## 5. Hoàn tất

- [ ] 5.1 Smoke test end-to-end trên stack Docker; cập nhật KB/status; ADR 0011
