## Context

Hàng chờ Triage (`triage-review/service.ts` `queue`) lấy case ở stage `triage_review` có đề xuất `triage` trạng thái `proposed`, xếp cũ trước. Số đếm sidebar và email nhân viên (`staff-notify.ts`, kind `triage`) dựa trên cùng điều kiện. Plane lưu `snoozed_till` trên bản ghi intake và một task định kỳ đưa về pending khi hết hạn (`_ref/notes/plane-reference.md`).

## Decisions

**D1. Lưu trên `dr_requests`, không đổi stage.** Hoãn là trạng thái của hàng chờ, không phải bước quy trình; đổi stage sẽ đụng pipeline, review gate và email requester. DDL đề xuất (chờ duyệt):

```sql
ALTER TABLE dr_requests
  ADD COLUMN snoozed_until timestamptz,
  ADD COLUMN snoozed_by text,
  ADD COLUMN snooze_note text;
CREATE INDEX dr_requests_snoozed_idx ON dr_requests (company_id, snoozed_until) WHERE snoozed_until IS NOT NULL;
```

**D2. Hết hạn bằng điều kiện truy vấn, không worker.** Hàng chờ và số đếm dùng `snoozed_until IS NULL OR snoozed_until <= now()`. Khi hết hạn, cột vẫn còn giá trị (lịch sử) cho tới lần hoãn sau hoặc quyết định. Quyết định (approve/reject/request_changes) xóa ba cột.

**D3. Thời điểm "quay lại" (`proposedAt` cho nhãn New và email).** Hàng chờ dùng `greatest(proposed_at, snoozed_until)` làm mốc "mới", nên yêu cầu quay lại hiện "New" và email nhân viên tính nó một lần nữa. Email gom dùng sổ `staff.notified` theo case; cần kiểm khi làm để không gửi lặp quá một lần sau khi quay lại (chưa xác nhận).

**D4. Ngày hoãn.** Giao diện gửi ngày (YYYY-MM-DD); server đổi sang 00:00 giờ Việt Nam (UTC+7) của ngày đó. Phải sau hôm nay và tối đa 90 ngày. Hoãn lại một yêu cầu đang hoãn thì ghi đè.

**D5. Quyền.** Như quyết định Triage hiện tại (staff có quyền duyệt stage `triage_review`, cùng kiểm vai). Có `expectedVersion` của case để tránh hoãn đè lên quyết định của người khác (409).

## Risks / Trade-offs

- Người duyệt hoãn mãi để tránh quyết định: số liệu thêm "đang hoãn" và tuổi yêu cầu vẫn tính từ ngày gửi.
- Requester không biết yêu cầu bị hoãn: chủ ý (Plane cũng vậy); ghi chú hoãn chỉ nhân viên thấy.

## Open Questions (mặc định nếu duyệt không trả lời)
1. Snooze cho các trang duyệt khác? Mặc định **không** (chỉ Triage, như Plane).
2. Báo requester? Mặc định **không**.
3. Tối đa 90 ngày? Mặc định **có**.
