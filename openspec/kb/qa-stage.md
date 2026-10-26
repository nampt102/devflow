# QA stage (P4, change `add-qa-stage`)

Trạng thái: code + test xong; **chưa chạy thật** (smoke 5.1 chờ dựng lại image và một lượt thật trên RESKI). Quyết định: `decisions/0025-qa-stage.md`. Dùng lại hạ tầng Dev: `kb/dev-stage.md`.

## Luồng
Code review approve → stage `qa` → worker QA, với từng hệ thống có PR của Dev: dựng workspace trên server **chỉ từ nhánh PR đã có** (không có thì `branch_missing`) → agent "DevFlow QA" chạy ở runner (đọc, chạy lệnh kiểm tra, không đẩy) → báo cáo JSON → DevFlow ghép, tính **khuyến nghị**, đề xuất (`dr_agent_outputs`, stage `qa`) → stage `qa_signoff` → người có vai `qa` hoặc `tech_lead` ký: approve → `done` (không merge gì), request_changes → **`dev`** (kèm lý do và những gì QA tìm thấy; PR giữ nguyên), reject → `cancelled` và đóng PR (dùng chung `closePullRequests`).

## Thành phần
- **Agent** (`qa/agent.ts`, `prompts/qa.v1.ts`, hash ghim trong test): dùng chung `dev/runner-agent.ts` với Dev (cùng kiểm "đang ở runner"), workspace `/paperclip/devflow/ws/qa`. Mặc định `claude-sonnet-5-5`, 3 USD mỗi lượt, 20 USD mỗi ngày mỗi công ty, 40 phút, 150 lượt. Tạo bằng `scripts/devflow/setup-qa-agent.mjs`.
- **Chỉ đọc và chạy:** QA không đẩy gì. Nếu agent commit vào nhánh thì commit bị bỏ và đề xuất có cảnh báo `qa_modified_branch` (khuyến nghị thành "changes"). Nhánh có commit mới hơn bản đã duyệt: kiểm đầu nhánh hiện tại, cảnh báo `branch_moved`.
- **Tiêu chí đánh số:** DevFlow đánh số tiêu chí chấp nhận của spec BA đã duyệt (AC1..ACn); báo cáo phải phán **mỗi tiêu chí đúng một lần** (`pass`, `fail`, `not_verified`) kèm cách kiểm (`automated`, `code_reading`, `manual`) và bằng chứng. Thiếu hoặc trùng tiêu chí thì chạy lại một lần với lý do.
- **Nhiều hệ thống:** gộp theo `fail` > `pass` > `not_verified`.
- **Khuyến nghị** (DevFlow tính, không phải agent): `approve` chỉ khi mọi tiêu chí pass, mọi lệnh kiểm đạt, không vấn đề mức cao, không có `qa_modified_branch`; ngược lại `changes` kèm lý do mã (`criteria_failed:AC2`, `criteria_not_verified:AC3`, `checks_failed`, `high_issue`, `qa_modified_branch`). Chỉ là lời khuyên: người ký vẫn approve được.
- **Sign-off** (`qa/review-service.ts`, `qa/routes.ts`, trang `/qa-signoff`): `qa-queue|qa-count|qa-metrics|qa-cases/:id|decision`. request_changes thay thế cả đề xuất QA lẫn đề xuất Dev đã nhận, để worker Dev thấy phản hồi; Dev chỉ thấy "QA found: …" khi QA quyết định **sau** đề xuất Dev bị thay thế (không để chữ QA cũ lọt vào vòng sau code review). Pipeline: `qa_signoff` approver `["qa","tech_lead"]`, `requestChangesToStageKey: dev`.
- **Số liệu:** như các trang duyệt khác, thêm tỷ lệ **ký ngược khuyến nghị** (`recommendation.againstRate`: approve dù khuyến nghị changes, hoặc trả về dù khuyến nghị approve).
- **Email nhân viên:** thư riêng (`staff.notified_qa`).
- **Migration `0362`:** chỉ nới CHECK của `dr_member_roles` thêm vai `qa`.

## Lỗi hay gặp (`agent.qa_failed`)
Như Dev (`kb/dev-stage.md`), thêm: `no_qa_target` (không hệ thống nào có PR của Dev), `branch_missing` (nhánh PR không còn trên GitHub): cả hai là cấu hình, thử lại chậm, không bỏ cuộc.

## Biến môi trường
`DEVFLOW_QA_ENABLED`, `DEVFLOW_QA_MODEL`, `DEVFLOW_QA_MAX_USD_PER_RUN` (3), `DEVFLOW_QA_MAX_USD_PER_DAY` (20), `DEVFLOW_QA_INTERVAL_MS`; dùng chung `DEVFLOW_AGENT_WORKSPACE_ROOT`, `DEVFLOW_WORKERS_ENABLED`.

## Kiểm chứng
Test tự động (container Linux): `devflow-qa-unit` (15), `devflow-qa` (11: toàn luồng với runner giả, git thật), `devflow-qa-review` (10: hàng chờ, quyền, approve/request_changes/reject, vòng QA→Dev), workspace, staff-notify, migration vai, approver sync; UI `qa-review`. Đột biến bị bắt: không phát hiện sửa nhánh, bỏ qua lệnh kiểm, QA tạo nhánh, chấp nhận thiếu tiêu chí, chỉ gộp hệ thống đầu. Chạy sơ qua (2026-10-26, không chạy lượt agent tốn tiền): image mới, đồng bộ pipeline `qa_signoff` và tạo agent QA trên công ty thử đều xong, agent "QA agent ready". Lưu ý vận hành: sau khi `compose up` tạo lại container server phải chạy lại `setup-dev-runner.mjs` (nối lại `runner_net`), nếu không agent kẹt "verifying" với `test_environment_unavailable`. **Chưa:** một lượt QA thật trên RESKI, xem trang trên trình duyệt.

## Giới hạn đã biết
- Nối tiếp Dev: dùng chung khóa `dr-agent-stage-worker`, một lượt QA (≤ 40 phút) chặn các worker khác.
- QA không dựng môi trường chạy ứng dụng đầy đủ (không DB, không thiết bị): tiêu chí cần giao diện thành `not_verified` kèm hướng dẫn thử tay.
- Pipeline của công ty đã seed phải chạy lại `setup-dev-request-pipeline.mjs` (đồng bộ route `qa_signoff → dev`) sau khi image có vai `qa`.
