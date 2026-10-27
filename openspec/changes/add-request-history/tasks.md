## 1. Duyệt

- [ ] 1.1 Chủ dự án duyệt proposal và design (không có DDL), hoặc chọn mặc định ở "Open Questions"

## 2. Server

- [ ] 2.1 Đọc code để chốt các stage nào ghi `dr_overrides` và chi phí lưu ở đâu cho từng vai; ghi vào design
- [ ] 2.2 `GET …/devflow/requests/:caseId/history` gộp sự kiện, overrides, đề xuất, sổ hoạt động, email; chuẩn hóa mục; tổng chi phí; thời gian từng stage; test (cách ly công ty 404, từng loại mục, ẩn email và token, phân trang)

## 3. Giao diện

- [ ] 3.1 Helper thuần (chữ cho từng loại mục, diff trường cũ → mới, thời gian ở stage) + test
- [ ] 3.2 Trang `/requests/:caseKey` (thông tin, dòng thời gian, chi phí, thời gian từng stage); link History ở 5 trang duyệt; route
- [ ] 3.3 Xem trên trình duyệt với REQ-1 của RESKI (đã đi hết Triage → QA)

## 4. Tài liệu

- [ ] 4.1 KB `request-history.md`, status
