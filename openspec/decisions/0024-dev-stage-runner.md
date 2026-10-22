# 0024. Dev stage: agent chạy ở runner riêng, DevFlow đẩy code và mở PR nháp, không bao giờ merge

- **Ngày:** 2026-10-22
- **Trạng thái:** đã chốt (chủ dự án duyệt change `add-dev-stage` theo mặc định, 2026-10-21; hai thay đổi sau spike ghi ở dưới)
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
BA và Tech Plan chỉ đọc nên chạy an toàn trong container server (ADR 0020 đến 0022). Agent Dev phải ghi file và chạy lệnh (build, test), tức cần `Bash`: chặn bằng danh sách tool không còn đủ, và container server có DB, secret và dữ liệu mọi công ty.

## Các lựa chọn
1. Chạy agent Dev trong container server, thêm hạn chế — rẻ nhất nhưng một lệnh Bash là chạm tới DB và secret.
2. Runner riêng do Paperclip điều khiển qua SSH (execution target `ssh`) — giữ hướng ADR 0020 (chạy qua adapter, có ghi run và chi phí), cô lập thật.
3. Runner có API HTTP do DevFlow gọi — tự ghi run và chi phí, mất phần Paperclip; dự phòng nếu 2 không dùng được.

## Quyết định
Chọn **2**. Spike (2026-10-21/22, `kb/spike-p3-runner.md`) xác nhận chạy được.
- **Runner** `devflow-runner`: container riêng, mạng `internal`, không DB, không secret, không volume của server; ra ngoài chỉ qua proxy Squid theo danh sách cho phép. Paperclip SSH vào bằng khóa riêng của DevFlow, host key ghim.
- **Agent không có token GitHub.** Workspace nằm **ở server**: Paperclip đóng gói sang runner mỗi lượt và ghi commit mới về. DevFlow kiểm diff (đúng nhánh, không viết lại lịch sử, đường dẫn cấm, ≤ 3000 dòng, nhị phân ≤ 1 MB, không submodule), kiểm bảo vệ nhánh mặc định, rồi đẩy **chỉ** `refs/heads/devflow/*` bằng **token ghi riêng của hệ thống** (không force, không hook) và mở **PR nháp**. DevFlow không merge.
- **Bật theo hệ thống:** `dev_enabled` cần token ghi (CHECK ở DB); `allow_unprotected` (chỉ owner/admin bật) cho repo không thể bật bảo vệ nhánh.
- **Code review** (`code_review`) cần vai `tech_lead`; approve bị từ chối khi chưa có PR hoặc diff bị chặn; reject đóng PR; request_changes giữ PR và làm tiếp trên cùng nhánh.
- Model mặc định `claude-sonnet-5-5`, 5 USD mỗi lượt, 50 USD mỗi ngày mỗi công ty (sổ `agent.dev_run`).
- Dùng lại khung `agent-stage` và khóa chung `dr-agent-stage-worker`.

## Thay đổi sau spike (so với bản đề xuất)
1. **Bố cục workspace:** Paperclip chỉ gửi qua lại commit của repo ở `cwd` và của repo trong `cwd/.paperclip-repositories/<tên>/` (git bundle). Nên `cwd` là repo "neo" một commit rỗng, repo hệ thống nằm ở `.paperclip-repositories/<key>/`, **clone đầy đủ** (clone nông hoặc một phần không tạo được bundle), tác giả commit qua biến môi trường (cấu hình git cục bộ không được chuyển sang runner). Mỗi lượt chạy một hệ thống.
2. **Repo riêng gói miễn phí không có branch protection** (GitHub trả 403 "Upgrade"): thêm cột `allow_unprotected` thay vì làm `repo_unprotected` chặn mãi.

## Lý do và hệ quả
- Rủi ro chính (agent chạm dữ liệu server hoặc đẩy vào nhánh chính) bị chặn ở hạ tầng và ở DevFlow, không dựa vào lời nhắc cho agent.
- Thông lượng: một lượt Dev (tới 60 phút) giữ khóa chung, nên BA và Tech Plan của cả instance chờ trong lúc đó. Chấp nhận cho pilot; tách khóa theo nơi chạy khi cần.
- Hệ thống nhiều repo chạy lại các hệ thống đã xong khi một hệ thống sau lỗi (chưa lưu tiến độ từng hệ thống).
- Transcript Claude Code trên runner dùng chung giữa các công ty (`cwd` giống nhau); chưa có việc dọn.
- Agent BA và Planner (trong container server) không có luật chặn đọc `/paperclip/devflow/ws/dev`; an toàn nhờ khóa chung và dọn workspace, chưa thêm luật để không buộc chạy lại setup của chúng.
- Toolchain hiện có: Node, Python, .NET 8 và 10. Flutter chưa cài (cần trước khi bật Dev cho RESKI).
- Cần xem lại khi: có nhiều công ty cùng dùng một runner (môi trường Paperclip là của instance, secret khóa SSH thuộc công ty đầu tiên), hoặc cần nhiều toolchain nặng (tách image theo stack, thêm `runner_profile` cho hệ thống).
