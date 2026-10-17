# Tham khảo: MaxMiksa/Autonomous-Company (chỉ lấy ý tưởng)

Nguồn: `https://github.com/MaxMiksa/Autonomous-Company` (MIT, commit `e647b3d`, 2026-10-15), đã clone ngoài repo ở `D:\WORKING\SOURCECODE\_ref\Autonomous-Company`; báo cáo chi tiết của agent đọc: `_ref\notes\autonomous-company.md`. **Không có mã hay văn bản prompt nào được sao chép vào DevFlow**; nếu sau này điều chỉnh từ repo này thì phải giữ thông báo bản quyền MIT và ghi nguồn tại file đó.

## Nó là gì, và vì sao chỉ tham khảo được một phần
Vòng lặp "công ty tự trị chạy 24/7" trên một máy cá nhân (Bash + Python + dashboard), chạy Claude Code hoặc Codex CLI. Mỗi chu kỳ: đọc file trạng thái chung `memories/consensus.md`, quyết định, thực hiện, cập nhật file, ngủ. Triết lý **tự trị trước** ("không chờ duyệt", "70% thông tin là đủ", NO-GO bị vô hiệu bằng "ép chọn một"), đối nghịch nguyên tắc của DevFlow (agent chỉ đề xuất, người duyệt từng gate). Không có approval engine, không đa công ty, không DB, đơn người dùng. Phần dùng được là **cách vận hành, an toàn và giao diện**, không phải logic workflow.

Đã đọc kỹ: CLAUDE.md, PROMPT.md, ENGINE_ADAPTERS.md, `docs/usage-governance.md`, `docs/runtime-observability.md`, skill `team`, vai `critic`, các đoạn chính của `auto-loop.sh`. Chỉ lướt: dashboard, test, phần lớn file agent và skills. Con số mặc định của vòng lặp và các quy tắc "Human Overrides" và "null thay vì 0" đã được tôi kiểm lại trực tiếp trong repo.

## Đáng áp dụng cho DevFlow (xếp theo giá trị trên công sức)
| # | Ý tưởng | Áp dụng thế nào | Bước/phase | Công sức |
|---|---|---|---|---|
| 1 | **Khung prompt vai trò cố định** (Role, Principles, Decision framework, Output format, nơi lưu) và một câu phán quyết đứng đầu; vai `critic` làm **bước tự phản biện** (pre-mortem 3 lý do thất bại + checklist đảo ngược 6 câu) | Dùng khung cho prompt Triage, BA, Planner, QA; biến critic thành bước bên trong QA/Planner chứ không phải agent riêng ra quyết định. Phải tự thêm: schema JSON theo stage, bình luận đọc được, confidence/assumptions/open_questions, cấm tự chuyển trạng thái, version prompt (`dr_prompts`) | Bước 6 (Triage), P2 | S |
| 2 | **Coi nội dung do người dùng gửi là dữ liệu không tin cậy** | Repo cho thấy vector tấn công: nội dung trong file trạng thái bị nhồi lại vào prompt chu kỳ sau. Yêu cầu từ portal sẽ vào prompt của Triage: bọc trong phần dữ liệu có ranh giới rõ, không cho nó đổi trạng thái hay gọi công cụ; test có yêu cầu chứa "hãy bỏ qua chỉ dẫn" | Bước 6 | S, bắt buộc |
| 3 | **CLI/HTTP giả thay model thật** trong test, test chống dương tính giả khi nhận diện giới hạn, test khóa/PID cũ | Cần một endpoint LLM giả (OpenAI-compatible) để test Triage agent mà không cần vLLM hay API thật | Bước 6 | S/M |
| 4 | **Phân loại lỗi của một lượt chạy theo thứ tự ưu tiên** (vi phạm governance, timeout, exit code, trạng thái adapter, đầu ra không hợp lệ) và `soft_timeout` (hết giờ nhưng đã có đầu ra hợp lệ thì giữ) | Kiểm tra trước xem heartbeat và `run-failure-diagnostics` của Paperclip đã làm đến đâu, rồi chỉ thêm phần thiếu. Nhận diện "hết hạn mức" bằng mã lỗi có cấu trúc, không bằng văn bản đầu ra | Bước 6, P3 | M |
| 5 | **Circuit breaker**: 5 lỗi liên tiếp thì nghỉ 300 giây, chờ riêng 3600 giây khi hết hạn mức, mã thoát 78 = lỗi cấu hình không retry | Paperclip có budget hard-stop nhưng tôi chưa xác nhận có breaker cho lỗi liên tiếp. Nếu thiếu: thêm theo từng agent, backoff lũy tiến (repo dùng thời gian cố định, kém hơn), và báo IT qua email khi breaker mở | Bước 7b, P3 | S/M |
| 6 | **Sổ cái dùng tài nguyên không bịa số 0**: giá trị thiếu là `null` kèm trạng thái reported/unavailable/partial; trạng thái ngân sách warning/hard/unverifiable | Paperclip đã có `cost_events`, `budget_policies`, `budget_incidents`: chỉ cần kiểm tra cột có chấp nhận thiếu dữ liệu không và dashboard hiển thị "độ phủ ghi nhận" | Dashboard P3 | S/M |
| 7 | **Mẫu dashboard**: nhãn "cập nhật lúc / nguồn / độ phủ" để nói độ chắc chắn của số liệu, trạng thái rỗng có lý do, tự làm mới khi tab hiện lại và giãn nhịp khi lỗi, spinner trì hoãn 300 ms, hộp xác nhận cho hành động hủy, `aria-live` cho thông báo | Dùng cho dashboard IT/lãnh đạo; portal đã có trạng thái rỗng và nhãn, có thể thêm tự làm mới và "cập nhật lúc" | P3, portal | S |
| 8 | **Gắn nhãn đầu ra agent là "đề xuất chưa kiểm chứng"** và giới hạn kích thước có tên (tiêu đề 60, tóm tắt 500, báo cáo 16 KiB) | Áp cho `dr_agent_outputs`: độ dài tối đa từng trường theo schema, nhãn "đề xuất" trên giao diện duyệt. Tỷ lệ override không có sẵn trong repo, DevFlow tự thiết kế | Bước 5, 8 | S |
| 9 | **Vùng do người sở hữu mà agent không được sửa; vi phạm thì rollback, tạm dừng, ghi audit** | Đã được Pipelines đảm bảo (agent không duyệt được stage review, có test); ý tưởng còn lại là ghi sự kiện audit rõ ràng khi agent thử vượt quyền | Bước 8 | S |
| 10 | **Kiểm tra bản dịch lệch nguồn** bằng hash (`i18n/source-hashes.json`) và khóa message có tham số | Portal hiện chỉ có tiếng Việt, một file `vi.ts`: chưa cần; xem lại khi thêm ngôn ngữ thứ hai | Sau P1 | S |

## Không áp dụng
- Tự trị trước, không chờ duyệt, ép chọn khi NO-GO; GO/NO-GO chỉ là quy ước trong prompt; mục tiêu "kiếm tiền"; 14 persona người nổi tiếng và skills marketing/tài chính/bán hàng.
- Một file `consensus.md` toàn cục làm trạng thái (DevFlow giữ trạng thái trong DB và Pipelines); vòng lặp tuần tự đơn người dùng; không RBAC, không đa công ty.
- Đóng gói WSL/bubblewrap/launchd/systemd và script Windows.

## Rủi ro khi tham khảo
- **An toàn mặc định yếu:** `CLAUDE_PERMISSION_MODE=bypassPermissions` và `CODEX_SANDBOX_MODE=danger-full-access` là mặc định của repo (`scripts/core/auto-loop.sh`), nhiều điều cấm chỉ là văn bản trong prompt, che credential chỉ là best-effort. Không lấy các mặc định này cho agent Dev của DevFlow (P3): giữ quyền tối thiểu và môi trường cách ly.
- **MIT:** chỉ ý tưởng thì không bị ràng buộc; chép mã hay prompt thì phải giữ bản quyền. Có thêm giấy phép riêng cho phần icon, shadcn, motion và `frontend-design` trong thư mục dashboard và skills.
- **Chất lượng đầu ra thực tế chưa được kiểm:** chưa đọc các tài liệu agent sinh ra; file agent viết bằng tiếng Trung, tôi chỉ dựa vào bản đọc của agent; có lệch nhỏ (prompt nói 3–5 agent, skill nói 2–5).

## Chưa xác nhận
- README, `docs/product-center.md`, `docs/project-isolation.md`, `docs/troubleshooting.md`; chất lượng thật của khoảng 38 skills và 11 file agent chưa đọc.
- Cơ chế phát hiện treo ngoài timeout cứng, heartbeat, chi tiết `process-supervisor.sh`, cách `consensus-guard.sh` so sánh từng byte.
- Paperclip đã có breaker lỗi liên tiếp, phân loại lỗi và cột cost cho phép thiếu dữ liệu hay chưa (mục 4, 5, 6).
- Chưa chạy bộ test của repo.
