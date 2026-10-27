## Why

Thông tin về một yêu cầu nằm rải ở nhiều nơi: sự kiện chuyển stage và quyết định (`pipeline_case_events`), các chỗ người duyệt sửa đề xuất của agent (`dr_overrides`: trường, giá trị agent, giá trị cuối, lý do), các đề xuất của từng agent và chi phí (`dr_agent_outputs`), lỗi agent và email đã gửi (`activity_log`). Trang Case của Paperclip chỉ hiện sự kiện của core, không hiện những gì người duyệt sửa so với agent hay agent đã tốn bao nhiêu. Khi requester hỏi "sao yêu cầu của tôi bị đổi ưu tiên" hay chủ dự án muốn xem một yêu cầu đã qua những ai, tốn bao nhiêu, không có chỗ nào trả lời. Plane có activity theo từng trường (cũ → mới); đây là phần "activity diff" định port theo ADR 0002 mà chưa có màn hình.

## What Changes

- **Trang chi tiết yêu cầu cho nhân viên** (`/requests/:caseKey`): thông tin yêu cầu (mô tả, tệp đính kèm, requester, hệ thống, ưu tiên, phân loại, stage hiện tại) và **dòng thời gian** gộp, mới nhất trên cùng:
  - gửi yêu cầu, chuyển stage, quyết định (ai, approve/reject/request_changes, lý do);
  - **thay đổi từng trường** người duyệt sửa so với agent (ví dụ "Priority: medium → high (agent đề xuất medium), lý do …");
  - mỗi lần agent chạy: vai, phiên bản prompt, model, chi phí, kết quả (đề xuất / lỗi kind / bỏ cuộc); liên kết tới PR khi có;
  - email gửi cho requester (loại, thời điểm, gửi được hay lỗi; không hiện địa chỉ).
- Tổng chi phí agent của yêu cầu và thời gian ở từng stage.
- Mở từ thẻ ở trang Requests (`add-request-board`) và từ link "History" ở mỗi trang duyệt.
- **Chỉ đọc.** Không đổi gì về cách ghi dữ liệu.

## Capabilities

### New Capabilities
- `request-history`: trang chi tiết một yêu cầu cho nhân viên với dòng thời gian gộp quyết định, thay đổi từng trường, lượt chạy agent, chi phí và email.

### Modified Capabilities
Không.

## Impact

- Không có migration, không đổi cách ghi.
- `server/src/devflow/`: `GET …/devflow/requests/:caseId/history` gộp bốn nguồn, cách ly công ty, ẩn nội dung nhạy cảm (địa chỉ email, token, nội dung prompt).
- `ui/`: trang chi tiết yêu cầu, link History ở các trang duyệt.

## Ngoài phạm vi
Requester xem lịch sử trên portal; bình luận trên yêu cầu; xuất lịch sử ra file; sửa yêu cầu từ trang này.
