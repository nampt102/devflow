# Màn hình duyệt triage (bước 8)

Trạng thái: code + test xong (2026-10-18). Quyết định: `decisions/0017-triage-review.md`. Không có migration mới (dùng `dr_overrides`, `dr_agent_outputs` và các cột triage của `dr_requests` từ bước 3 và 5).

## API (nhân viên board, `server/src/devflow/triage-review/`)
- `GET /api/companies/:id/devflow/triage-queue`: case của pipeline `dev-request` đang ở `triage_review` và có đề xuất `proposed`, cũ nhất trước, tối đa 200. Mỗi dòng có mã REQ, tiêu đề, tuổi, **tên** requester (không email, không id tài khoản), số tệp, tóm tắt đề xuất. Case ở `triage_review` mà không có đề xuất `proposed` không hiện ở đây (xem ở hàng chờ chung `review-queue` của Paperclip).
- `GET .../triage-cases/:caseId`: yêu cầu đầy đủ, tệp đính kèm (`/api/assets/:id/content`), đề xuất đầy đủ (lý do, giả định, câu hỏi mở, cờ quy tắc), ứng viên trùng với điểm do server tính (`trigram`, `vector`) và lý do model nêu.
- `POST .../triage-cases/:caseId/decision` `{ outputId, expectedVersion, decision, reason?, final? }`; `final` chỉ cần các field đổi (`classification`, `priority`, `difficulty`, `requiresHuman`, `requiresHumanReasons`, `duplicateOfCaseId`); Zod strict.
- Quyền: chỉ board user có quyền công ty (viewer đọc được, không quyết định được); công ty khác nhận 404; agent key bị từ chối; **người gửi không duyệt được yêu cầu của chính mình**; chưa đăng nhập 401.

## Quyết định chạy nguyên tử
`pipelineService.reviewCase` có thêm tham số nội bộ `beforeCommit(tx)` (vá nhỏ ở core, không nhận từ HTTP) chạy trong cùng transaction sau bước chuyển stage. Trong đó: khóa dòng đề xuất và kiểm còn `proposed`; ghi `dr_overrides` **chỉ cho field thật sự đổi** (approve: 5 field; reject: chỉ liên kết trùng `duplicateOf`; request_changes: không có); đặt trạng thái đề xuất (approve không sửa → `accepted`, có sửa → `overridden`, các quyết định khác → `superseded`; kèm người và thời điểm); approve thì sao chép giá trị cuối vào `dr_requests`, reject-trùng thì ghi `duplicate_of_case_id`; ghi `activity_log` `triage.decided` (quyết định, tên field sửa, không có nội dung yêu cầu). Chuyển stage lỗi (xung đột version, thiếu lý do) hoặc ghi domain lỗi thì **cả hai cùng rollback** (có test dùng trigger ép lỗi).
- approve → `ba_spec` (chưa có agent BA, case chờ; requester nhận email); request_changes (bắt buộc lý do) → `triage`; reject (bắt buộc lý do) → `cancelled`; đánh dấu trùng = reject với `duplicateOfCaseId` (lý do tự điền "Duplicate of REQ-n" nếu để trống). Duyệt hai người cùng lúc: một 200, một 409 (kể cả khi người thua lọt qua các kiểm tra ban đầu và gặp lỗi "không ở review stage" của core: được đổi thành 409; lỗi này lộ ra khi chạy cả bộ test cùng lúc, có test riêng).
- **Request changes đưa lý do vào lần phân loại lại:** prompt **v3** (`prompts/triage.v3.ts`, hash ghim) thêm khối "reviewer feedback" (lý do đã làm sạch, tối đa 1000 ký tự, và tóm tắt đề xuất bị trả về), vẫn nằm trong ranh giới dữ liệu không tin cậy. Định nghĩa ưu tiên/độ khó vẫn là TEMPORARY.

## Giao diện (Board UI, `ui/src/pages/TriageReview.tsx`, tiếng Anh)
Mục "Triage review" ở sidebar (cùng cờ `enablePipelines` với Pipelines), route `/triage`. Hai khung: hàng chờ (REQ, tiêu đề, tuổi, nhãn loại/ưu tiên, "needs developer", "possible duplicate"; lọc All / Needs a developer / Possible duplicate; tự làm mới 30 giây) và chi tiết (yêu cầu, tệp, đề xuất với từng field sửa được và dòng "Agent proposed: …" khi đã sửa, ứng viên trùng với điểm và nút "Mark duplicate", ô lý do, nút Approve/Request changes/Reject). Nút bị khóa kèm chú thích khi thiếu lý do hoặc kết hợp không hợp lệ. Logic thuần ở `ui/src/lib/triage-review.ts` (7 test). `pnpm check:token-gates` vốn đã báo vi phạm cũ ở các trang khác trước khi thêm trang này; trang mới không thêm vi phạm nào.

## Giới hạn đã biết
- Chọn bản trùng chỉ trong danh sách ứng viên (chưa nhập mã REQ bất kỳ).
- Chưa có snooze, duyệt hàng loạt, role BA/Tech Lead (mọi board user không phải viewer duyệt được), claim/lease, tìm kiếm trong hàng chờ, thông báo cho nhân viên.
- Requester chỉ thấy nhãn "Không tiếp tục xử lý" cho cả reject lẫn trùng.
- UI được kiểm bằng test logic và kiểm tra thủ công trên trình duyệt; chưa có test render component. Dưới 1024px rộng, hàng chờ xếp phía trên chi tiết (phải cuộn), chưa tối ưu cho màn hình hẹp.
- **Bật trang:** cờ `enablePipelines` **không có nút trong giao diện**, chỉ bật bằng API: `PATCH /api/instance/settings/experimental` với `{"enablePipelines": true}` (admin instance). Khi tắt, `/triage` quay về Dashboard và sidebar không hiện mục Triage review.

## Kiểm chứng
Kiểm tra thủ công (2026-10-18, stack Docker, trình duyệt thật): hàng chờ 21 yêu cầu từ lần chạy Triage thật hiện đúng, lọc và chi tiết (kể cả cặp trùng REQ-2/REQ-3 được đánh dấu sẵn); duyệt REQ-8 với một chỉnh sửa (ưu tiên medium → low) cho kết quả: toast "REQ-8 approved, Corrected priority", case sang `ba_spec`, `dr_requests.priority=low`, một dòng `dr_overrides` (medium → low), đề xuất `overridden` có người quyết định, `triage.decided` trong activity.

`server/src/__tests__/devflow-triage-review.test.ts` (15 ca: hàng chờ và chi tiết cách ly công ty, approve không/có sửa, request changes và phân loại lại kèm lý do, reject, trùng, giá trị không hợp lệ, 409 và không ghi gì, rollback khi ghi domain lỗi, hai người cùng lúc, tự duyệt, viewer/agent/chưa đăng nhập/công ty khác), `devflow-triage-unit.test.ts` (prompt v3). Hồi quy: toàn bộ test `pipelines-*` và `devflow-*` (198 pass). 8 đột biến bị bắt (ghi mọi field, bỏ chặn tự duyệt, bỏ giới hạn công ty cho bản trùng và hàng chờ, sai trạng thái đề xuất, bỏ sao chép giá trị, bỏ cổng 404 đa công ty, bỏ kiểm đề xuất cũ).
