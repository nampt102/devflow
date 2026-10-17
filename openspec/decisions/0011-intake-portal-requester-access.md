# 0011. Intake Portal: requester vào qua link mời, API `/api/portal/*`, app `portal/` riêng

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt
- **Người quyết định:** chủ dự án (chọn phương án đề xuất A1+B1+C1)

## Bối cảnh
User nghiệp vụ cần gửi và theo dõi yêu cầu bằng tiếng Việt mà không thấy board. Đã kiểm chứng (`kb/requester-access.md`): board API chặn user không có membership; đăng ký email mở, không xác minh email; role `viewer` đọc được mọi case nên không dùng cho requester.

## Quyết định
- **A1 kết nạp:** nhân viên tạo link mời một lần; token băm, hết hạn, gắn với session khi chấp nhận; không dựa vào email trùng. Bảng riêng `dr_requester_invites` (DDL chờ duyệt).
- **B1 quyền:** `/api/portal/*` cùng server, guard `assertRequester`; `companyId`/`requesterId` lấy từ `dr_requesters`; trả DTO allowlist.
- **C1 giao diện:** workspace package `portal/` (React + Vite, chỉ tiếng Việt), phục vụ tĩnh `/portal`.
- Phạm vi: gửi yêu cầu, xem danh sách/chi tiết và nhãn trạng thái tiếng Việt, bổ sung thông tin/file. Không: xem đề xuất agent, comment nội bộ, tự chọn stage/priority, tự hủy.
- Giới hạn: file ≤10 MB, ảnh/PDF/Office, ≤5 file, giới hạn tần suất gửi, chưa quét virus.

## Lý do và hệ quả
Thêm bề mặt riêng thay vì nới quyền board; thay đổi nằm ở `server`, `portal`, một bảng mới. Đánh đổi: bù trừ thay cho giao dịch duy nhất khi tạo case + `dr_requests` (xem `changes/add-intake-portal/design.md`); đổi lockfile và Dockerfile. Chi tiết và danh sách việc ở change OpenSpec `add-intake-portal`.
