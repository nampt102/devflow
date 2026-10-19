# Intake Portal: API requester (hiện trạng)

Nguồn: `server/src/devflow/portal/`, change `openspec/changes/archive/2026-10-18-add-intake-portal`, ADR 0011. Đã kiểm chứng bằng `server/src/__tests__/devflow-portal.test.ts` (20 test trên Postgres nhúng: 13 portal + 7 lời mời). **Chưa chạy trên stack Docker đang chạy** (image cũ chưa chứa code này) và chưa có web.

## Endpoint (đều sau guard `requireRequester`)
| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/portal/me` | `companyId`, `requesterId` của chính user |
| GET | `/api/portal/companies` | Danh sách `{companyId, name}` các công ty mà user là requester đang hoạt động, xếp theo tên (rỗng nếu không phải requester ở đâu; 401 nếu chưa đăng nhập). Không cần `companyId`. Portal dùng để hỏi công ty khi user thuộc nhiều công ty |
| (mọi gọi `/api/portal/me` và `/api/portal/requests…`) | | Người thuộc **nhiều công ty** phải gửi `?companyId=` (400 `companyId is required` nếu thiếu, 403 nếu không thuộc công ty đó). Portal luôn gửi sau khi đã biết công ty |
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
| POST | `/api/portal/invites/:token/accept` | User đã đăng nhập (session) | Tạo `dr_requesters` ở công ty của lời mời (bỏ qua `companyId` client gửi); dùng một lần; chính người đã dùng link (kể cả vừa `register` xong) gọi lại thì nhận 200 với requester của mình (idempotent; giao diện portal gọi `accept` ngay sau đăng ký nên cần điều này); người khác nhận 410 nếu đã dùng, hết hạn, thu hồi; 404 nếu sai token; 409 nếu đã là requester (không tiêu thụ link); khôi phục requester bị vô hiệu |
| POST | `/api/portal/invites/:token/register` | Chưa đăng nhập (token là thông tin xác thực) | Body `{name, email, password}` (tên 1–100, email hợp lệ ≤254, mật khẩu 8–128, không cắt khoảng trắng). Tạo `user` + `account` (credential) + `dr_requesters` trong một giao dịch rồi trả 201 `{companyId, requesterId}`; **không tạo phiên**, client gọi `/api/auth/sign-in/email`. 409 `account_exists` (không phân biệt hoa thường) khi email đã có tài khoản và link không bị tiêu thụ; 404/410 như `accept`; 400 khi dữ liệu sai; 429 khi quá giới hạn |
Chạy được khi `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` (đã kiểm chứng bằng test với instance better-auth đóng đăng ký). Thứ tự bên trong: kiểm tra link (rẻ) trước khi băm mật khẩu; khóa advisory theo email vì `user.email` không có unique index; `UPDATE` có điều kiện cướp link; thua cuộc đua thì cả giao dịch (kể cả user mới) bị hủy; activity log không chứa email, mật khẩu hay token. **Giới hạn tần suất:** 10 lần/phút/IP, một bộ đếm chung cho `register` và `accept`, trong bộ nhớ tiến trình (không chia sẻ giữa nhiều instance; IP phụ thuộc cấu hình proxy, chưa xác nhận). Test: `devflow-portal-register.test.ts` (8 ca, gồm kiểm tra `accept` ngay sau `register`) và `devflow-portal-register-rollback.test.ts` (1 ca); 6 đột biến (bỏ khóa email, bỏ kiểm tra email, bỏ kiểm tra link trước khi băm, bỏ điều kiện dùng-một-lần, bỏ giới hạn tần suất, lưu mật khẩu thô) đều làm test fail.

Căn cứ bảo mật là token; email không được dùng để xác thực. Một câu `UPDATE` có điều kiện trong cùng giao dịch với việc tạo requester quyết định cuộc đua (3 người nhận cùng lúc: đúng 1 thành công). Agent, user không có membership, viewer, thành viên công ty khác: 403 khi tạo/liệt kê/thu hồi. Test: `devflow-portal-invites.test.ts` (8 ca; đột biến bỏ kiểm tra "đã dùng" và kiểm tra viewer đều bị bắt). Chưa giới hạn tần suất thử token (token 256 bit nên rủi ro thấp).

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
- Nhân viên mới khi đăng ký công khai đóng: dùng `POST /api/admin/users` (xem `kb/admin-accounts.md`); đăng ký công khai vẫn mở cho tới khi vận hành quyết định đóng.
