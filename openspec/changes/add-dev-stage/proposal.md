## Why

Sau P2, yêu cầu có kế hoạch kỹ thuật đã duyệt chuyển sang stage `dev` rồi dừng: chưa có gì viết code. P3 cần một agent hiện thực kế hoạch đã duyệt trên một nhánh riêng của repo hệ thống, chạy test, và mở **pull request nháp** để người duyệt xem ở `code_review`. Agent không bao giờ merge; mọi thay đổi vào nhánh chính vẫn do người làm trên GitHub.

Khác BA và Planner (chỉ đọc), agent Dev phải ghi file và chạy lệnh (build, test). Vì vậy nó **không được chạy trong container server** (nơi có DB, secret và dữ liệu mọi công ty) mà chạy ở một **runner riêng** (chủ dự án chọn ngày 2026-10-21).

Change này chỉ làm **Dev và Code review**. QA (`qa`, `qa_signoff`) là change sau.

## What Changes

- **Runner riêng `devflow-runner`** (service mới trong docker compose): image có git, Claude Code và toolchain; không có DB, không có secret của server, không mount volume `/paperclip`; mạng ra ngoài chỉ tới danh sách cho phép (API model, GitHub, kho package). Agent chạy ở đó **qua execution target SSH của Paperclip** (giữ hướng ADR 0020: agent chạy qua adapter của Paperclip). Cơ chế này **chưa kiểm chứng**: change bắt đầu bằng spike; nếu không dùng được thì phương án dự phòng (runner HTTP do DevFlow điều khiển) được trình lại để duyệt.
- **Agent "DevFlow Dev" mỗi công ty**: `claude_local`, `engine: cli`, tool `Read, Grep, Glob, Edit, Write, Bash` (cần Bash để chạy test), model mặc định `claude-sonnet-5-5`, ngân sách mỗi lượt và mỗi ngày, giới hạn số lượt tool và thời gian. **Agent không có token GitHub** và không push: DevFlow làm việc đó sau khi kiểm diff.
- **Bật theo hệ thống**: agent chỉ code cho hệ thống được bật "cho phép agent Dev" ở trang Systems, có **token ghi** riêng (tách khỏi token chỉ đọc) và tùy chọn **lệnh kiểm tra** (build/test). **Cần sửa schema** `dr_systems` (DDL ở design, chờ duyệt).
- **Dev worker**: case ở `dev` chưa có đề xuất → dựng workspace trên runner (clone repo đã gán, tạo nhánh `devflow/<REQ>`), `request.md` có spec BA và kế hoạch đã duyệt → agent sửa code, chạy lệnh kiểm tra, commit cục bộ, trả JSON (task đã làm, lệnh đã chạy và kết quả, ghi chú) → DevFlow kiểm diff (đường dẫn cấm, kích thước, nhánh chính được bảo vệ) → push nhánh và mở **PR nháp** (một PR mỗi repo) → ghi đề xuất → chuyển `code_review`.
- **Màn hình Code review** (Board UI, cùng khuôn BA/Plan review): link PR, thống kê diff, kết quả lệnh kiểm tra, ghi chú của agent, đối chiếu task của kế hoạch. Approve → `qa` (đợi change QA); request_changes (có lý do) → `dev`, agent làm tiếp **trên cùng nhánh**; reject → `cancelled`, DevFlow đóng PR. Cần vai `tech_lead`.
- Email nhân viên cho hàng chờ `code_review`; số liệu và chi phí Dev trong mục Quality.

## Capabilities

### New Capabilities
- `dev-stage`: agent Dev hiện thực kế hoạch đã duyệt trên nhánh riêng trong runner tách biệt, DevFlow mở PR nháp, nhân viên duyệt ở `code_review`.

### Modified Capabilities
- `ba-spec` (hệ thống): thêm trường bật agent Dev, token ghi, lệnh kiểm tra cho mỗi hệ thống.

## Impact

- `docker/`: service `devflow-runner` (Dockerfile riêng), mạng nội bộ và proxy cho phép ra ngoài theo danh sách, biến `DEVFLOW_DEV_*`.
- `packages/db`: migration thêm cột vào `dr_systems` (chờ duyệt).
- `server/src/devflow/`: `dev/` (service, schema, review, routes, start, GitHub client tối thiểu bằng `fetch`), mở rộng `agent-stage/` cho workspace trên runner và tool ghi, `prompts/dev.v1.ts`, cấu hình pipeline `code_review` (vai `tech_lead`).
- `ui/`: trang Code review, mở rộng trang Systems.
- `scripts/devflow/`: `setup-dev-agent.mjs`, smoke Dev.
- Có thể cần vá nhỏ ở lõi nếu execution target SSH không nhận được từ cấu hình agent (xác định ở spike). Không dependency mới dự kiến.

## Ngoài phạm vi
QA agent và `qa_signoff`; merge tự động hay deploy; model local cho agent Dev; chạy song song nhiều lượt Dev; theo dõi trạng thái PR (merged/closed) ngoài các thao tác của chính DevFlow; toolchain đầy đủ cho mọi ngôn ngữ (bản đầu: Node, Python, Dart/Flutter tùy spike).
