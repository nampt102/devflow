## Why

Năm trang duyệt (Triage, BA, Plan, Code, QA sign-off) là năm bản chép tay gần giống nhau (~375–560 dòng mỗi trang) nên lệch nhau dần, và cách dùng hằng ngày không tốt. Đánh giá theo `DESIGN.md` ("đang xảy ra gì, có cần tôi không, tôi làm gì") và các quy tắc UI/UX (ui-ux-pro-max: primary-action, progressive-disclosure, keyboard-nav, state-preservation, color-not-only, deep-linking):

1. **Nút quyết định ở tận cuối** một trang chi tiết rất dài: người duyệt phải cuộn qua mọi thứ mới bấm được, và không thấy nút trong lúc đọc.
2. **Sau khi quyết định, chọn lại về mục đầu tiên** chứ không sang mục kế tiếp; danh sách nhảy, mất chỗ đang làm.
3. **Màu đỏ dùng cho mọi thứ**: "Recommends changes", "high issue", "failed" cùng một màu nặng, nên không phân biệt được lời khuyên với lỗi chặn.
4. **Thẻ hàng chờ quá nhiều nhãn** (khuyến nghị, PR, lệnh lỗi, vấn đề, cảnh báo), không nhìn nhanh được; tuổi yêu cầu không nổi bật.
5. **Khối số liệu đặt trên hàng chờ** chiếm chỗ của việc chính.
6. **Ô lý do luôn hiện** kể cả khi approve; Reject (không hoàn tác) không có bước xác nhận.
7. **Không có bàn phím** (sang mục kế, quyết định), không có **link sâu** tới một yêu cầu (`?case=REQ-1`), tải lại trang là mất mục đang xem.
8. **Yêu cầu quay lại sau request_changes** không cho thấy vòng trước đã yêu cầu gì và lần này khác gì.
9. Màn hình hẹp: danh sách xếp trên chi tiết, phải cuộn rất dài.

## What Changes

- **Một khung duyệt dùng chung** (`ReviewWorkspace`) cho cả năm trang; mỗi trang chỉ khai báo phần riêng (các mục chi tiết, quy tắc chặn quyết định, văn bản). Các API hiện có giữ nguyên.
- **Bố cục ba vùng:** thanh trên (tên trang, số chờ, mục cũ nhất, lọc "Của tôi"/"Tất cả", sắp xếp, link Metrics), **hàng chờ gọn** bên trái (mã, tiêu đề, tuổi, **một** dòng trạng thái có biểu tượng), **chi tiết** bên phải với mục điều hướng trong trang (Summary · Criteria/Spec/Plan/Diff · Checks · Issues · Context) thay cho một trang cuộn dài.
- **Thanh quyết định ghim ở đáy** vùng chi tiết, luôn thấy: phụ (Request changes, Reject) bên trái, chính (Approve) bên phải, đúng quy tắc footer của `DESIGN.md`. Ô lý do **chỉ mở** khi chọn Request changes hoặc Reject; **Reject có bước xác nhận**.
- **Tự sang mục kế tiếp** sau khi quyết định; giữ vị trí cuộn của hàng chờ.
- **Phím tắt:** `j`/`k` lên xuống, `a` approve, `r` request changes, `x` reject, `?` bảng phím; không chạy khi đang gõ trong ô nhập.
- **Link sâu** `?case=REQ-n`: mở đúng mục, tải lại giữ nguyên, dùng được trong email nhắc.
- **Màu theo ý nghĩa:** khuyến nghị dùng nhãn trung tính có biểu tượng (✓ approve / ↺ changes, nền cảnh báo nhạt), **đỏ chỉ cho thứ chặn** (lệnh lỗi, vấn đề mức cao, diff bị chặn). Không truyền nghĩa chỉ bằng màu.
- **"Since last round"**: yêu cầu quay lại sau request_changes hiện lý do vòng trước và tóm tắt khác biệt (đề xuất cũ → mới).
- **Số liệu** chuyển sang ngăn riêng mở bằng link Metrics.
- **Màn hình hẹp:** hàng chờ là trang danh sách, bấm vào mở chi tiết toàn màn hình có nút quay lại; thanh quyết định vẫn ghim.
- Tuân thủ token của `ui/src/index.css` (`pnpm check:token-gates`), shadcn có sẵn, Lucide.

## Capabilities

### New Capabilities
- `review-workspace`: khung duyệt chung cho các stage duyệt của DevFlow (bố cục, thanh quyết định, phím tắt, link sâu, tự sang mục kế, màu theo ý nghĩa, vòng trước).

### Modified Capabilities
Không đổi yêu cầu nghiệp vụ của BA, Tech Plan, Dev, QA (quy tắc chặn quyết định, quyền, API giữ nguyên); chỉ đổi giao diện.

## Impact

- Không migration, không đổi API (trừ có thể thêm `previousRound` vào chi tiết nếu dữ liệu vòng trước chưa có trong phản hồi; kiểm khi làm).
- `ui/src/components/review/` (mới), năm trang `ui/src/pages/{TriageReview,BaReview,PlanReview,CodeReview,QaSignoff}.tsx` viết lại trên khung chung; helper `lib/*-review.ts` giữ nguyên.
- Email nhân viên: link sâu tới mục.

## Ngoài phạm vi
Duyệt hàng loạt; snooze (change `add-triage-snooze`); bảng Kanban (`add-request-board`); dòng thời gian đầy đủ (`add-request-history`, chỉ thêm link); đổi chữ "case/request" toàn hệ thống; giao diện portal của requester.
