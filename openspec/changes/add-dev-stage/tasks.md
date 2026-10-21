## 1. Duyệt và spike

- [ ] 1.1 Chủ dự án duyệt proposal, design và DDL (`dr_systems` thêm `dev_enabled`, `write_token_secret_id`, `test_command`, `forbidden_paths`)
- [ ] 1.2 Spike runner: container `devflow-runner` trong compose; agent `claude_local` chạy qua execution target SSH của Paperclip (môi trường, khóa, `cwd`, `env`, transcript, `resultJson`, chi phí); ghi kết quả vào `kb/spike-p3-runner.md`. Không chạy được → dừng, trình phương án dự phòng
- [ ] 1.3 Spike mạng: mạng nội bộ + proxy danh sách cho phép; Claude Code, `git clone`, `npm`/`pip`/`flutter pub get` đi qua proxy; host khác bị chặn
- [ ] 1.4 Spike GitHub: kiểm bảo vệ nhánh, push nhánh `devflow/*` bằng token ghi qua header, mở PR nháp, cập nhật, đóng (repo thử nghiệm)

## 2. Hệ thống (schema + API + UI)

- [ ] 2.1 Migration thêm cột + schema Drizzle + test CHECK và cách ly công ty
- [ ] 2.2 API Systems: bật Dev, token ghi (secret riêng), lệnh kiểm tra, đường dẫn cấm; token không bao giờ trả lại + test
- [ ] 2.3 Trang Systems: các ô mới

## 3. Runner và agent Dev

- [ ] 3.1 Dockerfile runner, service compose, mạng và proxy, script cài khóa SSH và tạo môi trường Paperclip
- [ ] 3.2 Prompt `dev.v1` (hash ghim), schema strict, `request.md` (spec và kế hoạch đã duyệt, phản hồi)
- [ ] 3.3 Cấu hình chuẩn và kiểm agent Dev trước mỗi lượt (môi trường runner, tool, ngân sách, hướng dẫn, prompt) + `setup-dev-agent.mjs`
- [ ] 3.4 Workspace trên runner: clone bằng token đọc, tạo hoặc lấy lại nhánh `devflow/<REQ>`, dọn sau mỗi case
- [ ] 3.5 Kiểm diff (đường dẫn cấm, kích thước, nhị phân, đúng nhánh), kiểm bảo vệ nhánh, push bằng token ghi, mở/cập nhật PR nháp
- [ ] 3.6 Dev worker trên khung `agent-stage` (khóa chung, backoff, sổ `agent.dev_run`, trần ngày) + test với runner, git và GitHub giả + đột biến

## 4. Code review

- [ ] 4.1 API hàng chờ, chi tiết, quyết định (`beforeCommit`, vai `tech_lead`, đóng PR khi reject, lý do vào lượt sau) + test
- [ ] 4.2 Cấu hình pipeline `code_review` approver `role` (`tech_lead`) qua `setup-dev-request-pipeline.mjs`
- [ ] 4.3 Trang Board UI "Code review", số đếm sidebar, số liệu và chi phí, email nhân viên `code_review`

## 5. Hoàn tất

- [ ] 5.1 Smoke thật: yêu cầu nhỏ trên repo thử nghiệm có bảo vệ nhánh → PR nháp → Code review approve
- [ ] 5.2 KB `kb/dev-stage.md`, runbook (cài runner, khóa, token ghi, bảo vệ nhánh), status, ADR
