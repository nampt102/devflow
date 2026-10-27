## 1. Duyệt

- [ ] 1.1 Chủ dự án duyệt proposal, design và mockup (hoặc chọn mặc định ở "Open Questions"); không có DDL

## 2. Khung chung

- [ ] 2.1 `ui/src/components/review/ReviewWorkspace.tsx`: thanh trên, hàng chờ gọn, chi tiết có điều hướng mục, thanh quyết định ghim, xác nhận Reject, lọc/sắp xếp, ngăn Metrics, màn hình hẹp
- [ ] 2.2 Hook `useReviewHotkeys`, đồng bộ `?case=`, tự sang mục kế + test (bỏ qua khi gõ, chọn mục kế/trước, link sâu, xác nhận Reject)
- [ ] 2.3 Kiểm chứng dữ liệu "vòng trước" ở năm API chi tiết; thêm `previousRound` (chỉ đọc) nếu thiếu + test server

## 3. Chuyển từng trang (mỗi trang một commit, giữ test hành vi)

- [ ] 3.1 QA sign-off
- [ ] 3.2 Code review
- [ ] 3.3 Plan review
- [ ] 3.4 BA review
- [ ] 3.5 Triage review (sửa trường, bản trùng, hệ thống)
- [ ] 3.6 Email nhắc nhân viên dùng link `?case=`

## 4. Kiểm chứng

- [ ] 4.1 `pnpm check:token-gates`, typecheck UI, test UI; xem trên trình duyệt cả năm trang ở 1440px và 375px, sáng và tối, chỉ dùng bàn phím

## 5. Tài liệu

- [ ] 5.1 KB `review-workspace.md` (thay mô tả UI trong các KB stage), status
