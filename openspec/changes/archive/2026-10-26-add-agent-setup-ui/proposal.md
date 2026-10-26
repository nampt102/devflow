## Why

Cài đặt mỗi công ty hiện phải chạy tay bằng dòng lệnh: tạo agent BA, Planner, Dev, QA (`setup-*-agent.mjs`), đồng bộ pipeline và approver (`setup-dev-request-pipeline.mjs`), và dựng runner (`setup-dev-runner.mjs`). Chủ dự án không có cách nào thấy ở màn hình admin agent nào đã sẵn sàng, agent nào lỗi thời sau nâng cấp (`agent_prompt_outdated`, `agent_tools_changed`), hay pipeline thiếu bước chuyển. Hôm nay đã mất nhiều lần thử vì agent kẹt "verifying" mà không có chỗ nào hiện nguyên nhân. Mỗi lần thêm công ty hoặc nâng cấp prompt đều phải nhờ người có terminal.

## What Changes

- **Trang "Setup"** (Board UI `/setup`, chỉ owner/admin của công ty) với danh sách kiểm:
  - **Agent BA, Planner, Dev, QA**: trạng thái (chưa tạo / cần cập nhật + lý do / đang xác minh + lý do lỗi / sẵn sàng), nút **Create** hoặc **Update**, ô dán khóa Anthropic khi công ty chưa có (hiện một lần, lưu thành secret, không hiện lại) và tùy chọn thay khóa.
  - **Pipeline `dev-request`**: trạng thái (chưa có / approver hoặc bước chuyển còn thiếu / đã khớp), nút **Create** hoặc **Sync** (chỉ thêm, không xóa; giữ nguyên hành vi script).
  - **Runner**: chỉ đọc (môi trường có không, probe còn đạt không, server có thấy máy chủ runner không). Dựng container và build image là việc hạ tầng nên **không** làm từ giao diện; trang hiện lệnh cần chạy.
  - Liên kết sang việc đã có giao diện: Systems (token ghi, bật Dev), Roles (gán vai).
- **Logic cài đặt chuyển từ script sang một module dùng chung**, gọi **đúng các API Paperclip mà script đang gọi** (secrets, agents, instructions-bundle, pipelines) bằng quyền của người đang đăng nhập; script `setup-*.mjs` giữ nguyên cách dùng. Không đặc quyền mới, không đường tắt qua kiểm tra quyền của core.
- Số cảnh báo trên sidebar khi có agent hoặc pipeline cần cập nhật.
- **Chưa làm: tự cài lại khi khởi động server (B-40).** Cần chạy phía server với quyền hệ thống, tức viết lại logic tạo agent của core (chuẩn hóa adapter config, mediated secret, phê duyệt agent mới). Đề xuất tách thành change riêng sau khi dùng trang Setup một thời gian; xem design.
- **Chưa làm: CI chạy test DevFlow (B-26).** Là hạ tầng (workflow GitHub trên repo công khai), khác bản chất; đề xuất change `add-devflow-ci` riêng.

## Capabilities

### New Capabilities
- `setup-ui`: trang Setup cho owner/admin để xem và áp cấu hình chuẩn của agent và pipeline DevFlow cho một công ty.

### Modified Capabilities
Không.

## Impact

- Không có migration và không đổi schema.
- `server/src/devflow/`: một endpoint chỉ đọc `GET …/devflow/setup-status` gom trạng thái (agent theo vai, pipeline, runner) từ các hàm kiểm đã có (`*AgentProblem`) và định nghĩa pipeline; không endpoint ghi mới.
- `ui/`: trang Setup, module `agentSetup` (các bước tạo/cập nhật qua API client), sidebar. `packages/shared` hoặc `ui/src/lib` chứa phần thuần (so khớp approver và bước chuyển) dùng chung với script để không lệch nhau.
- `scripts/devflow/`: `lib/approver-sync.mjs` và `setup-stage-agent.mjs` dùng lại module chung hoặc giữ bản sao có test đối chiếu.
- Docs: runbook mục 14, 15 thêm "hoặc làm ở trang Setup".

## Ngoài phạm vi
Dựng, build hay khởi động lại runner từ giao diện; tự cài lại khi khởi động (B-40); CI (B-26); đổi prompt hay cấu hình chuẩn của agent; tạo công ty; token ghi của hệ thống (đã có ở Systems).
