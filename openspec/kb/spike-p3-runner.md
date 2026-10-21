# Spike P3: runner riêng cho agent Dev (2026-10-21)

Mục tiêu (change `add-dev-stage`, tasks 1.2 và 1.3): xác nhận agent `claude_local` chạy trên một container tách khỏi server mà vẫn do Paperclip điều khiển, và runner chỉ ra được đúng danh sách host cho phép. Thực hiện bằng docker CLI trên stack local; chưa đưa vào docker compose (task 3.1).

## Dựng
- `docker/runner/Dockerfile` (`devflow-runner:local`): Node 24 (Debian), `openssh-server`, git, python3, rsync, tar, Claude Code CLI; user `runner` không root, không biến môi trường bí mật, đăng nhập SSH chỉ bằng khóa (`sshd_config`). Thư mục `/paperclip/devflow/ws` của runner là **thư mục rỗng của riêng nó** (cần để `cwd` giống nhau hai phía).
- Cặp khóa ed25519 sinh riêng cho spike; khóa riêng lưu thành secret công ty; khóa công khai nằm trong `authorized_keys` của runner.
- Môi trường Paperclip: `POST /api/companies/:id/environments` `{driver: "ssh", config: {host: "devflow-runner", port: 22, username: "runner", remoteWorkspacePath: "/paperclip/devflow/ws", privateKeySecretRef: {type: "secret_ref", secretId}, strictHostKeyChecking: false}}`; `POST /api/environments/:id/probe` trả `ok`. (`strictHostKeyChecking: false` chỉ cho spike; bản thật ghim `knownHosts`.)
- Agent: `claude_local`, `defaultEnvironmentId` trỏ tới môi trường trên, `engine: "cli"`, `--tools Read,Grep,Glob,Edit,Write,Bash`, `--max-budget-usd`, `cwd` = `/paperclip/devflow/ws/dev`.
- Mạng: `runner_net` (docker `--internal`, không có đường ra) chứa runner, server và một proxy Squid; proxy còn nối mạng ngoài. Cấu hình danh sách cho phép ở `docker/runner/squid.conf`; runner nhận `HTTP(S)_PROXY` qua `/etc/environment` (PAM của sshd).

## Kết quả (đã xác nhận bằng chạy thật)
- **Agent chạy trên runner, do Paperclip điều khiển:** lượt chạy trả `hostname` = `devflow-runner`, user `runner`, `ls /paperclip` trên runner chỉ thấy thư mục rỗng `devflow` (không thấy dữ liệu của server). Chi phí ghi đúng (`costStatus: reported`, 0,001 USD cho lượt thử), `resultJson` như các lượt BA.
- **Mô hình workspace (khác dự kiến ban đầu):** thư mục `cwd` nằm ở **server**; mỗi lượt Paperclip đóng gói nó sang runner, chạy agent ở đó, rồi **ghi các commit mới về thư mục ở server** và dọn bên runner. Agent tạo `hello.txt` và `git commit` trên runner; commit hiện ra ở server (`git log` có "spike: hello"). Nên token ghi chỉ cần ở server, agent không thấy. Lưu ý: sau khi ghi về, chỉ mục và cây làm việc ở server lệch (thấy `D hello.txt` kèm `?? hello.txt`): chỉ dùng `git log` và `git diff <base>..HEAD`, không dùng `git status`.
- **`cwd` phải hợp lệ ở cả hai phía:** adapter tạo thư mục `cwd` ở server và kiểm tra nó trên runner; `/work/dev` làm server lỗi `EACCES: mkdir '/work'`, một đường dẫn chỉ có ở server làm việc xác minh agent lỗi `harness_cwd_invalid`. Dùng cùng một đường dẫn (`/paperclip/devflow/ws/dev`) ở cả hai.
- **Agent mới phải qua xác minh:** agent không vào được trạng thái `idle` nếu bài kiểm tra môi trường của nó lỗi (agent kẹt `paused`/`verifying`, hàng đợi không chạy, `wakeup` vẫn `queued`). Đây là cách lỗi cấu hình lộ ra; `setup-dev-agent.mjs` phải chờ và báo lỗi này.
- **Mạng:** từ runner, truy cập trực tiếp ra ngoài bị chặn; qua proxy, `api.anthropic.com`, `api.github.com`, `registry.npmjs.org`, `pypi.org`, `pub.dev` đi được, `example.com` và host lạ bị Squid trả 403. Claude Code chạy bình thường qua proxy (lượt chạy qua SSH vẫn gọi được API model), và agent tự thấy `example.com` bị chặn còn `api.github.com` trả 200.
- Lỗi vặt trên Windows: Git Bash đổi `/work/dev` thành `C:/Program Files/Git/work/dev` khi truyền qua biến môi trường (cần `MSYS_NO_PATHCONV=1` khi chạy script từ Git Bash).

## Chưa kiểm
- Toolchain Flutter (kích thước image, `flutter pub get` qua proxy); chỉ mới thử Node và Python có sẵn.
- 1.4 (GitHub: kiểm bảo vệ nhánh, push nhánh `devflow/*` bằng token ghi qua header, mở/cập nhật/đóng PR nháp) cần một repo thử nghiệm và token ghi: chờ chủ dự án chỉ định.
- Khóa máy chủ SSH ghim (`knownHosts`), xoay khóa, nhiều lượt chạy liên tiếp (dọn bên runner), hai lượt đồng thời.

## Tài nguyên thử còn lại (xóa khi xong spike)
Công ty `DevFlow Verify`: các agent "Spike Dev …" (không xóa được vì có run; đã/cần terminate), secret khóa SSH, môi trường `devflow-runner-spike-…`; container `devflow-runner`, `devflow-proxy`, mạng `runner_net`; thư mục `/paperclip/devflow/ws/dev` và `spike` ở server.
