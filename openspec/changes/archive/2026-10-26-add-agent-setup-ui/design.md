## Context

Các script `setup-*-agent.mjs` (qua `lib/setup-stage-agent.mjs`), `setup-dev-request-pipeline.mjs` và `lib/approver-sync.mjs` chỉ gọi API công khai của Paperclip: đăng nhập, `GET/POST /companies/:id/secrets`, `POST /secrets/:id/rotate`, `GET/POST/PATCH /agents`, `…/instructions-bundle`, `GET/POST /pipelines`, `PUT /pipelines/:id/transitions`, `PATCH /pipelines/:id/stages/:id`. Cấu hình chuẩn của agent lấy từ `GET /companies/:id/devflow/<vai>-agent` (có `spec` và `agent.problem`). Quan sát hôm nay (2026-10-26): agent mới ở `verifying` trả 409 khi bật, lỗi xác minh (`test_environment_unavailable`, `harness_cwd_invalid`) chỉ thấy trong log server, và đăng nhập bị giới hạn tần suất khi thử lại.

## Goals / Non-Goals

**Goals:** chủ dự án tự cài và sửa agent, pipeline từ giao diện; thấy nguyên nhân khi kẹt; không mở đặc quyền mới; một nguồn logic cho script và giao diện.

**Non-Goals:** dựng runner từ giao diện, tự cài lại khi khởi động (B-40), CI (B-26), đổi cấu hình chuẩn.

## Decisions

**D1. Trình duyệt điều phối, dùng đúng các API đã có.** Giao diện thực hiện cùng chuỗi bước như script bằng API client, với phiên của người đang đăng nhập. Mọi kiểm tra quyền, mediated secret, phê duyệt agent mới (`requireBoardApprovalForNewAgents`), chuẩn hóa adapter config vẫn do core xử lý. Lý do: viết lại việc tạo agent phía server (`routes/agents.ts` ~100 dòng kiểm tra riêng cho tạo agent) là rủi ro lớn và dễ lệch core khi gộp bản Paperclip mới (B-27). Đánh đổi: các bước không nguyên tử (tạo xong mà bật lỗi); chấp nhận vì chạy lại an toàn (idempotent) và trang hiện đúng bước đang dở.

**D2 (đã chốt khi làm). Phần thuần nằm ở server, giao diện chỉ áp kết quả.** `server/src/devflow/setup/pipeline-sync.ts` là bản TypeScript của `approver-sync.mjs` (test chạy cả hai trên cùng đầu vào); `setup-status` trả sẵn thân PATCH/PUT cần gửi, giao diện chỉ gửi lại, nên không có logic so khớp ở trình duyệt. Ý định ban đầu (bên dưới) không còn dùng. Bản gốc: Phần thuần (so khớp approver, hợp nhất bước chuyển, quyết định cần tạo hay cập nhật, kiểm instructions) chuyển thành TypeScript trong `packages/shared` (có test); `ui/src/lib/agentSetup.ts` gọi API; script `.mjs` import bản biên dịch hoặc giữ vỏ mỏng. Nếu không import được từ script một cách gọn, giữ bản `.mjs` hiện có và thêm test đối chiếu kết quả hai bên trên cùng đầu vào, để không lệch.

**D3. Một endpoint đọc `GET /companies/:id/devflow/setup-status`.** Gom: với từng vai (`ba`, `plan`, `dev`, `qa`) `{ spec hash, agent: {id, status, problem}|null, lastLifecycleFailure|null }`, pipeline `{ exists, missingApprovers[], missingTransitions[] }`, runner `{ environment: bool, reachable: bool }` (phân giải tên máy chủ runner từ tiến trình server). Chỉ đọc, cùng kiểm quyền staff + owner/admin. `lastLifecycleFailure` lấy từ log vòng đời nếu có sẵn để đọc; nếu không có chỗ lưu thì chỉ hiện trạng thái `verifying` và hướng dẫn xem log (ghi rõ "chưa xác nhận" cho tới khi đọc code; xem Open Questions).

**D4. Xử lý trạng thái `verifying`.** Sau Create, giao diện thăm dò `GET /agents/:id` (tối đa vài phút, giãn cách tăng dần) rồi mới PATCH `status: idle`; không gọi lặp (tránh giới hạn tần suất đăng nhập vốn chỉ áp cho script). Hết hạn mà vẫn `verifying` thì hiện "Verifying, try again in a minute".

**D5. Khóa Anthropic.** Ô nhập chỉ tồn tại trong bộ nhớ trang, gửi một lần qua `POST /secrets` (hoặc `rotate`), xóa sau khi lưu; không đưa vào URL, query, log, toast. Dùng lại secret chung `devflow-ba-anthropic`.

**D6. B-40 (tự cài lại khi khởi động) hoãn.** Cần tạo/cập nhật agent bằng tiến trình server, tức tái hiện logic của core; chọn đợi trang Setup chạy thực tế rồi quyết định có cần không (trang đã giảm việc còn lại xuống một cú bấm). Ghi vào backlog.

**D7. CI (B-26) tách change riêng** vì là workflow GitHub trên repo công khai (chạy trên mỗi push, dùng Postgres nhúng cần Linux).

## Risks / Trade-offs

- Logic nằm ở giao diện: nếu người dùng đóng tab giữa chừng, trạng thái dở dang; chạy lại là khớp (idempotent). 
- Core đổi API agent khi gộp bản Paperclip mới: lỗi hiện ở cả script và trang, sửa một chỗ (D2).
- Trang cho owner/admin bấm Update lúc agent đang chạy: PATCH bị core từ chối khi agent bận (409); hiển thị rõ thay vì lặp lại.

## Open Questions (mặc định nếu duyệt không trả lời)

1. (Đã kiểm: **không**, lỗi vòng đời chỉ ghi log server qua `logger.warn`, không lưu; trang chỉ hiện trạng thái `verifying` và gợi ý chạy lại `setup-dev-runner.mjs`.) Log vòng đời xác minh agent có đọc được qua API/DB không (để hiện `test_environment_unavailable`)? Mặc định: kiểm khi làm; nếu không, chỉ hiện trạng thái và gợi ý chạy lại `setup-dev-runner.mjs`.
2. Ai được dùng trang: mặc định owner, admin công ty và instance admin (cùng quy tắc `allow_unprotected`).
3. Tự cài lại khi khởi động (B-40): mặc định **hoãn**, ghi backlog.
4. CI: mặc định **tách** thành `add-devflow-ci`, đề xuất sau.
