# 0012. Đăng ký qua lời mời có sẵn; đăng ký công khai giữ mở cho đến khi có cách tạo tài khoản nhân viên

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt (phương án A)
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Muốn đóng đăng ký công khai (`PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`) để người lạ không tạo được tài khoản. Đã kiểm chứng (test `devflow-auth-signup.test.ts`, task 3.3): khi đóng, `signUpEmail` bị từ chối kể cả gọi từ server, đăng nhập vẫn bình thường, server vẫn tạo được tài khoản bằng adapter nội bộ. Đọc code: trang đăng nhập và trang lời mời board của Paperclip (`ui/src/pages/Auth.tsx`, `InviteLanding.tsx`) đều gọi `/api/auth/sign-up/email`, nên đóng đăng ký cũng chặn **nhân viên mới nhận lời mời board** (chưa chạy ở mức HTTP). Instance mới cần đăng ký mở để admin đầu tiên tạo tài khoản và claim.

## Quyết định
- Làm endpoint `POST /api/portal/invites/:token/register` và giao diện nhận lời mời dùng nó (requester không cần đăng ký công khai nữa).
- **Chưa đóng đăng ký công khai.** Tài khoản không quyền hầu như vô hại (đã kiểm chứng: không đọc được dữ liệu công ty nào).
- Chỉ bật `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` sau khi có cách tạo tài khoản cho nhân viên mới (task 3.5, chưa làm) và instance đã có admin.

## Lý do và hệ quả
- Đóng ngay sẽ chặn nhân viên mới; mở thì chỉ sinh tài khoản rác. Tách thành hai bước để không phụ thuộc nhau.
- Điều kiện trước khi đóng: (1) đã có instance admin; (2) có đường tạo tài khoản nhân viên; (3) kiểm lại bằng test HTTP trên stack thật rằng nhận lời mời board và nhận lời mời portal đều chạy khi đóng.
- Rủi ro còn mở: người cầm link hợp lệ có thể dò email nào đã có tài khoản (có giới hạn tần suất 10/phút/IP, trong bộ nhớ nên không chia sẻ giữa nhiều instance); `user.email` không có unique index nên tính duy nhất dựa vào khóa advisory trong `register` và kiểm tra của better-auth.
