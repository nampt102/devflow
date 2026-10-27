## 1. Duyệt

- [x] 1.1 Chủ dự án duyệt proposal, design và DDL (3 cột + chỉ mục trên `dr_requests`), hoặc chọn mặc định ở "Open Questions"

## 2. Dữ liệu

- [x] 2.1 Migration thêm `snoozed_until`, `snoozed_by`, `snooze_note` + chỉ mục; schema Drizzle; test migration (dữ liệu cũ nguyên, cột null)

## 3. Server

- [x] 3.1 Hàng chờ, số đếm, số liệu Triage lọc yêu cầu đang hoãn; mốc "mới" = `greatest(proposed_at, snoozed_until)`; quyết định xóa trạng thái hoãn
- [x] 3.2 `POST …/triage-cases/:id/snooze` (ngày, ghi chú, `expectedVersion`), `DELETE …/snooze`, `GET …/triage-snoozed`; sổ hoạt động; test (422 ngày sai, 409 phiên bản, tự quay lại theo giờ, quyền)
- [x] 3.3 Email nhân viên bỏ yêu cầu đang hoãn và tính lại một lần khi quay lại + test

## 4. Giao diện

- [x] 4.1 Nút Snooze và hộp chọn ngày (1 ngày, 1 tuần, 1 tháng, ngày cụ thể; ghi chú), mục Snoozed với Unsnooze; test helper

## 5. Tài liệu

- [x] 5.1 KB `triage-review.md`, status, ADR nếu cần
