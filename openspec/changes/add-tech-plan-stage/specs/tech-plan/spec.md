## Purpose

Biến một yêu cầu có BA spec đã duyệt thành kế hoạch kỹ thuật (task theo hệ thống, file cần sửa có trích dẫn, cỡ việc, kế hoạch test), do agent chỉ có quyền đọc đề xuất và nhân viên duyệt trước khi sang Dev.

## ADDED Requirements

### Requirement: Agent Planner đề xuất kế hoạch kỹ thuật
Khi một yêu cầu ở `tech_plan` chưa có đề xuất, DevFlow SHALL chạy agent Planner của công ty trên bản clone của các hệ thống đã gán, với spec BA đã duyệt làm đầu vào, kiểm đầu ra bằng schema strict, lưu đề xuất kèm commit SHA đã đọc và chuyển yêu cầu sang `plan_review`.

#### Scenario: Lượt chạy thành công
- **WHEN** yêu cầu REQ-12 vào `tech_plan` với spec BA đã duyệt và hệ thống `hr-portal`
- **THEN** có một đề xuất `proposed` ở stage `tech_plan` gồm tóm tắt, hướng giải quyết, ít nhất một task, kế hoạch test và SHA của `hr-portal`, và yêu cầu nằm ở `plan_review`

#### Scenario: Đầu vào là spec đã duyệt
- **WHEN** người duyệt BA đã sửa tiêu chí nghiệm thu trước khi approve
- **THEN** agent Planner nhận tiêu chí nghiệm thu đã sửa, không phải bản agent BA viết

#### Scenario: Đầu ra sai schema
- **WHEN** agent trả JSON thiếu trường bắt buộc hai lần liên tiếp
- **THEN** không có đề xuất nào được lưu, yêu cầu vẫn ở `tech_plan`, lỗi hiện trong mục lỗi gần đây

### Requirement: Task kỹ thuật có trích dẫn và kiểm được
Mỗi task trong kế hoạch SHALL có mã, tiêu đề, hệ thống, mô tả, cỡ `S`, `M` hoặc `L`, danh sách file cần sửa và danh sách task phụ thuộc. DevFlow MUST từ chối kế hoạch có task thuộc hệ thống không được gán, đường dẫn ra ngoài repo, mã task trùng, phụ thuộc vào mã không tồn tại hoặc phụ thuộc vòng.

#### Scenario: Phụ thuộc vòng
- **WHEN** task T1 phụ thuộc T2 và T2 phụ thuộc T1
- **THEN** đầu ra bị từ chối như sai schema và agent được yêu cầu viết lại

#### Scenario: Hệ thống không được gán
- **WHEN** một task ghi hệ thống `billing` trong khi yêu cầu chỉ được gán `hr-portal`
- **THEN** đầu ra bị từ chối như sai schema

### Requirement: Agent Planner chỉ đọc và tách biệt
Agent Planner MUST chỉ có tool đọc, MUST NOT đọc được thư mục dữ liệu của instance, workspace hay transcript của stage khác. DevFlow MUST NOT chạy hai lượt agent (BA hoặc Tech Plan) cùng lúc trong một instance, và MUST từ chối chạy agent có cấu hình khác cấu hình chuẩn.

#### Scenario: Agent bị sửa cấu hình
- **WHEN** ai đó thêm tool `Bash` cho agent Planner
- **THEN** worker không chạy agent đó, ghi lỗi cấu hình một lần và thử lại sau

#### Scenario: Không chạy song song với BA
- **WHEN** một lượt BA đang chạy và có yêu cầu chờ ở `tech_plan`
- **THEN** lượt Tech Plan chỉ bắt đầu sau khi lượt BA kết thúc và workspace BA đã được dọn

### Requirement: Chi phí Tech Plan có trần
DevFlow SHALL giới hạn chi phí mỗi lượt Tech Plan và tổng chi phí Tech Plan mỗi công ty trong một ngày UTC, tách khỏi ngân sách BA.

#### Scenario: Chạm trần ngày
- **WHEN** chi phí Tech Plan của công ty trong ngày đạt trần
- **THEN** worker Tech Plan không chạy thêm cho công ty đó đến 0h UTC, ghi một lần, trong khi BA của công ty đó vẫn chạy theo ngân sách riêng

### Requirement: Duyệt kế hoạch kỹ thuật
Nhân viên SHALL xem, sửa, approve, reject hoặc request_changes một đề xuất ở `plan_review`. Các trường văn bản và tiêu đề, mô tả, cỡ của task sửa được; mọi field bị sửa MUST được ghi vào `dr_overrides`; kế hoạch đã duyệt MUST được lưu cùng đề xuất; request_changes MUST có lý do và lý do đó SHALL được đưa vào lượt chạy tiếp theo.

#### Scenario: Approve có sửa cỡ task
- **WHEN** người duyệt đổi cỡ task T2 từ `S` sang `M` rồi approve
- **THEN** đề xuất thành `overridden`, có dòng `dr_overrides` cho `tasks`, kế hoạch đã duyệt có T2 cỡ `M`, và yêu cầu chuyển sang `dev`

#### Scenario: Request changes
- **WHEN** người duyệt chọn request_changes với lý do "thiếu bước migration dữ liệu cũ"
- **THEN** yêu cầu quay về `tech_plan`, đề xuất cũ thành `superseded`, và lượt chạy sau nhận lý do đó trong đầu vào

#### Scenario: Cách ly công ty
- **WHEN** nhân viên của công ty B mở hoặc quyết định một kế hoạch của công ty A
- **THEN** yêu cầu bị từ chối (403 hoặc 404)
