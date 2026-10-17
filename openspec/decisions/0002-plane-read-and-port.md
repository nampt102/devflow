# 0002. Đọc source Plane và viết lại bằng TypeScript; hoãn xét AGPL

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt (rủi ro license còn mở)
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Plane (https://github.com/makeplane/plane) là AGPL-3.0. Ban đầu quyết định không copy code. Đã tư vấn các lựa chọn: clean-room, xin giấy phép thương mại, hoặc port và chấp nhận AGPL.

## Quyết định
Không dùng clean-room. Chủ dự án chọn đọc source Plane và port các phần cần (ngữ nghĩa intake/triage, activity diff, UI hàng chờ) sang TypeScript. Hiện đang build để test; vấn đề license (AGPL) sẽ xem xét lại sau khi hoàn thành. Chưa có quy tắc tách package hay ghi nguồn. Bản clone Plane nằm ngoài repo ở ../_ref/plane.

## Lý do và hệ quả
Phần phái sinh có thể bị ràng buộc bởi AGPL-3.0 (công bố source cho user truy cập qua mạng, ảnh hưởng ranh giới sản phẩm). Phải xem lại, tốt nhất có pháp chế, trước khi triển khai thật hoặc phân phối. Ưu tiên không port khi Paperclip đã có tương đương; dùng thư viện license thoáng trực tiếp.
