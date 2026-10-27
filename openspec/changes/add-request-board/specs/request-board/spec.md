## ADDED Requirements

### Requirement: Bảng yêu cầu theo stage
Hệ thống SHALL có trang Requests cho nhân viên hiện mọi yêu cầu chưa kết thúc của công ty, mỗi cột là một stage của pipeline `dev-request` theo thứ tự của pipeline, cùng tối đa 50 yêu cầu Done và Cancelled gần nhất ở cột thu gọn. Mỗi thẻ SHALL có mã, tiêu đề, ưu tiên, phân loại, hệ thống, requester, tuổi, thời gian ở stage hiện tại và đang chờ người hay chờ agent. Người ngoài công ty SHALL nhận 403.

#### Scenario: Yêu cầu chờ duyệt BA
- **WHEN** một yêu cầu ở stage `ba_review` có spec đang chờ
- **THEN** thẻ nằm ở cột BA review, ghi "Waiting for a person", và bấm thẻ mở trang BA review ở yêu cầu đó

#### Scenario: Agent lỗi
- **WHEN** lần chạy agent gần nhất của yêu cầu thất bại
- **THEN** thẻ hiện loại lỗi và thời điểm

### Requirement: Không đổi stage từ bảng
Trang Requests SHALL không cho đổi stage hay quyết định; mọi chuyển stage SHALL vẫn đi qua các trang duyệt.

#### Scenario: Thử kéo thẻ
- **WHEN** người dùng kéo một thẻ
- **THEN** không có gì thay đổi

### Requirement: Lọc và view lưu sẵn
Trang SHALL lọc theo ưu tiên, phân loại, hệ thống, requester, chữ trong tiêu đề hoặc mã, và "chỉ cái tôi quyết định được"; SHALL chuyển giữa dạng Kanban và danh sách; và SHALL lưu, chọn lại, xóa các view có tên (bộ lọc + dạng) trên trình duyệt của người dùng.

#### Scenario: Lưu view
- **WHEN** người dùng lọc ưu tiên "high" và hệ thống "reski" rồi lưu với tên "Reski gấp"
- **THEN** lần sau chọn "Reski gấp" áp lại đúng bộ lọc và dạng hiển thị
