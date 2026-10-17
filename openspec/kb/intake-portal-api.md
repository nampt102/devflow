# Intake Portal: API requester (hiện trạng)

Nguồn: `server/src/devflow/portal/`, change `openspec/changes/add-intake-portal`, ADR 0011. Đã kiểm chứng bằng `server/src/__tests__/devflow-portal.test.ts` (13 test trên Postgres nhúng). **Chưa chạy trên stack Docker đang chạy** (image cũ chưa chứa code này) và chưa có web.

## Endpoint (đều sau guard `requireRequester`)
| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/portal/me` | `companyId`, `requesterId` của chính user |
| POST | `/api/portal/requests` | JSON hoặc multipart (`title`, `description`, `businessImpact`, `files` tối đa 5); trả 201 + DTO |
| GET | `/api/portal/requests` | Danh sách yêu cầu của chính requester (`limit` ≤ 100, `offset`) |
| GET | `/api/portal/requests/:number` | Chi tiết + `attachments` |
| POST | `/api/portal/requests/:number/attachments` | Thêm file, tổng ≤ 5 file / yêu cầu |
| GET | `/api/portal/requests/:number/attachments/:id` | Tải file: `Content-Disposition: attachment`, `nosniff`, `no-store` |

Nhiều công ty: client gửi `?companyId=` (hoặc trong body); guard đối chiếu với các bản ghi `dr_requesters` của chính user. Không gửi mà user thuộc nhiều hơn một công ty: 400.

## Quy tắc đã kiểm chứng
- Chỉ session đăng nhập có `dr_requesters` đang hoạt động; agent, `none`, user lạ: 401/403.
- `companyId`/`requesterId` lấy từ `dr_requesters`; `companyId` giả: 403. Stage cố định `triage`; `stageKey`, `priority`, `fields` do client gửi bị bỏ qua.
- Case tạo bằng actor `user` (event ghi đúng requester), `caseKey = REQ-<n>`, tối đa 10 yêu cầu/giờ/requester.
- Gửi lỗi ở bước ghi cuối: xóa case, xóa asset và object vừa tạo (bù trừ, vì `ingestCase` có giao dịch riêng).
- DTO allowlist: `code, number, title, description, businessImpact, statusLabel, createdAt, updatedAt, attachments[{id, filename, contentType, byteSize, createdAt}]`. Không có `pendingSuggestion`, `fields`, events, `objectKey`, `assetId`, `sha256`.
- File: png/jpeg/webp/gif, pdf, doc/xls/ppt, docx/xlsx/pptx, txt, csv; ≤ 10 MB; byte đầu phải khớp loại khai báo; tên file bỏ đường dẫn và ký tự điều khiển; từ chối svg/html/zip/video/audio. File xấu bị từ chối trước khi tạo gì (422).
- Asset phải cùng công ty với case (kiểm ở service vì DB chưa ép, ADR 0010).
- Kiểm chứng đột biến: tắt kiểm tra nội dung file hoặc kiểm tra cùng công ty thì test tương ứng fail.

## Chưa làm / hạn chế
- Chưa quét virus; chưa rate limit riêng cho upload thêm (chỉ giới hạn 5 file/yêu cầu và 10 yêu cầu/giờ).
- Object file không bị xóa khi case bị xóa ở nơi khác (chỉ bù trừ lúc gửi lỗi).
- Mời requester (`dr_requester_invites`) và web `portal/` chưa có (nhóm 3, 4).
