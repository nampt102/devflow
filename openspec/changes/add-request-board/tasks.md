## 1. Duyệt

- [x] 1.1 Chủ dự án duyệt proposal và design (không có DDL), hoặc chọn mặc định ở "Open Questions"

## 2. Server

- [x] 2.1 `GET …/devflow/requests-board`: case kèm trường DevFlow, stage theo `position`, `stageEnteredAt`, `waitingFor`, `lastFailure`, `canDecide`, giới hạn Done/Cancelled; test (cách ly công ty, 403, từng loại stage, lỗi agent sau/ trước lần chạy thành công, giới hạn)

## 3. Giao diện

- [x] 3.1 Helper thuần (lọc, sắp xếp, nhóm theo cột, lưu/đọc view trong localStorage có try/catch) + test
- [x] 3.2 Trang `/requests`: Kanban (cột cuộn ngang, Done/Cancelled thu gọn), danh sách, thẻ dẫn tới trang duyệt đang chờ; route, sidebar
- [ ] 3.3 Xem trên trình duyệt với dữ liệu RESKI và công ty thử, kể cả màn hình hẹp

## 4. Tài liệu

- [ ] 4.1 KB `request-board.md`, status
