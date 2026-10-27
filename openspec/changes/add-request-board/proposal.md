## Why

Nhân viên chỉ thấy yêu cầu qua từng trang duyệt (Triage, BA, Plan, Code, QA): mỗi trang là một hàng chờ của một stage. Không có chỗ nào nhìn **toàn bộ** yêu cầu của công ty đang ở đâu (bao nhiêu đang chờ agent, đang chờ người, kẹt ở stage nào, cái nào già nhất). Trang Cases của Paperclip liệt kê case chung chung, không có trường DevFlow (ưu tiên, phân loại, hệ thống, requester) và không có dạng bảng cột. Plane có Kanban và **saved views** (bộ lọc lưu sẵn); đây là phần định port theo ADR 0002 mà chưa làm.

## What Changes

- **Trang Requests** (Board UI `/requests`) dạng **Kanban**: mỗi cột là một stage của pipeline `dev-request` (Triage → … → QA sign-off, cột Done và Cancelled thu gọn); thẻ có mã REQ, tiêu đề, ưu tiên, phân loại, hệ thống, requester, tuổi, thời gian ở stage hiện tại, dấu "đang chờ người" hay "đang chờ agent", và lỗi agent gần nhất nếu có.
- **Chỉ xem, không kéo thả.** Chuyển stage vẫn chỉ qua các trang duyệt (approval gate); bấm thẻ mở đúng trang duyệt đang chờ, hoặc trang lịch sử (change `add-request-history`).
- Dạng **danh sách** (bảng) cùng dữ liệu, sắp xếp theo cột.
- **Bộ lọc**: ưu tiên, phân loại, hệ thống, requester, chữ trong tiêu đề hoặc mã, "chỉ cái chờ tôi" (stage duyệt mà tôi có vai).
- **Saved views**: lưu bộ lọc + dạng hiển thị với một tên, chọn lại nhanh. Lưu **theo người dùng trên trình duyệt** (giống trang Cases của Paperclip), không chia sẻ.

## Capabilities

### New Capabilities
- `request-board`: trang xem mọi yêu cầu của công ty theo stage dạng Kanban hoặc danh sách, có bộ lọc và view lưu sẵn.

### Modified Capabilities
Không.

## Impact

- Không có migration.
- `server/src/devflow/`: một endpoint đọc `GET …/devflow/requests-board` (case của pipeline `dev-request` kèm trường DevFlow, stage, thời điểm vào stage, có đề xuất đang chờ người duyệt không, lỗi agent gần nhất), giới hạn và phân trang cho cột Done/Cancelled.
- `ui/`: trang Requests, thẻ, bộ lọc, view lưu sẵn (localStorage), sidebar.

## Ngoài phạm vi
Kéo thả để đổi stage; view chia sẻ giữa nhân viên (cần bảng mới); biểu đồ analytics (đã có số liệu ở từng trang duyệt); sửa yêu cầu từ thẻ.
