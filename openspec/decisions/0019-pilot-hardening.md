# 0019. Pilot hardening: Telemetry tắt, trần token mỗi ngày, công tắc dừng worker

- **Ngày:** 2026-10-18
- **Trạng thái:** đã chốt (chủ dự án chọn "duyệt mặc định" cho thiết kế bước 10)
- **Người quyết định:** chủ dự án (Technical Lead)

## Quyết định
- **Telemetry của Paperclip tắt** trong cấu hình Docker của DevFlow (`PAPERCLIP_TELEMETRY_DISABLED=1`, mặc định trong compose override). Không đổi code telemetry (AGENTS.md mục 7 vẫn áp dụng). Đóng mục "để mở" trong status.
- **Trần token mỗi ngày mỗi công ty** (`DEVFLOW_TRIAGE_MAX_TOKENS_PER_DAY`, mặc định 500000 trong compose, 0 là tắt trong code): tính Triage và embedding trong ngày UTC từ `cost_events`; vượt thì worker bỏ qua công ty đó đến 0h UTC và ghi `agent.triage_budget_paused` một lần mỗi ngày. Lý do: chi phí hiện là `unpriced` nên ngân sách tiền của Paperclip không chặn được.
- **Công tắc dừng** `DEVFLOW_WORKERS_ENABLED=false` dừng Triage, embedding và email cùng lúc.
- Mục Quality hiển thị các lỗi gần đây (mã REQ + loại lỗi, không nội dung).
- Smoke test chấp nhận P1 (`scripts/devflow/smoke-p1.mjs`), runbook (`kb/runbook.md`), quét bí mật và diễn tập khôi phục DB đã làm và ghi kết quả vào runbook.
- Đóng đăng ký công khai chưa bật trong cấu hình: là điều kiện trong runbook (luồng bootstrap khi đóng chưa kiểm chứng).

## Hệ quả
- Trần token chặn theo lượng đã dùng, có thể vượt nhẹ vì một lượt gọi đang chạy không bị ngắt.
- Trạng thái bỏ cuộc và circuit breaker vẫn chỉ nằm trong bộ nhớ (khởi động lại để thử lại).
- Chưa có: role BA/Tech Lead, giới hạn tần suất email theo người nhận, màn hình quản trị tài khoản, đánh giá AGPL (ADR 0002), kiểm thử tải, xác nhận sao lưu tự động của Paperclip.
- Chi tiết vận hành: `kb/runbook.md`.
