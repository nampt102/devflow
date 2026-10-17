# Quyền của requester (user nghiệp vụ) tách khỏi board

**Trạng thái: ĐỀ XUẤT, chờ chủ dự án duyệt trước khi code bước 4.** Phần "Đã kiểm chứng" là kết quả chạy thật trên stack Docker ngày 2026-10-17.

## Đã kiểm chứng (runtime + code)
- Đăng ký email/password đang **mở** (`disableSignUp` mặc định false, `requireEmailVerification: false`, `server/src/auth/better-auth.ts:273-276`). Người tự đăng ký chưa có membership.
- Người dùng đã đăng nhập nhưng không có membership: mọi route công ty trả 403/404 (`companies/:id`, `pipelines`, `cases`, `issues`, `agents`, `events`, `review-cases`, `plugins`, `adapters`, `instance/settings*`, `admin/users`); không tạo được công ty (403 "Instance admin required"); không tạo/duyệt được case (404). Cơ chế: `assertCompanyAccess` so `companyId` với `actor.companyIds` lấy từ membership (`server/src/routes/authz.ts:75-115`).
- Các route trả 200 cho người không membership chỉ là danh sách rỗng hoặc dữ liệu chung: `/api/companies` (`[]`), `/api/mcp/connections` (`[]`), `/api/board-api-keys` (`[]`), `/api/sidebar-preferences/me`, `/api/skills/available` (danh mục skill chung, không dữ liệu công ty).
- Hệ quả: board API đã tự chặn người ngoài; việc còn lại là **thêm** một bề mặt riêng cho requester, không phải khóa board.
- Role `viewer` không dùng được cho requester: viewer đọc được **mọi** case của công ty (spike).

## Lựa chọn (xem trao đổi): A kết nạp, B nơi enforce, C giao diện, D phạm vi, E chống lạm dụng
Chi tiết và khuyến nghị: xem phần trả lời của phiên 2026-10-17; sau khi duyệt sẽ chuyển thành change OpenSpec `add-intake-portal` và ADR.
