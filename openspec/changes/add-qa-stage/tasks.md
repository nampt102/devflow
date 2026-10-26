## 1. Duyệt

- [ ] 1.1 Chủ dự án duyệt proposal, design và DDL (thêm vai `qa`), hoặc chọn mặc định ở "Open Questions"

## 2. Vai `qa` và pipeline

- [ ] 2.1 Migration đổi CHECK `dr_member_roles` thêm `qa` + schema Drizzle + test (vai `qa` ghi được, vai lạ bị từ chối, dữ liệu cũ nguyên)
- [ ] 2.2 `PIPELINE_APPROVER_ROLES` thêm `qa`; dịch vụ vai, trang Roles, `set-member-roles.mjs` nhận vai mới + test
- [ ] 2.3 `dev-request-pipeline.json`: `qa_signoff` approver `["qa", "tech_lead"]`, `requestChangesToStageKey: dev`, bước chuyển `qa_signoff → dev` (bỏ `qa_signoff → qa`); sửa test pin định nghĩa
- [ ] 2.4 `setup-dev-request-pipeline.mjs` + `lib/approver-sync.mjs`: đồng bộ thêm `requestChangesToStageKey` của `qa_signoff` và thêm bước chuyển còn thiếu (chỉ thêm); test trên định nghĩa thật, chạy lại không đổi gì

## 3. Agent QA

- [ ] 3.1 Prompt `qa.v1` (hash ghim), schema báo cáo strict (đủ mã AC đúng một lần, hệ thống đúng), dựng `request.md` (tiêu chí đánh mã AC, kế hoạch test, báo cáo Dev như dữ liệu chưa kiểm chứng) + test
- [ ] 3.2 Role `qa` trong `agent-stage` (`StageRole`, thư mục `/paperclip/devflow/ws/qa`), tham số hóa kiểm agent trên runner theo role, cấu hình chuẩn và `setup-qa-agent.mjs` + test
- [ ] 3.3 Workspace QA: `prepareDevRepo` chế độ `existingOnly` (nhánh phải có trên GitHub, lỗi `branch_missing`), đọc SHA đã duyệt và SHA đã kiểm + test với git cục bộ
- [ ] 3.4 Khuyến nghị do DevFlow tính, cảnh báo `qa_modified_branch` (HEAD sau lượt chạy khác lúc đầu) và khác SHA + test
- [ ] 3.5 QA worker trên khung `agent-stage` (khóa chung, backoff, sổ `agent.qa_run`, trần ngày, `no_qa_target`) + test với runner giả và git thật + đột biến

## 4. Ký duyệt QA

- [ ] 4.1 API hàng chờ, chi tiết, quyết định (`beforeCommit`, vai `qa` hoặc `tech_lead`, reject đóng PR dùng chung hàm với Code review, request_changes đánh dấu cả đề xuất QA và Dev `superseded`) + test
- [ ] 4.2 Dev nhận phản hồi sau QA (lý do và tiêu chí `fail`/`not_verified` của đề xuất QA) + test vòng trọn QA → Dev → QA
- [ ] 4.3 Trang Board UI "QA sign-off" (hàng chờ, chi tiết, quyết định), số đếm sidebar, số liệu và chi phí QA kèm tỷ lệ người ký ngược khuyến nghị, trang Roles có vai `qa`
- [ ] 4.4 Email nhân viên cho `qa_signoff` + test; biến `DEVFLOW_QA_*` trong compose và `.env.example`

## 5. Hoàn tất

- [ ] 5.1 Smoke thật `smoke-p4.mjs`: repo thử (RESKI) qua Dev → approve Code review → QA chạy → xem đề xuất → reject (đóng PR, xóa nhánh)
- [ ] 5.2 KB `kb/qa-stage.md`, runbook (cài agent QA, vai `qa`, đồng bộ pipeline cho công ty đã seed), status, ADR
