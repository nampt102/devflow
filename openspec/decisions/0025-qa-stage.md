# 0025. QA stage: agent chỉ đọc và chạy, DevFlow tính khuyến nghị, request_changes quay về Dev

- **Ngày:** 2026-10-26
- **Trạng thái:** đã chốt (chủ dự án duyệt change `add-qa-stage` theo mặc định, 2026-10-26)
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Sau Dev (ADR 0024) cần một bước kiểm trước khi coi yêu cầu xong. Dùng lại runner và khung agent-stage.

## Quyết định
- **QA chỉ đọc và chạy lệnh, không đẩy.** Sửa nhánh nếu có bị bỏ và cảnh báo; không cần token ghi, không thêm bề mặt tấn công. Kiểm **đầu nhánh hiện tại** của PR kèm cảnh báo nếu khác bản đã duyệt.
- **Tiêu chí đánh số do DevFlow gán** từ spec BA đã duyệt; báo cáo phải phán từng tiêu chí đúng một lần với bằng chứng. Khuyến nghị do **DevFlow tính** từ báo cáo (không tin lời agent): `approve` chỉ khi tất cả đạt.
- **Vai `qa`** (migration `0362` nới CHECK); sign-off nhận `qa` hoặc `tech_lead`.
- **request_changes quay về `dev`** (không về `qa`): lỗi nằm ở code. Quyết định thay thế cả đề xuất QA và đề xuất Dev để Dev nhận phản hồi kèm kết quả QA.
- approve hoàn tất yêu cầu và **không merge**; reject đóng PR (chung `closePullRequests` với Dev).
- Model `claude-sonnet-5-5`, 3 USD mỗi lượt, 20 USD mỗi ngày mỗi công ty, 40 phút.

## Hệ quả
- Tiêu chí cần giao diện hay môi trường đầy đủ thành `not_verified`; người ký thử tay.
- Số liệu "ký ngược khuyến nghị" cho biết khi nào có thể tin khuyến nghị hơn.
- Cần xem lại khi: muốn QA dựng môi trường chạy ứng dụng thật (DB, trình duyệt) hoặc cho QA đẩy test bổ sung.
