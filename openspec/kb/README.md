# Knowledge base (KB)

Kiến thức bền của dự án, mô tả **hiện trạng**. Spec hành vi nằm ở `../specs/`, đề xuất thay đổi ở `../changes/`.

Chỉ tạo file khi đã có nội dung thật. Gợi ý:

| File | Nội dung |
|---|---|
| `glossary.md` | Thuật ngữ nghiệp vụ và kỹ thuật |
| `tech-stack.md` | Công nghệ, phiên bản, cách chạy/test |
| `architecture.md` | Cấu trúc hệ thống, luồng chính |
| `data-model.md` | Bảng/entity chính (chia nhỏ theo module nếu dài) |
| `modules/<tên>.md` | Mô tả từng module |
| `conventions.md` | Quy ước code, đặt tên, API |

Quy tắc: mỗi file dưới ~300 dòng; ghi đường dẫn file code làm bằng chứng; chỗ chưa chắc ghi "(chưa xác nhận)"; cập nhật cùng lúc với code, không để lệch.
