# 0020. P2: BA Spec và Tech Plan chạy qua adapter của Paperclip; repo và docs gán theo "Hệ thống"

- **Ngày:** 2026-10-19
- **Trạng thái:** đã chốt hướng (chủ dự án); chi tiết thiết kế chờ spike và change proposal P2
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Agent BA Spec và Tech Plan cần hiểu tài liệu nghiệp vụ và code. Đã cân nhắc ba cách: (A) worker nội bộ gọi LLM một lần như Triage, (B) worker nội bộ có tool đọc file, (C) adapter của Paperclip (ví dụ `claude_local` chạy Claude Code CLI trong workspace có repo). Chủ dự án lo A không đủ chất lượng vì agent chỉ thấy phần ngữ cảnh ta chọn sẵn.

## Quyết định
- **Chạy agent P2 qua adapter của Paperclip** (cách C), không dùng worker nội bộ cho BA/Tech Plan. Triage vẫn giữ worker nội bộ (ADR 0014).
- Model theo cấu hình: Claude Code (`claude_local`, bằng API key hoặc tài khoản Claude), model local qua adapter hỗ trợ OpenAI-compatible (ứng viên `opencode_local`, chưa kiểm chứng với vLLM).
- **Repo trên GitHub**, đọc bằng token chỉ đọc; **tài liệu nghiệp vụ là markdown trong thư mục `docs/` của repo** (không làm upload).
- **Danh mục "Hệ thống" theo công ty** (tên, mô tả, repo); **gán hệ thống ở bước Triage review** (agent Triage đề xuất, người duyệt xác nhận); BA/Planner chỉ đọc repo của hệ thống đã gán. Người duyệt ở BA review có thể đổi phạm vi rồi request_changes.

## Hệ quả
- Cần spike trước khi thiết kế: `claude_local` chạy trong container Docker hiện tại (image đã cài `@anthropic-ai/claude-code`), workspace clone repo GitHub chỉ đọc, ép output có cấu trúc, ghi run/cost, gắn vào stage của pipeline (`automation`/`assigneeAgentId`). Tất cả **chưa xác nhận**.
- Chi phí và thời gian mỗi lần chạy cao hơn worker; cần trần token/ngân sách cho agent adapter (ngân sách của Paperclip theo tiền, chi phí Claude Code có thể có giá).
- Agent có quyền chạy lệnh trong workspace: phải giới hạn chỉ đọc (không push, không mạng ngoài trừ model) và coi nội dung repo/yêu cầu là dữ liệu không tin cậy.
- Kết quả spike có thể buộc xem lại quyết định này (ví dụ không ép được schema output).

## Cập nhật 2026-10-19 (sau spike)
- **Cách chặn agent: Option 3** (chủ dự án duyệt): `engine: "cli"`, chỉ tool `Read,Grep,Glob` (`--tools`), chặn đọc thư mục instance và hệ thống bằng `--disallowedTools Read(//…/**)`, `--max-budget-usd` mỗi lượt, token GitHub chỉ đọc, clone không lưu token. Không tắt seccomp, không dùng bubblewrap; cách ly mạnh hơn (bubblewrap với profile seccomp riêng, hoặc runner tách) để P4.
- Hệ quả: agent không gọi được API Paperclip, nên **DevFlow điều khiển toàn bộ lượt chạy** (dựng workspace, `wakeup`, đọc run, ghi output, chuyển stage); không dùng `onEnter`/routine. Thiết kế chi tiết: change `add-ba-spec-stage`.
