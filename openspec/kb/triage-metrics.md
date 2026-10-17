# Số liệu triage (bước 9)

Trạng thái: code + test xong (2026-10-18). Quyết định: `decisions/0018-triage-metrics.md`. **Không có migration**: mọi số liệu tính từ bảng đã có (`dr_agent_outputs`, `dr_overrides`, `pipeline_case_events`, `activity_log`, `cost_events`).

## API
`GET /api/companies/:id/devflow/triage-metrics?days=30` (nhân viên board, viewer đọc được; công ty khác 404; `days` mặc định 30, tối đa 365). Mã: `server/src/devflow/triage-review/metrics.ts`.

| Nhóm | Ý nghĩa | Nguồn |
|---|---|---|
| `approved` | số đề xuất được duyệt trong cửa sổ, số bị sửa, **tỷ lệ override** = bị sửa / được duyệt, tách theo phiên bản prompt | `dr_agent_outputs` (`accepted`, `overridden`, `decided_at`) |
| `fields` | mỗi field (loại, ưu tiên, độ khó, cần người, lý do cần người): số lần sửa và tỷ lệ trên số đề xuất được duyệt | `dr_overrides` |
| `commonCorrections` | cặp "agent nói gì → người chọn gì" hay gặp nhất (loại, ưu tiên, độ khó) | `dr_overrides` |
| `decisions` | số approve, reject, request_changes | sự kiện `review_decided` từ stage `triage_review` |
| `duplicates` | agent nêu trùng, người thêm trùng, đóng vì trùng | `dr_agent_outputs`, `dr_overrides`, `dr_requests` |
| `flow` | thời gian từ lúc gửi đến đề xuất đầu tiên, thời gian đề xuất chờ được quyết định, từ lúc gửi đến được duyệt (p50, p90) | mốc thời gian của case và đề xuất |
| `queue` | số đề xuất đang chờ và mốc cũ nhất | `dr_agent_outputs` `proposed` ở `triage_review` |
| `agent` | số đề xuất, lỗi, bỏ cuộc, embedding lỗi, email lỗi; số lần gọi và token vào/ra (chưa có giá tiền) | `activity_log`, `cost_events` (`devflow:triage`, `devflow:embed`) |

## Cách đọc
- Tỷ lệ override là thước đo chất lượng chính (risk 2 trong status). Chỉ tính **đề xuất được duyệt**; đề xuất bị trả về hoặc từ chối không vào mẫu số (người đã bác cả đề xuất, không phải sửa field). Nên đọc kèm số quyết định.
- Tỷ lệ theo field có mẫu số là tổng đề xuất được duyệt, nên các field cộng lại có thể vượt tỷ lệ override chung (một đề xuất sửa nhiều field).
- Tách theo `promptVersion` để so v2 với v3 (và các bản sau). Với mẫu nhỏ chưa kết luận được; chưa có ngưỡng tin cậy thống kê.
- Số không có dữ liệu trả `null` (hiện dấu "-" trên UI), không bị chia cho 0.

## Giao diện
Mục "Quality, last 30 days" ở đầu trang Triage review (thu gọn mặc định, làm mới 60 giây): các ô Waiting, Corrected, To first proposal, Time in review, Decisions, Agent problems; bảng tỷ lệ sửa theo field; các sửa đổi hay gặp; số trùng và token.

## Kiểm chứng
`server/src/__tests__/devflow-triage-metrics.test.ts` (8 ca với dữ liệu dựng tay và mốc thời gian cố định: công ty rỗng, tỷ lệ theo field/phiên bản/cửa sổ, cặp sửa đổi, quyết định và trùng, p50/p90, hàng chờ, sức khỏe agent và token, route). 7 đột biến bị bắt (bỏ lọc công ty, bỏ cửa sổ, tính cả đề xuất bị trả về, sai mẫu số, bỏ lọc stage quyết định, bỏ lọc công ty ở token, tính cả stage triage vào hàng chờ). Test UI: `lib/triage-review.test.ts`.
Chưa làm: biểu đồ theo thời gian, ngưỡng cảnh báo, xuất CSV, độ tin cậy thống kê, phân tích theo người duyệt.
