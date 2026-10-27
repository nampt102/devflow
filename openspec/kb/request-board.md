# Bảng yêu cầu (change `add-request-board`)

Trạng thái: server và UI xong, test đạt; **chưa xem trên trình duyệt** (task 3.3). Trang `/requests` (mục "Requests" ở sidebar) cho nhân viên: mọi yêu cầu của công ty theo stage, dạng cột hoặc danh sách. **Chỉ xem**: đổi stage chỉ qua các trang duyệt.

## Dữ liệu
`GET /companies/:id/devflow/requests-board?doneLimit=50` (`board/routes.ts`, staff): `columns` (stage của pipeline `dev-request` theo `position`) và `cards`: mã, tiêu đề, requester, stage, `stageEnteredAt` (từ sự kiện `ingested`/`transitioned` gần nhất, thiếu thì `updated_at`), ưu tiên, phân loại, độ khó, hệ thống, `waitingFor` (stage duyệt = `person`, stage làm việc = `agent`, đã xong = null), `canDecide` (dùng `reviewAccess` của stage, hỏi một lần mỗi stage), `reviewPage` (trang duyệt giữ yêu cầu), `lastFailure` (lỗi agent gần nhất **chỉ khi chưa có lượt chạy thành công sau đó**), `terminal`. Case đang mở lấy đủ; Done/Cancelled lấy `doneLimit` cái mới nhất (tối đa 200).

## Giao diện
- `ui/src/pages/Requests.tsx`: cột cuộn ngang (Done/Cancelled hẹp hơn), thẻ có tuổi trong stage, "Waiting for you" khi `canDecide`, lỗi agent; tiêu đề thẻ mở trang duyệt với `?case=`; link History; dạng danh sách xếp theo ngày tạo.
- Lọc ở trình duyệt: chữ (tiêu đề hoặc mã), ưu tiên, loại, hệ thống, requester, "Mine to decide".
- **View lưu sẵn** trong `localStorage` (`devflow:requests:<công ty>:views`), theo trình duyệt, không chia sẻ; đọc/ghi có try/catch (kho bị chặn thì trang vẫn chạy, chỉ không lưu).
- Phần thuần `lib/requests-board.ts` (6 test).

## Giới hạn
- Lọc và sắp xếp phía trình duyệt: ổn tới khoảng 1000 case mở, hơn thì chuyển lọc sang server.
- Không kéo thả, không view chia sẻ giữa nhân viên (cần bảng mới).
- Test server (4): thứ tự cột, bên chờ, quyền theo vai, lỗi agent cũ hơn lượt thành công, giới hạn Done, cách ly công ty.
