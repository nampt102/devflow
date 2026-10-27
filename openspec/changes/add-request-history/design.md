## Context

Nguồn dữ liệu đã có, đều theo `company_id` và `case_id`:
- `pipeline_case_events` (`type`, `payload`): tạo case, chuyển stage, review (quyết định, lý do).
- `dr_overrides`: `field`, `agent_value`, `final_value`, `actor_user_id`, `reason`, `stage_key` (hiện ghi ở Triage; các stage sau ghi gì cần kiểm khi làm, chưa xác nhận).
- `dr_agent_outputs`: mỗi đề xuất (vai, `prompt_version`, `status` proposed/accepted/superseded, `data` có PR, model và chi phí nếu ghi).
- `activity_log`: `agent.<vai>_run|failed|gave_up|budget_paused`, `staff.notified*`, các quyết định DevFlow (`qa.decided`…).
- `dr_email_outbox`: email cho requester (loại, trạng thái gửi).

## Decisions

**D1. Gộp ở server, một endpoint.** `GET /companies/:id/devflow/requests/:caseId/history` trả `{ request, stages: [{ key, enteredAt, leftAt }], costUsd, items: [...] }` với `items` đã chuẩn hóa: `{ at, kind: "submitted"|"stage"|"decision"|"field_change"|"agent_run"|"agent_failed"|"email", actor, summary, details }`. Gộp ở server để quyền và việc ẩn dữ liệu nằm một chỗ.

**D2. Ẩn dữ liệu.** Không trả địa chỉ email, token, nội dung prompt hay transcript; `details` của lượt agent chỉ có vai, phiên bản, model, chi phí, kind lỗi, link PR. Giá trị trường hiện như đã lưu (ưu tiên, phân loại, độ khó, hệ thống, bản trùng).

**D3. Quyền.** Staff của công ty (như các trang duyệt). Requester không dùng endpoint này (portal có trang trạng thái riêng).

**D4. Trang chi tiết nối với trang hiện có.** Route `/requests/:caseKey` (đổi mã sang id qua API có sẵn). Các trang duyệt thêm link "History"; thẻ của trang Requests dẫn tới trang duyệt đang chờ, và có link phụ tới History.

**D5. Phụ thuộc thứ tự.** Làm được độc lập với `add-request-board`; nếu làm trước, mở trang từ link History ở trang duyệt.

## Risks / Trade-offs

- Yêu cầu nhiều vòng (request_changes lặp lại) có dòng thời gian dài: phân trang 200 mục, mới nhất trước.
- Dữ liệu cũ trước khi có một số sổ (ví dụ chi phí Dev) sẽ thiếu mục; trang ghi "không có dữ liệu" thay vì đoán.

## Open Questions (mặc định nếu duyệt không trả lời)
1. Requester xem lịch sử? Mặc định **không** (chỉ nhân viên).
2. Hiện nội dung đề xuất cũ (spec BA, kế hoạch trước khi sửa)? Mặc định **chỉ tóm tắt và link**, không hiện toàn văn.
