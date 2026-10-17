# Intake Portal: web app `portal/` (hiện trạng)

Nguồn: `portal/`, `server/src/devflow/portal/static.ts`, change `openspec/changes/add-intake-portal` (nhóm 4), ADR 0011. API phía sau: `kb/intake-portal-api.md`.

## Cấu trúc
- Workspace package `@devflow/portal` (private): React 19 + Vite + TypeScript, **chỉ tiếng Việt**, không dùng thư viện router/i18n/UI; phiên bản dependency trùng với `ui/` nên lockfile chỉ thêm một khối importer.
- `src/vi.ts` chứa toàn bộ chuỗi giao diện; nhãn trạng thái do server trả (`status-labels.ts`). `src/api.ts` (client + ánh xạ lỗi sang tiếng Việt), `src/route.ts` (điều hướng bằng History API), `src/files.ts` (kiểm tra tệp phía client, phản chiếu giới hạn server), `src/pages.tsx`, `src/App.tsx`, `src/styles.css` (CSS thuần, sáng/tối theo hệ thống, dùng được trên điện thoại).
- Màn hình: đăng nhập / tạo tài khoản; `/portal/invite/:token` (đăng nhập hoặc đăng ký rồi nhận lời mời, mỗi link chỉ gọi accept một lần dù StrictMode chạy effect hai lần); danh sách yêu cầu; gửi yêu cầu (tối đa 5 tệp); chi tiết (trạng thái, tải tệp, bổ sung tệp). User đăng nhập nhưng chưa là requester thấy thông báo "chưa được cấp quyền".

## Chạy và build
- Dev: `pnpm --filter @devflow/portal dev` (cổng 5174, proxy `/api` tới `http://localhost:3100`, base `/portal/`).
- Build: `pnpm --filter @devflow/portal build` → `portal/dist`; Dockerfile có bước này sau build `ui`. Server phục vụ `portal/dist` (hoặc `server/portal-dist`) ở `/portal` **trước** catch-all của board; `/portal` chuyển 301 sang `/portal/`.
- Kiểm tra: `pnpm --filter @devflow/portal typecheck` và `... test` (14 test logic); phía server: `server/src/__tests__/devflow-portal-static.test.ts` (4 ca).
- Trên máy này không có pnpm/node_modules ở host: typecheck, test và build chạy trong container từ image `devflow-paperclip:local` (cài với `NODE_ENV=development pnpm install --prod=false --frozen-lockfile --filter @devflow/portal...`, vì image đặt `NODE_ENV=production`).

## Đã kiểm chứng trên stack Docker thật (2026-10-17)
Trình duyệt tích hợp, tài khoản test cục bộ (biến `DEVFLOW_TEST_PORTAL_EMAIL/PASSWORD` trong `docker/.env`, gitignore): tạo link mời bằng API staff → mở link → tạo tài khoản → xác nhận lời mời → danh sách trống → gửi yêu cầu kèm một ảnh PNG → trang chi tiết `REQ-1` trạng thái "Đã tiếp nhận", tệp tải về đúng 70 byte (`attachment`, `nosniff`, `no-store`). Phía board: case `REQ-1` ở `triage`, `fields` rỗng, event `ingested` do actor `user` (requester), lời mời ở trạng thái `accepted`. Giao diện điện thoại (375 px) dùng được; nhãn form gắn đúng với ô nhập.

### Đăng ký qua lời mời (task 3.4), kiểm chứng trên trình duyệt sau khi build lại
- Trang đăng nhập thường chỉ có đăng nhập kèm gợi ý mở link mời; trang lời mời mặc định là "Tạo tài khoản và nhận lời mời".
- Email đã có tài khoản (gõ khác hoa thường): thông báo tiếng Việt và form tự chuyển sang đăng nhập, link vẫn dùng được.
- Đăng ký mới hoàn chỉnh: tạo tài khoản, đăng nhập, "Đã xác nhận lời mời", vào danh sách trống; mở thẳng `/portal/requests/1` của người khác ra "Không tìm thấy".
- **Lỗi tìm ra ở lần thử đầu:** đăng ký thành công nhưng màn hình báo "lời mời đã được sử dụng" vì giao diện gọi `accept` sau `register` và link đã bị dùng. Đã sửa ở server (accept idempotent cho đúng người dùng link, commit `3afb73947`); mở lại link đã dùng bằng đúng tài khoản giờ ra "Đã xác nhận lời mời". Test tự động không bắt được lỗi này khi chưa có ca "accept ngay sau register"; ca đó đã được thêm.

## Chưa làm / hạn chế
- Đăng ký công khai vẫn mở; chỉ nên đóng sau task 3.5 (ADR 0012). Màn hình đăng nhập không còn nút "Tạo tài khoản" khi không có link mời; với link mời, form mặc định là "Tạo tài khoản và nhận lời mời" (gọi `register` rồi đăng nhập), email đã có tài khoản thì tự chuyển sang đăng nhập.
- Chưa có màn hình cho nhân viên tạo link mời (hiện dùng API `POST /api/companies/:id/portal/invites`).
- Chưa kiểm chứng trên Safari/Firefox và trình đọc màn hình; chưa có test thành phần React (chỉ test logic thuần).
- User là requester của nhiều công ty chưa chọn được công ty trên giao diện (API cần `companyId`).
- Xóa file đang chọn trước khi gửi, hay lỗi mạng giữa chừng khi tải lên, mới kiểm tra bằng logic, chưa bằng thao tác thật.
