## ADDED Requirements

### Requirement: Danh mục hệ thống theo công ty
Hệ thống SHALL cho nhân viên của một công ty quản lý danh sách hệ thống, mỗi hệ thống gồm khóa, tên, mô tả, repo GitHub, branch, thư mục docs và token chỉ đọc lưu dưới dạng secret. Dữ liệu của công ty này MUST NOT đọc hoặc sửa được từ công ty khác.

#### Scenario: Tạo hệ thống
- **WHEN** nhân viên tạo hệ thống với URL `https://github.com/acme/hr-portal` và token
- **THEN** hệ thống được lưu, token chỉ lưu thành secret công ty và không bao giờ trả lại qua API

#### Scenario: Cách ly công ty
- **WHEN** người dùng của công ty B đọc hoặc gán hệ thống của công ty A
- **THEN** yêu cầu bị từ chối (403 hoặc 404)

### Requirement: Gán hệ thống ở Triage review
Triage agent SHALL đề xuất tối đa 3 hệ thống thuộc danh mục; người duyệt SHALL xác nhận hoặc đổi danh sách khi approve, và danh sách được lưu cho yêu cầu.

#### Scenario: Approve kèm hệ thống
- **WHEN** người duyệt approve một yêu cầu ở `triage_review` và chọn hệ thống `hr-portal`
- **THEN** yêu cầu chuyển sang `ba_spec` và được gán `hr-portal` trong cùng thao tác

### Requirement: Agent BA đề xuất spec
Khi một yêu cầu ở `ba_spec` chưa có đề xuất, DevFlow SHALL chạy agent BA trên bản clone của các hệ thống đã gán, kiểm đầu ra bằng schema strict, lưu đề xuất kèm commit SHA đã đọc và chuyển yêu cầu sang `ba_review`. Agent MUST chỉ có tool đọc và MUST NOT đọc được thư mục dữ liệu của instance.

#### Scenario: Lượt chạy thành công
- **WHEN** yêu cầu REQ-12 vào `ba_spec` với hệ thống `hr-portal`
- **THEN** có một đề xuất `proposed` ở stage `ba_spec` gồm tóm tắt, tiêu chí nghiệm thu, vùng ảnh hưởng có `path:line` và SHA, và yêu cầu nằm ở `ba_review`

#### Scenario: Đầu ra sai schema
- **WHEN** agent trả JSON thiếu trường bắt buộc hai lần liên tiếp
- **THEN** không có đề xuất nào được lưu, yêu cầu vẫn ở `ba_spec`, lỗi hiện trong mục lỗi gần đây

#### Scenario: Hết ngân sách
- **WHEN** một lượt chạm `--max-budget-usd` hoặc công ty chạm trần USD trong ngày
- **THEN** lượt đó được ghi là lỗi ngân sách và worker không chạy thêm cho công ty đó đến 0h UTC

### Requirement: Duyệt BA spec
Nhân viên SHALL xem, sửa, approve, reject hoặc request_changes một đề xuất ở `ba_review`; mọi field bị sửa MUST được ghi vào `dr_overrides`; request_changes MUST có lý do và lý do này SHALL được đưa vào lượt chạy tiếp theo.

#### Scenario: Request changes
- **WHEN** người duyệt chọn request_changes với lý do "thiếu luồng phê duyệt của trưởng phòng"
- **THEN** yêu cầu quay về `ba_spec`, đề xuất cũ thành `superseded`, và lượt chạy sau nhận lý do đó trong đầu vào

#### Scenario: Approve có sửa
- **WHEN** người duyệt sửa tiêu chí nghiệm thu rồi approve
- **THEN** đề xuất thành `overridden`, có dòng `dr_overrides` cho field đó, và yêu cầu chuyển sang `tech_plan`
