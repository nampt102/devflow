# Bảng yêu cầu (change `add-request-board`)

Trạng thái: server và UI xong, test đạt; giao diện kiểu Plane (D6) và bộ lọc mới (D7) chủ dự án đã xem và duyệt trên desktop ngày 2026-11-02; **chưa xem màn hình hẹp** (task 3.3). Trang `/requests` (mục "Requests" ở sidebar) cho nhân viên: mọi yêu cầu của công ty theo stage, dạng board hoặc danh sách. **Chỉ xem**: đổi stage chỉ qua các trang duyệt.

## Dữ liệu
`GET /companies/:id/devflow/requests-board?doneLimit=50` (`board/routes.ts`, staff): `columns` (stage của pipeline `dev-request` theo `position`) và `cards`: mã, tiêu đề, requester, stage, `stageEnteredAt` (từ sự kiện `ingested`/`transitioned` gần nhất, thiếu thì `updated_at`), ưu tiên, phân loại, độ khó, hệ thống, `waitingFor` (stage duyệt = `person`, stage làm việc = `agent`, đã xong = null), `canDecide` (dùng `reviewAccess` của stage, hỏi một lần mỗi stage), `reviewPage` (trang duyệt giữ yêu cầu), `lastFailure` (lỗi agent gần nhất **chỉ khi chưa có lượt chạy thành công sau đó**), `terminal`. Case đang mở lấy đủ; Done/Cancelled lấy `doneLimit` cái mới nhất (tối đa 200).

## Giao diện (theo kiểu Plane, viết lại bằng token DevFlow, không chép code; ADR 0002)
- `ui/src/pages/Requests.tsx`: thanh công cụ (tìm, Filters, Display, Views, Board/List), hàng chip bộ lọc đang bật, "N waiting for you" bấm để lọc. Ở dạng board trang cao đúng màn hình (`--requests-page-h`), board chiếm phần còn lại.
- `components/requests/BoardColumns.tsx`: nền `bg-muted/50`, cột 320px không nền, mỗi cột tự cuộn; header có icon theo loại stage (`labels.tsx`: working xanh dương, review tím, done xanh lá, cancelled xám), số, nút thu gọn; cột thu gọn là dải 44px chữ dọc (`.devflow-vertical-text`).
- `components/requests/RequestCard.tsx`: thẻ bo góc, bóng nhẹ, cả thẻ là link (trang duyệt `?case=`, không có thì History), menu "···" (Open review, History); chip 20px: lỗi agent (đỏ), chờ (You decide nổi bật, Person, Agent), ưu tiên (`PriorityIcon`, `urgent` dùng icon `critical`), loại, hệ thống, tuổi ở stage, requester.
- `components/requests/BoardToolbar.tsx`: Filters (chọn nhiều, số lượng, ô tìm): chờ ai (me/person/agent), stage, ưu tiên, loại, hệ thống, requester, tuổi ở stage 1/3/7 ngày, có lỗi agent, ẩn Done/Cancelled. Display: thứ tự trong cột (lâu nhất ở stage, mới nhất, ưu tiên), chip hiện trên thẻ, hiện cột rỗng. Views: lưu bộ lọc, dạng xem và Display.
- Bộ lọc và dạng xem nằm trên URL (`q`, `waiting`, `stage`, `priority`, `type`, `system`, `requester`, `age`, `failing=1`, `closed=hide`, `layout=list`), gửi link là thấy đúng màn hình. Display lưu `devflow:requests:<công ty>:display`; cột thu gọn mặc định Done/Cancelled, sau khi đổi thì nhớ danh sách.
- **View lưu sẵn** trong `localStorage` (`devflow:requests:<công ty>:views`), theo trình duyệt, không chia sẻ; view cũ (giá trị đơn, `mine`) được đọc thành dạng mới; đọc/ghi có try/catch.
- Phần thuần `lib/requests-board.ts` (13 test: lọc nhiều giá trị, chờ ai, tuổi, lỗi, ẩn đóng, URL hai chiều, view cũ, sắp xếp, thu gọn, cột hiển thị, kho bị chặn).

## Giới hạn
- Lọc và sắp xếp phía trình duyệt: ổn tới khoảng 1000 case mở, hơn thì chuyển lọc sang server.
- Không kéo thả, không view chia sẻ giữa nhân viên (cần bảng mới).
- Test server (4): thứ tự cột, bên chờ, quyền theo vai, lỗi agent cũ hơn lượt thành công, giới hạn Done, cách ly công ty.
