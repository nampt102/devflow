## Context

Yêu cầu là `pipeline_cases` của pipeline `dev-request` nối `dr_requests` (ưu tiên, phân loại, độ khó) và hệ thống đã gán. Mỗi trang duyệt có hàng chờ riêng. Trang Cases của Paperclip (`ui/src/pages/Cases.tsx`) đã có nhóm theo trạng thái, chọn cột và lưu trạng thái xem ở `localStorage` (`paperclip:cases:<company>:view`). Đề xuất đang chờ người: `dr_agent_outputs.status = 'proposed'` của stage tương ứng.

## Decisions

**D1. Chỉ xem.** Kéo thẻ sang cột khác sẽ đi vòng qua review gate, ghi đè quyết định của người duyệt và các bước kiểm (ví dụ chặn approve khi chưa có PR). Thẻ chỉ dẫn tới trang duyệt đang chờ.

**D2. Một endpoint gom.** `GET /companies/:id/devflow/requests-board?doneLimit=50` trả mọi case chưa kết thúc và tối đa `doneLimit` case Done/Cancelled gần nhất, mỗi case: mã, tiêu đề, stage, `stageEnteredAt` (từ sự kiện chuyển stage gần nhất), ưu tiên, phân loại, hệ thống, requester, `waitingFor` (`person` khi có đề xuất `proposed` ở stage duyệt, `agent` khi ở stage làm việc), `lastFailure` (kind và thời điểm từ sổ `agent.*_failed` gần nhất nếu sau lần chạy thành công cuối). Danh sách cột lấy từ stage của pipeline công ty (theo `position`), nên đổi pipeline không cần sửa code. Quyền: staff của công ty.

**D3. Lọc ở trình duyệt.** Pilot dưới vài trăm yêu cầu đang mở; lọc và sắp xếp phía trình duyệt cho nhanh và đơn giản. Ghi giới hạn: khi vượt khoảng 1000 case đang mở thì chuyển lọc sang server.

**D4. Saved views ở `localStorage`** theo khóa `devflow:requests:<companyId>:views` (tên, bộ lọc, dạng Kanban/danh sách, cột sắp xếp), như trang Cases. Không chia sẻ, mất khi xóa dữ liệu trình duyệt; đủ cho pilot một người. View chia sẻ cần bảng mới, để change sau nếu cần.

**D5. "Chờ tôi".** Dùng `canDecide` hiện có của từng trang duyệt (vai và owner) để đánh dấu thẻ người xem quyết định được.

## Risks / Trade-offs

- Truy vấn gom nhiều bảng: giới hạn Done/Cancelled và chỉ mục hiện có trên `pipeline_cases(company_id, stage_id)`; đo khi làm.
- `stageEnteredAt` dựa vào sự kiện chuyển stage của Paperclip; case cũ thiếu sự kiện thì dùng `updated_at` (ghi rõ trên thẻ là ước lượng).

## Open Questions (mặc định nếu duyệt không trả lời)
1. Kéo thả? Mặc định **không** (D1).
2. View chia sẻ? Mặc định **không**, lưu trên trình duyệt (D4).
3. Hiện Done/Cancelled? Mặc định **có**, thu gọn, 50 cái gần nhất.
