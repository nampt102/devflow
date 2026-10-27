## ADDED Requirements

### Requirement: Trang chi tiết và dòng thời gian của một yêu cầu
Hệ thống SHALL có trang chi tiết yêu cầu cho nhân viên của công ty, hiện thông tin yêu cầu và một dòng thời gian gộp (mới nhất trên cùng) gồm: gửi yêu cầu, chuyển stage, quyết định kèm người và lý do, thay đổi từng trường người duyệt sửa so với đề xuất agent, mỗi lượt agent chạy (vai, phiên bản prompt, model, chi phí, kết quả), và email gửi requester (loại, thời điểm, kết quả). Trang SHALL hiện tổng chi phí agent và thời gian ở từng stage. Người ngoài công ty SHALL nhận 404.

#### Scenario: Người duyệt đổi ưu tiên
- **WHEN** ở Triage review người duyệt đổi ưu tiên từ medium (agent đề xuất) thành high với lý do "khách lớn"
- **THEN** dòng thời gian có mục "Priority: medium → high" kèm người sửa và lý do

#### Scenario: Agent Dev lỗi rồi chạy lại
- **WHEN** lượt Dev đầu lỗi `publish_denied` và lượt sau thành công với PR
- **THEN** dòng thời gian có cả hai lượt, lượt lỗi ghi kind, lượt thành công có link PR và chi phí

### Requirement: Không lộ dữ liệu nhạy cảm
Lịch sử SHALL không chứa địa chỉ email, token, nội dung prompt hay transcript của agent.

#### Scenario: Email cho requester
- **WHEN** hệ thống đã gửi email báo trạng thái cho requester
- **THEN** dòng thời gian ghi loại email và thời điểm, không có địa chỉ

### Requirement: Mở từ các trang duyệt
Mỗi trang duyệt SHALL có link "History" tới trang chi tiết của yêu cầu đang xem.

#### Scenario: Từ Code review
- **WHEN** người duyệt bấm History ở Code review
- **THEN** trang chi tiết của đúng yêu cầu đó mở ra
