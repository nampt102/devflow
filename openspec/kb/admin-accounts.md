# Tài khoản do instance admin quản lý (task 3.5)

Nguồn: `server/src/devflow/admin-accounts.ts`, `server/src/devflow/accounts.ts`, change `add-intake-portal` (design mục 10), ADR 0012. Kiểm chứng bằng `server/src/__tests__/devflow-admin-accounts.test.ts` (8 ca, Postgres nhúng, instance better-auth thật với đăng ký đóng).

## Vì sao cần
Trang đăng nhập và trang lời mời board của Paperclip đều gọi `sign-up/email`; `POST /invites/:token/accept` đòi người dùng đã đăng nhập; Paperclip không có tạo user, đổi hay đặt lại mật khẩu. Nên khi đóng đăng ký công khai, nhân viên mới không có đường vào và người quên mật khẩu không khôi phục được.

## API (chỉ instance admin; thêm điều kiện cờ ẩn `instance.access` như các route admin khác)
| Method | Path | Ghi chú |
|---|---|---|
| POST | `/api/admin/users` | Body `{name, email, companyIds?, password?}`. Tạo `user` + `account` credential. Không gửi `password` thì server sinh 24 ký tự (144 bit) và trả trong trường `password` **một lần**; có gửi thì 8–128 ký tự và không bị lặp lại. `companyIds` cấp membership `operator` đang hoạt động trong cùng giao dịch (công ty không tồn tại: 404, không tạo gì). 409 `account_exists` khi email trùng (không phân biệt hoa thường). Phản hồi `Cache-Control: no-store` |
| POST | `/api/admin/users/:userId/reset-password` | Body `{password?}` như trên. Thay hash mật khẩu và **xóa mọi phiên** của user; trả `sessionsRevoked`. 404 nếu không có user; 409 `no_credential_account` nếu user không đăng nhập bằng mật khẩu |

Agent, thành viên công ty (kể cả admin công ty) và người chưa đăng nhập: 401/403.

## Quy tắc đã kiểm chứng
- Tài khoản tạo ra đăng nhập được qua better-auth thật khi `authDisableSignUp=true`; hash mật khẩu do `hashPassword` của better-auth tạo, DB không giữ mật khẩu thô.
- Khóa advisory theo email vì `user.email` không có unique index; dùng chung với `register` qua lời mời (`devflow/accounts.ts`). 8 đột biến đều làm test fail: bỏ kiểm tra quyền, luôn trả mật khẩu, không xóa phiên, bỏ kiểm tra công ty, bỏ `no-store`, lưu mật khẩu thô khi reset, bỏ khóa email, bỏ kiểm tra email. Lưu ý: test đua của riêng route admin (2 yêu cầu đồng thời) không phải lúc nào cũng bắt được thiếu khóa; test đua 3 yêu cầu của `register` mới là chỗ bắt được.
- Cấp quyền công ty và tạo tài khoản cùng một giao dịch (`accessService(tx)` chạy như savepoint): grant lỗi thì tài khoản cũng bị hủy.
- `activity_log` bắt buộc có công ty nên sự kiện `admin.user_created` ghi theo từng công ty được cấp (chỉ chứa `companyIds`, không email hay mật khẩu). Không có công ty thì chỉ có log kỹ thuật (`logger.info`, không chứa bí mật): giới hạn đã biết.

## Quy trình đóng đăng ký công khai (ADR 0012)
1. Instance đã có admin (đăng ký mở để admin đầu tiên tạo tài khoản và "Claim this instance").
2. Bật `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` rồi khởi động lại server.
3. Nhân viên mới: admin gọi `POST /api/admin/users` (kèm `companyIds`), gửi mật khẩu qua kênh riêng. Requester: nhân viên tạo link mời portal, người nhận đăng ký qua link.
4. Quên mật khẩu: admin gọi `reset-password`.

## Chưa làm / hạn chế
- Chưa có màn hình quản trị (chỉ API); chưa gửi email; chưa buộc đổi mật khẩu lần đầu. Endpoint `change-password` của better-auth có tồn tại hay không và có an toàn để bật hay không: chưa xác nhận; giao diện cũng chưa có nên người dùng chưa tự đổi được mật khẩu.
- Chưa giới hạn tần suất riêng cho các route admin (chỉ instance admin gọi được).
- Chưa kiểm chứng ở mức HTTP trên stack chạy thật khi đóng đăng ký (xem status).
