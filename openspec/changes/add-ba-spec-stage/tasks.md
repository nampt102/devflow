## 1. Duyệt

- [x] 1.1 Chủ dự án duyệt proposal, design và DDL (2026-10-19, theo mặc định: haiku, tiếng Việt, mọi nhân viên quản lý Systems)

## 2. Hệ thống (schema + API + UI)

- [x] 2.1 Migration `0359_devflow_systems.sql` (unique index đặt trước khóa ngoại) + schema Drizzle + 9 test cách ly công ty và CHECK; 4 đột biến bị bắt
- [x] 2.2 API `GET|POST /companies/:id/devflow/systems`, `PATCH …/:systemId` (token lưu thành secret công ty, quay vòng, gỡ; không bao giờ trả lại; kiểm giá trị trước khi vào dòng lệnh git); 8 test (cách ly công ty, quyền, activity log); 7 đột biến bị bắt
- [x] 2.3 `systems/workspace.ts`: clone nông bằng `git` (token chỉ ở header của tiến trình đó, chỉ https, không hook, môi trường tối thiểu, gỡ remote, xóa symlink, lỗi ngắn không lộ token, dọn clone dở); đọc token qua `secretService.resolveSecretValue` với `accessContext` hệ thống đã kiểm trên dịch vụ secret thật (đúng công ty, từ chối công ty khác, secret đã xóa); 11 test, 8 đột biến bị bắt
- [x] 2.4 Trang Board UI "Systems" (`ui/src/pages/Systems.tsx`, `lib/systems.ts`): thêm, sửa, tắt/bật; token nhập một lần và không hiện lại; 5 test; token-gates không lỗi ở file mới; **chưa xem trên trình duyệt (cần build lại image)**

## 3. Agent và worker BA

- [x] 3.1 Prompt `ba.v1` (hash ghim), schema Zod strict (đường dẫn và hệ thống được kiểm), `request.md` với ranh giới ngẫu nhiên, `comment_text` tiếng Việt; test không cần DB
- [x] 3.2 Agent BA tạo bằng API qua `scripts/devflow/setup-ba-agent.mjs` (DevFlow không sao chép logic hire), cấu hình chuẩn lấy từ `GET /devflow/ba-agent`; trước mỗi lượt `unsafeBaAgentReason` từ chối agent bị đổi (engine, công cụ, thư mục, ngân sách, prompt cũ…); 1 thư mục workspace dùng chung, chạy tuần tự toàn instance và dọn trước/sau mỗi lượt (không để dữ liệu công ty khác cạnh agent)
- [x] 3.3 Worker `ba/worker.ts` + `ba-service.ts` + `runner.ts`: quét `ba_spec`, wakeup qua heartbeat của Paperclip, đợi run, đọc `resultJson`, phân loại lỗi theo `subtype`, chạy lại một lần khi JSON sai (không đưa lại chữ của agent), backoff, bỏ cuộc sau 3 lần; lỗi cấu hình thử lại 5 phút, không bỏ cuộc
- [x] 3.4 Ghi `dr_agent_outputs` (giữ SHA, chi phí, token) rồi `transitionCase` sang `ba_review` (không chung giao dịch: nếu chuyển lỗi thì đề xuất bị `superseded`, giống Triage); chặn đua bằng khóa dòng + so version
- [x] 3.5 Trần USD mỗi ngày mỗi công ty tính từ sổ `agent.ba_run` của DevFlow, `DEVFLOW_BA_*`, tắt bằng `DEVFLOW_WORKERS_ENABLED`; biến môi trường trong compose và `.env.example`
- [x] 3.6 69 test (unit + DB với runner và clone giả); 25 đột biến bị bắt

## 4. Gán hệ thống ở Triage

- [x] 4.1 Prompt `triage.v4` (hash ghim; v1 đến v3 giữ nguyên) + `triageOutputSchemaV4` (`suggestedSystemKeys`, tối đa 3, phải thuộc danh sách được đưa) + Triage đưa hệ thống đang bật của đúng công ty vào prompt trong ranh giới dữ liệu; test unit và DB, đột biến bị bắt
- [x] 4.2 Triage review: API (chi tiết trả `systems`, quyết định nhận `systemIds`, approve thay thế gán trong `beforeCommit`, override `systems`, 422 với hệ thống lạ/đã tắt; 6 test, 12 đột biến bị bắt) và giao diện chọn hệ thống (ô chọn điền sẵn đề xuất, ghi chú khi khác đề xuất, liên kết sang trang Systems; 3 test); **chưa xem trên trình duyệt (cần build lại image)**

## 5. BA review

- [x] 5.1 `ba/review-service.ts` + routes `ba-queue|ba-count|ba-cases/:id|…/decision` (+ `ba-agent`): hàng chờ, chi tiết (spec, SHA đã đọc, liên kết repo), sửa các trường cho phép (trích dẫn và độ tin cậy là của agent), `dr_overrides` theo trường, spec đã duyệt giữ ở `data.approved`, đổi hệ thống khi approve hoặc request_changes, 422 với hệ thống lạ, 409 khi thua đua, không tự duyệt yêu cầu của mình; 17 test (gồm vòng quay lại agent với hệ thống mới và lý do), 16 đột biến bị bắt (1 đột biến tương đương)
- [x] 5.2 Trang Board UI "BA review" (`pages/BaReview.tsx`, `lib/ba-review.ts`, `api/devflowBa.ts`): hàng chờ có nhãn New, sửa spec thành văn bản từng dòng, trích dẫn link GitHub theo SHA đã đọc, đổi hệ thống, approve/request_changes/reject, số đếm trên sidebar; 10 test, 11 đột biến bị bắt; **chưa xem trên trình duyệt (cần build lại image)**
- [x] 5.3 Email nhân viên gom thêm hàng chờ `ba_review` (thư riêng, sổ riêng `staff.notified_ba`, giữ nguyên thư Triage; 3 test mới, 6 đột biến bị bắt) và số liệu `GET …/ba-metrics` (tỷ lệ override theo trường và phiên bản prompt, quyết định, thời gian duyệt, số lượt chạy, chi phí USD kể cả lượt lỗi, lỗi gần đây không kèm nội dung; 5 test, 11 đột biến bị bắt) cùng panel "Quality and cost" ở trang BA review

## 6. Hoàn tất

- [x] 6.1 `scripts/devflow/smoke-p2.mjs` trên stack Docker thật (repo `nampt102/devflow`, key Claude): 25/25; **chưa xem giao diện trên trình duyệt**
- [x] 6.2 KB `kb/ba-spec.md`, runbook, status, backlog, ADR 0021
