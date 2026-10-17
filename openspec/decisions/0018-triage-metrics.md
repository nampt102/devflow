# 0018. Số liệu triage: tính trực tiếp từ dữ liệu có sẵn, tỷ lệ override trên đề xuất được duyệt

- **Ngày:** 2026-10-18
- **Trạng thái:** đã chốt (chủ dự án yêu cầu làm tiếp theo thứ tự plan P1)
- **Người quyết định:** chủ dự án (Technical Lead)

## Quyết định
- Không thêm bảng hay cột: số liệu là truy vấn chỉ đọc trên `dr_agent_outputs`, `dr_overrides`, `pipeline_case_events`, `activity_log`, `cost_events`.
- Tỷ lệ override = đề xuất `overridden` / đề xuất được duyệt (`accepted` + `overridden`) trong cửa sổ theo `decided_at`; đề xuất bị trả về hoặc từ chối không vào mẫu số.
- Tách theo `prompt_version` để so các bản prompt.
- API chỉ cho nhân viên board; hiển thị trong trang Triage review, thu gọn mặc định.

## Hệ quả
- Mẫu nhỏ nên chưa kết luận thống kê; cần dữ liệu thật của pilot.
- Truy vấn quét theo công ty và cửa sổ, đủ cho quy mô pilot; cần chỉ mục hoặc bảng tổng hợp nếu dữ liệu lớn.
- Chi tiết: `kb/triage-metrics.md`.
