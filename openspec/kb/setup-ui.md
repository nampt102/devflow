# Trang Setup (change `add-agent-setup-ui`)

Trạng thái: code + test xong; đã thử `setup-status` trên stack thật (RESKI và công ty thử); chưa xem trang trên trình duyệt (trình duyệt của công cụ chưa đăng nhập). Thay các lệnh `setup-*.mjs` bằng trang `/setup` cho owner/admin của công ty.

## Làm gì
- **Agent BA, Planner, Dev, QA:** mỗi hàng hiện Not created / Needs update (lý do) / Verifying / Ready và một nút Create hoặc Update. Ô khóa Anthropic: chỉ cần khi công ty chưa có secret `devflow-ba-anthropic`, hoặc để thay khóa; lưu thành secret của công ty, không hiện lại, xóa khỏi bộ nhớ trang sau khi lưu.
- **Pipeline `dev-request`:** Create nếu chưa có; Sync nếu thiếu (approver theo vai, đích request_changes của `qa_signoff`, bước chuyển); chỉ thêm, không xóa.
- **Runner:** chỉ hiện (môi trường có không, server có phân giải được `devflow-runner` không) kèm lệnh `setup-dev-runner.mjs`. Không build hay khởi động container từ giao diện.
- **Sidebar:** mục Setup có số 1 khi có agent cần cập nhật hoặc pipeline lệch. Chỉ owner/admin thấy (API trả 403 cho người khác, mục ẩn).

## Cách chạy
- `GET /companies/:id/devflow/setup-status` (`setup/routes.ts`, chỉ đọc): agent theo vai (dùng lại `*AgentProblem`), pipeline (`pipeline-sync.ts`: bản TypeScript của `scripts/devflow/lib/approver-sync.mjs`, test chạy cả hai trên cùng đầu vào; trả sẵn thân PATCH/PUT và `definition` khi chưa có pipeline), runner (`environment`, `reachable`), `needsAttention`.
- Các nút chạy ở **trình duyệt** (`ui/src/lib/agent-setup.ts`) đúng chuỗi API mà script gọi (secrets, environments, agents, instructions-bundle, pipelines) bằng quyền của người đăng nhập; mọi kiểm tra quyền và phê duyệt agent mới vẫn do core xử lý. Không có endpoint ghi mới.
- Agent mới ở `verifying`: trang chờ (thăm dò `GET /agents/:id`, không gọi bật khi còn verifying) rồi mới bật; hết hạn thì hiện "Verifying, press Update again in a minute" thay vì lỗi 409.

## Giới hạn
- Lỗi xác minh agent (`test_environment_unavailable`, `harness_cwd_invalid`) chỉ ghi log server (`logger.warn`), không lưu nên trang không hiện được nguyên nhân; hiện trạng thái và gợi ý.
- Các bước không nguyên tử (tạo xong mà bật lỗi): chạy lại là khớp.
- Tự cài lại khi khởi động (B-40) và CI (B-26) **không** nằm trong change này.
- Token ghi và công tắc Dev của từng repo vẫn ở trang Systems; vai nhân viên ở Roles.

## Kiểm chứng
Test: `devflow-setup-status` (6: quyền 403, công ty mới, runner không phân giải, pipeline lệch rồi khớp, TS bằng script), `ui/src/lib/agent-setup.test.ts` (13: tạo agent gắn runner và khóa dạng tham chiếu, từ chối khi thiếu khóa, xoay khóa chỉ khi nhập, cập nhật không gửi `status`, ghi lại hướng dẫn khi đổi, chờ `verifying`, thiếu runner, pipeline create/sync/không đổi gì).

Thử thật 2026-10-26: `setup-status` trả đúng trạng thái trên stack. Công ty thử: 4 agent idle, pipeline khớp. RESKI: 4 agent idle, pipeline lệch 5 cài đặt approver (còn `any_human`) và thiếu 1 bước chuyển; Sync sẽ chuyển các stage duyệt sang vai nên cần gán vai ở Roles trước (trang có cảnh báo). Lưu ý build: file JSON định nghĩa pipeline phải được `import` (không đọc bằng đường dẫn) vì `tsc` chỉ chép JSON được import vào `dist`; bản đọc bằng đường dẫn làm server không khởi động.
