## 1. Duyệt và spike

- [x] 1.1 Chủ dự án duyệt proposal, design và DDL theo mặc định (2026-10-21: Node + Python + Flutter, sonnet 5 USD/lượt và 50 USD/ngày, trần diff 3000 dòng, `tech_lead` duyệt)
- [x] 1.2 Spike runner (đạt, xem `kb/spike-p3-runner.md`): container `devflow-runner` trong compose; agent `claude_local` chạy qua execution target SSH của Paperclip (môi trường, khóa, `cwd`, `env`, transcript, `resultJson`, chi phí); ghi kết quả vào `kb/spike-p3-runner.md`. Không chạy được → dừng, trình phương án dự phòng
- [x] 1.3 Spike mạng (đạt; Flutter chưa thử): mạng nội bộ + proxy danh sách cho phép; Claude Code, `git clone`, `npm`/`pip`/`flutter pub get` đi qua proxy; host khác bị chặn
- [x] 1.4 Spike GitHub (đạt; repo RESKI không có branch protection, xem kb/spike-p3-runner.md): kiểm bảo vệ nhánh, push nhánh `devflow/*` bằng token ghi qua header, mở PR nháp, cập nhật, đóng (repo thử nghiệm)

## 2. Hệ thống (schema + API + UI)

- [x] 2.1 Migration 0361 thêm cột (kèm `allow_unprotected`) + schema Drizzle + test CHECK và cách ly công ty
- [x] 2.2 API Systems: bật Dev, token ghi (secret riêng), lệnh kiểm tra, đường dẫn cấm; token không bao giờ trả lại + test
- [x] 2.3 Trang Systems: các ô mới

## 3. Runner và agent Dev

- [x] 3.1 Dockerfile runner, service compose, mạng và proxy, script cài khóa SSH và tạo môi trường Paperclip
- [x] 3.2 Prompt `dev.v1` (hash ghim), schema strict, `request.md` (spec và kế hoạch đã duyệt, phản hồi)
- [x] 3.3 Cấu hình chuẩn và kiểm agent Dev trước mỗi lượt (môi trường runner, tool, ngân sách, hướng dẫn, prompt) + `setup-dev-agent.mjs`
- [x] 3.4 Workspace trên server (repo neo + `.paperclip-repositories/<key>`, clone đầy đủ, nhánh `devflow/<REQ>` mới hoặc làm tiếp, dọn sau mỗi case; xem design D1) — clone bằng token đọc, tạo hoặc lấy lại nhánh `devflow/<REQ>`, dọn sau mỗi case
- [x] 3.5 Kiểm diff (đường dẫn cấm, kích thước, nhị phân, đúng nhánh), kiểm bảo vệ nhánh, push bằng token ghi, mở/cập nhật PR nháp
- [x] 3.6 Dev worker trên khung `agent-stage` (khóa chung, backoff, sổ `agent.dev_run`, trần ngày) + test với runner, git và GitHub giả + đột biến

## 4. Code review

- [ ] 4.1 API hàng chờ, chi tiết, quyết định (`beforeCommit`, vai `tech_lead`, đóng PR khi reject, lý do vào lượt sau) + test
- [ ] 4.2 Cấu hình pipeline `code_review` approver `role` (`tech_lead`) qua `setup-dev-request-pipeline.mjs`
- [ ] 4.3 Trang Board UI "Code review", số đếm sidebar, số liệu và chi phí, email nhân viên `code_review`

## 5. Hoàn tất

- [ ] 5.1 Smoke thật: yêu cầu nhỏ trên repo thử nghiệm có bảo vệ nhánh → PR nháp → Code review approve
- [ ] 5.2 KB `kb/dev-stage.md`, runbook (cài runner, khóa, token ghi, bảo vệ nhánh), status, ADR
