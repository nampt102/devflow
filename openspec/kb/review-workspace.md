# Khung duyệt chung (change `redesign-review-queues`)

Trạng thái: 5 trang duyệt đã chuyển sang khung chung, typecheck và test thuần đạt; **chưa xem trên trình duyệt**, chưa có "vòng trước" (task 2.3) và chưa có link sâu trong email (3.6).

## Thành phần (`ui/src/components/review/`, `ui/src/lib/review-workspace.ts`)
- `ReviewWorkspace`: thanh trên (số chờ, mới, cũ nhất, Mine/All khi trang cung cấp `canDecide`, bộ lọc riêng của trang, sắp xếp, Metrics, `?`), hàng chờ gọn (mã, tuổi, tiêu đề, dòng phụ, **một dòng trạng thái** theo mức nặng nhất), phím `j`/`k`, mục đang mở nằm trên URL (`?case=REQ-1`, dùng `replace`), màn hình hẹp tách danh sách và chi tiết.
- `ReviewDetailFrame`: tiêu đề, hàng mục (Summary, Criteria, Checks...; chấm cảnh báo khi cần chú ý), nội dung cuộn, thanh quyết định luôn ở đáy khung (khung dính ở đầu màn hình trên desktop).
- `DecisionBar`: Request changes và Reject bên trái, Approve bên phải; ô lý do chỉ mở khi chọn Request changes hoặc Reject; **Reject hỏi xác nhận**; `a`/`r`/`x` làm như nút, không chạy khi đang gõ, giữ phím bổ trợ hoặc có hộp thoại.
- Phần thuần (`review-workspace.ts`, 8 test): mục kế tiếp sau quyết định, mục theo URL, phím, di chuyển, sắp xếp, lọc, dòng trạng thái.
- Mỗi trang (`TriageReview`, `BaReview`, `PlanReview`, `CodeReview`, `QaSignoff`) chỉ khai báo: cách tải, `statusLine`, các mục chi tiết, quy tắc chặn quyết định, văn bản. API, quyền và quy tắc nghiệp vụ không đổi; các form sửa (Triage, BA, Plan) giữ trạng thái khi đổi mục.

## Màu
Đỏ chỉ cho thứ chặn (lệnh lỗi, vấn đề mức cao, diff bị chặn, thiếu PR); lời khuyên "changes", câu hỏi mở, độ tin cậy thấp dùng màu cảnh báo nhạt kèm biểu tượng; không truyền nghĩa chỉ bằng màu.

## Còn thiếu
- 2.3 "Since last round" (cần dữ liệu vòng trước ở API chi tiết), 3.6 link `?case=` trong email nhắc, 4.1 xem trình duyệt ở 1440px và 375px, sáng và tối.
- Test UI chung có hai lỗi cũ, không liên quan: `clipboard-usage` (`ui/src/lib/portal-access.ts` ghi clipboard trực tiếp) và một test ngữ cảnh dịch.
