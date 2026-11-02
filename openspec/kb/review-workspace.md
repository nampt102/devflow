# Khung duyệt chung (change `redesign-review-queues`)

Trạng thái: 5 trang duyệt đã chuyển sang khung chung, có "vòng trước" (2.3) và link sâu trong email (3.6); typecheck, test server (104) và test thuần đạt; **chưa xem trên trình duyệt** (4.1).

## Thành phần (`ui/src/components/review/`, `ui/src/lib/review-workspace.ts`)
- `ReviewWorkspace`: thanh trên (số chờ, mới, cũ nhất, Mine/All khi trang cung cấp `canDecide`, bộ lọc riêng của trang, sắp xếp, Metrics, `?`), hàng chờ gọn (mã, tuổi, tiêu đề, dòng phụ, **một dòng trạng thái** theo mức nặng nhất), phím `j`/`k`, mục đang mở nằm trên URL (`?case=REQ-1`, dùng `replace`), màn hình hẹp tách danh sách và chi tiết.
- `ReviewDetailFrame`: tiêu đề, hàng mục (Summary, Criteria, Checks...; chấm cảnh báo khi cần chú ý), nội dung cuộn, thanh quyết định luôn ở đáy khung (khung dính ở đầu màn hình trên desktop).
- `DecisionBar`: Request changes và Reject bên trái, Approve bên phải; ô lý do chỉ mở khi chọn Request changes hoặc Reject; **Reject hỏi xác nhận**; `a`/`r`/`x` làm như nút, không chạy khi đang gõ, giữ phím bổ trợ hoặc có hộp thoại.
- Phần thuần (`review-workspace.ts`, 8 test): mục kế tiếp sau quyết định, mục theo URL, phím, di chuyển, sắp xếp, lọc, dòng trạng thái.
- Mỗi trang (`TriageReview`, `BaReview`, `PlanReview`, `CodeReview`, `QaSignoff`) chỉ khai báo: cách tải, `statusLine`, các mục chi tiết, quy tắc chặn quyết định, văn bản. API, quyền và quy tắc nghiệp vụ không đổi; các form sửa (Triage, BA, Plan) giữ trạng thái khi đổi mục.

## Vòng trước ("Since last round")
- 5 API chi tiết (`triage-cases`, `ba-cases`, `plan-cases`, `code-cases`, `qa-cases`) trả thêm `previousRound` (chỉ đọc, `null` ở vòng đầu), tính bởi `server/src/devflow/previous-round.ts`: đề xuất `superseded` mới nhất cùng stage, và quyết định `request_changes` (`pipeline_case_events`, `review_decided`) tạo **sau** đề xuất đó, giống `loadFeedback` mà agent dùng. Không có lý do thì `null`.
- Gồm: lý do, người và thời điểm trả về, stage trả về (`qa_signoff` khi QA trả Dev), tóm tắt cũ, và `changes` cũ → mới chỉ cho trường khác nhau: Triage (phân loại, ưu tiên, độ khó, cần dev), BA (số tiêu chí, trong/ngoài phạm vi, câu hỏi mở, độ tin cậy), Plan (số task, test plan, rủi ro, câu hỏi, độ tin cậy), Dev (lệnh lỗi, độ tin cậy, trạng thái từng task), QA (khuyến nghị, vấn đề cao, lệnh lỗi, kết quả từng tiêu chí).
- UI: `SinceLastRound` trong `ReviewDetailFrame`, hiện dưới tiêu đề ở cả 5 trang. Test: `devflow-plan-review.test.ts` (vòng đầu `null`, vòng hai có lý do và thay đổi; `roundChanges` cho Triage và QA).

## Email nhắc
Mỗi yêu cầu trong thư nhắc nhân viên (`staff-notify.ts`) có dòng link riêng `<base>/<prefix>/<trang>?case=REQ-n`; link hàng chờ chung giữ ở cuối thư.

## Màu
Đỏ chỉ cho thứ chặn (lệnh lỗi, vấn đề mức cao, diff bị chặn, thiếu PR); lời khuyên "changes", câu hỏi mở, độ tin cậy thấp dùng màu cảnh báo nhạt kèm biểu tượng; không truyền nghĩa chỉ bằng màu.

## Còn thiếu
- 4.1 xem trình duyệt ở 1440px và 375px, sáng và tối, chỉ bàn phím (cần build lại image để stack có code mới).
- `check:token-gates` báo 75 + 31 vi phạm có từ trước ở trang khác; không có ở các file khung duyệt.
- Test UI chung có hai lỗi cũ, không liên quan: `clipboard-usage` (`ui/src/lib/portal-access.ts` ghi clipboard trực tiếp) và một test ngữ cảnh dịch.
