# Intake Portal: API requester (hiện trạng)

Nguồn: `server/src/devflow/portal/`, change `openspec/changes/add-intake-portal`, ADR 0011. Đã kiểm chứng bằng `server/src/__tests__/devflow-portal.test.ts` (20 test trên Postgres nhúng: 13 portal + 7 lời mời). **Chưa chạy trên stack Docker đang chạy** (image cũ chưa chứa code này) và chưa có web.

## Endpoint (đều sau guard `requireRequester`)
| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/portal/me` | `companyId`, `requesterId` của chính user |
| POST | `/api/portal/requests` | JSON hoặc multipart (`title`, `description`, `businessImpact`, `files` tối đa 5); trả 201 + DTO |
| GET | `/api/portal/requests` | Danh sách yêu cầu của chính requester (`limit` ≤ 100, `offset`) |
| GET | `/api/portal/requests/:number` | Chi tiết + `attachments` |
| POST | `/api/portal/requests/:number/attachments` | Thêm file, tổng ≤ 5 file / yêu cầu |
| GET | `/api/portal/requests/:number/attachments/:id` | Tải file: `Content-Disposition: attachment`, `nosniff`, `no-store` |

### Lời mời requester (migration 0356, bảng `dr_requester_invites`)
| Method | Path | Ai | Ghi chú |
|---|---|---|---|
| POST | `/api/companies/:companyId/portal/invites` | Thành viên công ty không phải viewer (hoặc instance admin) | Trả `token` và `path` **một lần**; chỉ lưu SHA-256; hết hạn 7 ngày; body tùy chọn `label` |
| GET | `/api/companies/:companyId/portal/invites` | như trên | Không có token hay hash; `status`: pending, accepted, expired, revoked |
| POST | `/api/companies/:companyId/portal/invites/:inviteId/revoke` | như trên | 404 nếu đã dùng, đã thu hồi hoặc của công ty khác |
| POST | `/api/portal/invites/:token/accept` | User đã đăng nhập (session) | Tạo `dr_requesters` ở công ty của lời mời (bỏ qua `companyId` client gửi); dùng một lần; 410 nếu đã dùng, hết hạn, thu hồi; 404 nếu sai token; 409 nếu đã là requester (không tiêu thụ link); khôi phục requester bị vô hiệu |
Căn cứ bảo mật là token; email không được dùng để xác thực. Một câu `UPDATE` có điều kiện trong cùng giao dịch với việc tạo requester quyết định cuộc đua (3 người nhận cùng lúc: đúng 1 thành công). Agent, user không có membership, viewer, thành viên công ty khác: 403 khi tạo/liệt kê/thu hồi. Test: `devflow-portal-invites.test.ts` (7 ca; đột biến bỏ kiểm tra "đã dùng" và kiểm tra viewer đều bị bắt). Chưa giới hạn tần suất thử token (token 256 bit nên rủi ro thấp).

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
- Web `portal/` chưa có (nhóm 4); chưa có đăng ký tài khoản qua lời mời (task 3.4).
