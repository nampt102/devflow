# Lịch sử yêu cầu (change `add-request-history`)

Trạng thái: server và UI xong, test đạt; **chưa xem trên trình duyệt** (task 3.3). Trang chỉ đọc cho nhân viên: `/requests/<mã>` (ví dụ `/requests/REQ-1`), mở từ link "History" ở 5 trang duyệt.

## Dữ liệu
`GET /companies/:id/devflow/requests/:caseRef/history` (`history/routes.ts`; `:caseRef` là mã REQ hoặc id; staff của công ty; yêu cầu công ty khác trả 404) gộp:
- `pipeline_case_events`: gửi yêu cầu (`ingested`), chuyển stage (`transitioned`), quyết định (`review_decided`, kèm người và lý do);
- `dr_overrides`: trường người duyệt sửa so với agent ("priority: medium → high", lý do, người sửa);
- `dr_agent_outputs`: mỗi đề xuất (vai, phiên bản prompt, trạng thái) và link PR (`repos[].prUrl`);
- `activity_log` (`agent.<vai>_run|failed|gave_up|budget_paused`, `entity_id` là case): lượt chạy, **chi phí** (`costUsd`), lỗi;
- `dr_email_outbox`: email gửi requester (tiêu đề, trạng thái; **không có địa chỉ và nội dung**).
Phần thuần `history/build.ts` chuẩn hóa mục, tính tổng chi phí và thời gian ở từng stage (từ `ingested` và `transitioned`), lấy 200 mục mới nhất. Ẩn: địa chỉ email, nội dung thư, token, prompt, transcript, diff (test kiểm các chuỗi bí mật không xuất hiện).

## Giao diện
`ui/src/pages/RequestHistory.tsx`: đầu trang (yêu cầu, phân loại, stage hiện tại), chi phí agent (tổng và theo vai), thời gian ở từng stage, dòng thời gian (lọc "Everything" hoặc "Decisions and changes"). Helper thuần `lib/request-history.ts` (test).

## Giới hạn
- Yêu cầu cũ trước khi có sổ chạy agent (`agent.*_run`) thiếu mục chi phí; trang ghi "no agent has run yet" thay vì đoán.
- Chưa hiện nội dung đề xuất cũ (chỉ tóm tắt và link); requester không xem được trang này.
- `dr_overrides` hiện chỉ do các trang duyệt có sửa trường ghi (Triage, BA, Plan); Code và QA không sửa nên không có mục "Changed".
