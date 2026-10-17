# 0017. Màn hình duyệt triage: trang trong Board UI, quyết định nguyên tử qua hook của core

- **Ngày:** 2026-10-18
- **Trạng thái:** đã chốt (chủ dự án chọn "duyệt mặc định")
- **Người quyết định:** chủ dự án (Technical Lead)

## Quyết định
- Giao diện là trang mới trong `ui/` hiện có (nhân viên đã đăng nhập ở đó, không thêm package), tiếng Anh như Board UI; dữ liệu yêu cầu giữ tiếng Việt.
- API riêng `/api/companies/:id/devflow/triage-*` cho nhân viên board; không mở cho requester hay agent.
- Vá nhỏ ở core `pipelineService.reviewCase`: tham số nội bộ `beforeCommit(tx)` để ghi override, giá trị cuối và trạng thái đề xuất trong cùng transaction với quyết định.
- Chỉ field đổi mới thành `dr_overrides`; không sửa thì đề xuất là `accepted`.
- Đánh dấu trùng = reject kèm `duplicate_of_case_id`.
- Request changes đưa lý do của người duyệt vào lần phân loại lại: prompt v3.
- Người gửi không được duyệt yêu cầu của chính mình.

## Hệ quả
- Core `pipelines.ts` có thêm 4 dòng so với upstream (cần ghi nhớ khi gộp thay đổi của Paperclip).
- Chưa có role BA/Tech Lead, snooze, duyệt hàng loạt; requester không phân biệt reject và trùng.
- Số liệu tỷ lệ override (bước 9) đọc từ `dr_overrides` và `dr_agent_outputs.status`.
- Chi tiết: `kb/triage-review.md`.
