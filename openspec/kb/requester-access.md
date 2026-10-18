# Quyền của requester (user nghiệp vụ) tách khỏi board

**Trạng thái: ĐỀ XUẤT, chờ chủ dự án duyệt trước khi code bước 4.** Phần "Đã kiểm chứng" là kết quả chạy thật trên stack Docker ngày 2026-10-17.

## Đã kiểm chứng (runtime + code)
- Đăng ký email/password đang **mở** (`disableSignUp` mặc định false, `requireEmailVerification: false`, `server/src/auth/better-auth.ts:273-276`). Người tự đăng ký chưa có membership.
- Người dùng đã đăng nhập nhưng không có membership: mọi route công ty trả 403/404 (`companies/:id`, `pipelines`, `cases`, `issues`, `agents`, `events`, `review-cases`, `plugins`, `adapters`, `instance/settings*`, `admin/users`); không tạo được công ty (403 "Instance admin required"); không tạo/duyệt được case (404). Cơ chế: `assertCompanyAccess` so `companyId` với `actor.companyIds` lấy từ membership (`server/src/routes/authz.ts:75-115`).
- Các route trả 200 cho người không membership chỉ là danh sách rỗng hoặc dữ liệu chung: `/api/companies` (`[]`), `/api/mcp/connections` (`[]`), `/api/board-api-keys` (`[]`), `/api/sidebar-preferences/me`, `/api/skills/available` (danh mục skill chung, không dữ liệu công ty).
- Hệ quả: board API đã tự chặn người ngoài; việc còn lại là **thêm** một bề mặt riêng cho requester, không phải khóa board.
- Role `viewer` không dùng được cho requester: viewer đọc được **mọi** case của công ty (spike).

## Quyết định (đã duyệt 2026-10-17, ADR 0011)
A1 link mời một lần, B1 `/api/portal/*` + guard, C1 app `portal/` riêng. Change: `openspec/changes/archive/2026-10-18-add-intake-portal`. API hiện trạng: `kb/intake-portal-api.md`.

## Kiểm chứng đăng ký khi `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` (task 3.3)
Test đặc tính `server/src/__tests__/devflow-auth-signup.test.ts` (4 ca, Postgres nhúng, instance better-auth thật):
- Mặc định (mở): `signUpEmail` thành công.
- Đóng: `signUpEmail` bị từ chối **kể cả khi gọi từ server** (`auth.api`), không chỉ qua HTTP.
- Đóng: user đã có vẫn đăng nhập bình thường.
- Đóng: server vẫn tạo được tài khoản bằng `internalAdapter.createUser` + `linkAccount` (cần `issuer: "local:credential"`, cột NOT NULL ở fork này, cùng mật khẩu băm `ctx.password.hash`), và tài khoản đó đăng nhập được. Nghĩa là một endpoint đăng ký theo lời mời (task 3.4) khả thi mà không cần mở đăng ký công khai.
- Chưa kiểm chứng ở mức HTTP trên stack chạy thật, và chưa kiểm chứng ảnh hưởng của việc đóng đăng ký lên luồng bootstrap quản trị đầu tiên và lời mời board của Paperclip (instance mới cần đăng ký để nhận quyền admin; chỉ đóng sau khi đã có admin).

Hệ quả cho vận hành: trong lúc đăng ký còn mở, người lạ vẫn tạo được tài khoản nhưng không có quyền gì; link mời mới là thứ cấp quyền requester. Task 3.4 đã làm (`POST /api/portal/invites/:token/register`, xem `kb/intake-portal-api.md`) nên requester không còn cần đăng ký công khai. **Đăng ký công khai vẫn để mở** (ADR 0012) vì đóng sẽ chặn nhân viên mới nhận lời mời board (trang của Paperclip gọi `sign-up/email`); điều kiện (đã có task 3.5 và cần một instance admin) nằm ở `kb/admin-accounts.md`; bật `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`.
