## Context

Đã kiểm chứng (2026-10-17, `kb/requester-access.md`): board API chặn user không có membership; đăng ký email mở và không xác minh email. `ingestCase` (server/src/services/pipelines.ts) tự mở transaction và chạy automation sau commit của nó; actor `user` không yêu cầu membership ở tầng service (`assertActorProvenance` chỉ kiểm run id của agent).

## Goals / Non-Goals

**Goals:** requester gửi/xem yêu cầu của mình, cách ly khỏi board và khỏi nhau; tiếng Việt; audit đầy đủ.
**Non-Goals:** SSO, quét virus file, requester tự hủy, thông báo email (bước 7b), dashboard.

## Decisions

1. **Guard:** `assertRequester(req)` đọc session, tìm `dr_requesters` hoạt động; kết quả cung cấp `{companyId, requesterId, userId}` cho handler. Nếu user là requester ở nhiều công ty thì client gửi `companyId` và guard kiểm tra khớp một bản ghi của chính user.
2. **Actor khi tạo case:** `{type: "user", userId}` để `pipeline_case_events` ghi đúng requester.
3. **Tính toàn vẹn khi gửi:** `ingestCase` không nhận transaction ngoài và chạy automation sau commit của nó, nên không bọc chung được (truyền `tx` làm `db` sẽ chạy automation trước khi commit ngoài). Trình tự: (a) cấp số `n` bằng upsert `dr_request_counters`; (b) `ingestCase` với `caseKey = REQ-n`, stage `triage`; (c) transaction ghi `dr_requests`, `dr_attachments`, activity log. Nếu (c) lỗi: bù trừ bằng cách hủy case và ghi log; số `n` có thể bị bỏ trống. Hệ quả: automation của stage `triage` (Triage agent, bước 6) không được giả định `dr_requests` đã tồn tại tại thời điểm ingest; agent phải đọc `dr_requests` và báo lỗi rõ khi thiếu.
4. **DTO allowlist:** handler trả DTO tường minh, không bao giờ trả đối tượng case. Có test khẳng định không có `pendingSuggestion`, `fields`, events.
5. **File:** route upload riêng của portal gọi storage service trực tiếp (route assets của board cần company access); kiểm size/MIME/số lượng ở server; kiểm `asset.company_id == case.company_id` ở service vì DB chưa ép (ADR 0010).
6. **Mời requester:** bảng riêng `dr_requester_invites`, không tái dùng invite công ty của Paperclip vì chấp nhận invite đó có thể cấp membership, tức quyền đọc board (chưa đọc `access.ts` để xác nhận). Token băm như agent key, một lần, hết hạn, gắn với session user khi chấp nhận. Email không phải căn cứ bảo mật vì đăng ký chưa xác minh.
7. **Web:** `portal/` workspace package `@devflow/portal` (React + Vite, chỉ tiếng Việt, không thêm thư viện router/i18n/UI, dependency trùng phiên bản với `ui/` nên lockfile chỉ thêm một khối importer). Phục vụ tĩnh ở `/portal` qua `server/src/devflow/portal/static.ts`, mount trong `app.ts` trước `app.use(staticUi)` của board (catch-all của board sẽ nuốt mọi đường dẫn nếu mount sau). Đã triển khai và kiểm chứng; xem `kb/intake-portal-web.md`.
8. **Nhãn trạng thái:** ánh xạ stage key sang nhãn tiếng Việt ở server (một nơi); client không tự suy từ stage.

## Risks / Trade-offs

- Bù trừ thay cho giao dịch duy nhất: có cửa sổ nhỏ tồn tại case thiếu `dr_requests`; giảm bằng kiểm tra health và test.
- Thêm workspace package đổi lockfile và Dockerfile; không tạo lockfile được trên host (Node 22, chưa cài node_modules), phải chạy `pnpm install` trong container.
- Đăng ký mở vẫn tạo user rác không có quyền; cân nhắc `PAPERCLIP_AUTH_DISABLE_SIGN_UP` sau khi kiểm chứng luồng mời (chưa xác nhận hoạt động khi tắt đăng ký).
