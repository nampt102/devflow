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
- Chưa kiểm chứng: lời mời **board** (không phải portal) cho người đã có tài khoản khi đăng ký đóng; chưa kiểm chứng bootstrap admin đầu tiên khi đóng (theo thiết kế phải để mở cho tới khi có admin).

## Kiểm chứng HTTP trên stack Docker thật khi `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` (2026-10-17, 15/15 pass)
Đăng ký công khai bị từ chối; admin cũ vẫn đăng nhập; admin tạo nhân viên kèm công ty (mật khẩu 24 ký tự, `no-store`); nhân viên đăng nhập và dùng được board của công ty được cấp; nhân viên không tạo được tài khoản (403); reset làm phiên cũ mất hiệu lực, mật khẩu cũ bị từ chối, mật khẩu mới dùng được; requester đăng ký qua lời mời, đăng nhập, là requester của công ty nhưng không đọc được board. Sau đó stack được trả về trạng thái mở (`PAPERCLIP_AUTH_DISABLE_SIGN_UP=false`).

**Lưu ý vận hành:** better-auth có giới hạn tần suất đăng nhập theo IP (cỡ vài lần mỗi 10 giây, bật ở chế độ authenticated). Kịch bản kiểm chứng phải giãn các lần đăng nhập (11 giây) mới hết 429. Nhiều nhân viên cùng đăng nhập từ một địa chỉ chung (NAT văn phòng) có thể gặp 429; cần theo dõi khi triển khai thật.

## Màn hình "Portal access" (A-11, 2026-10-18)
Trang trong Board UI (`ui/src/pages/PortalAccess.tsx`, route `/portal-access`, mục "Portal access" ở sidebar, cùng điều kiện hiện với Pipelines), tiếng Anh, hai tab:
- **Requester invites** (mọi nhân viên không phải viewer): bảng link mời (nhãn, trạng thái Waiting/Used/Expired/Revoked, tuổi và số ngày còn lại); "New invite link" (nhãn tùy chọn) hiện link `<origin>/portal/invite/<token>` **một lần** kèm nút Copy; "Revoke" hai bước (bấm rồi xác nhận). Dùng API có sẵn `/api/companies/:id/portal/invites`.
- **Staff accounts** (chỉ instance admin; tab ẩn với người khác, server vẫn kiểm): danh sách người của công ty (tên, email, vai trò, trạng thái; có/không có đăng nhập bằng mật khẩu), tạo tài khoản (tên, email, tùy chọn cấp quyền vào công ty hiện tại; mật khẩu do server sinh, hiện một lần kèm Copy), "Reset password" hai bước (đăng xuất mọi phiên, hiện mật khẩu mới một lần).
- Bí mật (link, mật khẩu) chỉ nằm trong bộ nhớ của trang, mất khi đổi tab hoặc đóng trang; không ghi vào bộ nhớ trình duyệt; phản hồi `Cache-Control: no-store`.
- API mới duy nhất: `GET /api/admin/users?companyId=<uuid>` (instance admin, 400 khi thiếu hoặc sai companyId, chỉ người dùng là `user` có membership trong công ty, không có hash hay mật khẩu, thêm cờ `hasPassword`). Không đổi schema.
- Không gửi link hay mật khẩu qua email (đã chọn: chỉ sao chép, B-12 là việc sau). Chưa có: vô hiệu hóa requester, mời hàng loạt, đổi vai trò, xóa tài khoản.
- Kiểm chứng: test `devflow-admin-accounts.test.ts` (ca mới: chỉ instance admin, phạm vi công ty, thứ tự theo tên, không lộ bí mật, bỏ agent), 5 test logic UI (`portal-access.test.ts`), `tsc` sạch, token gates không thêm vi phạm; 2 đột biến server bị bắt (đột biến thứ ba tương đương vì phép nối với bảng user đã loại agent).
- Kiểm tra thủ công trên stack thật (2026-10-18, trình duyệt thật): danh sách link mời cũ hiện đúng; tạo link mới hiện link `http://localhost:3100/portal/invite/...` một lần với nút Copy và không ghi gì vào bộ nhớ trình duyệt; thu hồi hai bước đổi trạng thái sang Revoked; tab Staff accounts liệt kê 5 người; tạo tài khoản qua form hiện email và mật khẩu một lần và người mới xuất hiện trong danh sách. Chưa thử Reset password trên giao diện (đã có test API) và chưa thử bằng trình đọc màn hình. Lỗi nhỏ tìm ra và sửa: "just now ago" thành "just now".
