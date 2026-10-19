## 1. Duyệt

- [x] 1.1 Chủ dự án duyệt proposal, design và DDL (2026-10-19, theo mặc định: haiku, tiếng Việt, mọi nhân viên quản lý Systems)

## 2. Hệ thống (schema + API + UI)

- [x] 2.1 Migration `0359_devflow_systems.sql` (unique index đặt trước khóa ngoại) + schema Drizzle + 9 test cách ly công ty và CHECK; 4 đột biến bị bắt
- [ ] 2.2 API hệ thống (liệt kê, tạo, sửa, tắt; token lưu thành secret công ty) + test quyền và activity log
- [ ] 2.3 Kiểm chứng đọc giá trị secret từ code DevFlow; hàm clone nông không lưu token (`http.extraHeader`, gỡ remote) + test với repo git cục bộ
- [ ] 2.4 Trang Board UI "Systems"

## 3. Agent và worker BA

- [ ] 3.1 Prompt `ba.v1` (hash ghim), schema Zod strict, dựng `request.md` với ranh giới ngẫu nhiên, dựng `comment_text`
- [ ] 3.2 `ensureBaAgent` (claude_local, engine cli, tool đọc, danh sách chặn, ngân sách mỗi lượt, secret key) + đồng bộ khi prompt đổi
- [ ] 3.3 Worker: tìm case ở `ba_spec` chưa có đề xuất, khóa theo công ty, dựng workspace, wakeup, chờ run, đọc kết quả, phân loại lỗi theo `subtype`, chạy lại khi JSON sai, backoff, bỏ cuộc
- [ ] 3.4 Ghi `dr_agent_outputs` và chuyển `ba_spec → ba_review` (kiểm có chung giao dịch được không)
- [ ] 3.5 Trần USD mỗi ngày mỗi công ty; công tắc `DEVFLOW_WORKERS_ENABLED`
- [ ] 3.6 Test bằng adapter giả + đột biến

## 4. Gán hệ thống ở Triage

- [ ] 4.1 Prompt `triage.v4` (`suggestedSystemKeys`) + test hash và schema
- [ ] 4.2 Triage review: chọn hệ thống, ghi `dr_request_systems` khi approve + test

## 5. BA review

- [ ] 5.1 API hàng chờ, chi tiết, quyết định cho `ba_review` (dùng lại khung triage-review, `beforeCommit`, `dr_overrides`, đổi hệ thống, lý do request_changes vào lượt sau) + test
- [ ] 5.2 Trang Board UI "BA review" (trích dẫn link GitHub theo SHA), số đếm sidebar
- [ ] 5.3 Số liệu Quality cho BA (tỷ lệ override, thời gian, lỗi, chi phí) và email nhân viên gom `ba_review`

## 6. Hoàn tất

- [ ] 6.1 Smoke trên stack Docker với repo thật và key thật: yêu cầu → Triage → gán hệ thống → BA spec → BA review approve
- [ ] 6.2 KB (`kb/ba-spec.md`), runbook (biến môi trường, chi phí), status, ADR
