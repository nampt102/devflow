## 1. Duyệt

- [x] 1.1 Chủ dự án duyệt proposal và design (hoặc chọn mặc định ở "Open Questions"); không có DDL

## 2. Logic dùng chung

- [x] 2.1 Đọc code để chốt Open Question 1 (log xác minh agent) và quy tắc quyền owner/admin hiện có; ghi kết quả vào design
- [x] 2.2 Module thuần (so khớp approver, hợp nhất bước chuyển, quyết định create/update, so instructions) trong `packages/shared` + test; script dùng lại hoặc test đối chiếu hai bản trên cùng đầu vào

## 3. Server

- [x] 3.1 `GET …/devflow/setup-status` (agent theo vai, pipeline, runner) + test: quyền (403 người thường), từng trạng thái, công ty mới, runner không thấy

## 4. Giao diện

- [ ] 4.1 `ui/src/lib/agentSetup.ts`: chuỗi tạo/cập nhật agent qua API client (secret, môi trường runner, tạo, thăm dò `verifying`, bật, hướng dẫn, liên kết tệp) + test với API giả
- [ ] 4.2 Đồng bộ pipeline qua API client (create/sync, chỉ thêm) + test
- [ ] 4.3 Trang `/setup` (agent ×4, pipeline, runner, liên kết Systems và Roles), route, sidebar có cảnh báo cho owner/admin
- [ ] 4.4 Xem trang trên trình duyệt với công ty thử: công ty mới, agent lỗi thời, mất mạng runner

## 5. Tài liệu

- [ ] 5.1 Runbook mục 14, 15 ("hoặc ở trang Setup"), KB `setup-ui.md`, status, backlog (B-40 hoãn, CI tách), ADR nếu cần
