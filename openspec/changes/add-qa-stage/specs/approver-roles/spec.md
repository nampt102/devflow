## MODIFIED Requirements

### Requirement: Nhân viên có nhiều vai trò trong công ty
Hệ thống SHALL lưu vai trò nghiệp vụ của nhân viên theo từng công ty; một nhân viên MAY có nhiều vai trò cùng lúc (`ba`, `tech_lead`, `qa`) và vai trò của công ty này MUST NOT có hiệu lực ở công ty khác.

#### Scenario: Một người kiêm hai vai
- **WHEN** chủ sở hữu gán cả `ba` và `tech_lead` cho cùng một nhân viên trong công ty A
- **THEN** nhân viên đó có cả hai vai trong công ty A
- **AND** không có vai nào trong công ty B

#### Scenario: Gán trùng
- **WHEN** vai `ba` đã được gán cho nhân viên và được gán lần nữa
- **THEN** hệ thống không tạo bản ghi trùng và trả về danh sách vai hiện tại

#### Scenario: Vai không hợp lệ
- **WHEN** yêu cầu gán một vai không nằm trong danh sách `ba`, `tech_lead`, `qa`
- **THEN** hệ thống từ chối với lỗi 422 và không ghi gì

### Requirement: Pipeline `dev-request` dùng vai trò
Pipeline `dev-request` SHALL cấu hình `triage_review` và `ba_review` cho vai `ba` hoặc `tech_lead`, `plan_review` và `code_review` chỉ cho `tech_lead`, và `qa_signoff` cho vai `qa` hoặc `tech_lead`; việc cập nhật cấu hình này cho công ty đã seed SHALL chạy lại được và MUST NOT đổi các phần cấu hình khác của stage, trừ đích của request_changes ở `qa_signoff` (về `dev`) và bước chuyển `qa_signoff → dev` mà QA cần.

#### Scenario: Cập nhật công ty đã seed
- **WHEN** script seed chạy cho công ty đã có pipeline `dev-request`
- **THEN** `approver` của các stage duyệt trên được đặt theo vai trò
- **AND** các trường khác của stage (stage đích, yêu cầu lý do) không đổi, trừ đích request_changes của `qa_signoff`

#### Scenario: Chạy lại
- **WHEN** script chạy lần thứ hai
- **THEN** không có thay đổi nào được ghi
