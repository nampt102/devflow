# approver-roles Specification

## Purpose
Nhân viên có một hoặc nhiều vai trò nghiệp vụ (BA, Tech Lead) trong từng công ty, và các stage duyệt của pipeline `dev-request` chỉ cho người có vai trò phù hợp quyết định, để mọi cổng duyệt do đúng người chịu trách nhiệm.

## Requirements

### Requirement: Nhân viên có nhiều vai trò trong công ty
Hệ thống SHALL lưu vai trò nghiệp vụ của nhân viên theo từng công ty; một nhân viên MAY có nhiều vai trò cùng lúc (`ba`, `tech_lead`) và vai trò của công ty này MUST NOT có hiệu lực ở công ty khác.

#### Scenario: Một người kiêm hai vai
- **WHEN** chủ sở hữu gán cả `ba` và `tech_lead` cho cùng một nhân viên trong công ty A
- **THEN** nhân viên đó có cả hai vai trong công ty A
- **AND** không có vai nào trong công ty B

#### Scenario: Gán trùng
- **WHEN** vai `ba` đã được gán cho nhân viên và được gán lần nữa
- **THEN** hệ thống không tạo bản ghi trùng và trả về danh sách vai hiện tại

#### Scenario: Vai không hợp lệ
- **WHEN** yêu cầu gán một vai không nằm trong danh sách `ba`, `tech_lead`
- **THEN** hệ thống từ chối với lỗi 422 và không ghi gì

### Requirement: Chỉ chủ sở hữu và instance admin quản lý vai trò
Hệ thống SHALL chỉ cho phép chủ sở hữu công ty (membership `owner`) và instance admin xem, gán và gỡ vai trò của công ty đó; người khác, agent và requester MUST bị từ chối, và công ty không truy cập được MUST trả 404. Mọi thay đổi vai trò SHALL ghi `activity_log` với người thực hiện, người nhận và vai trò.

#### Scenario: Nhân viên thường gán vai cho chính mình
- **WHEN** một board user không phải owner gọi API gán vai trò
- **THEN** hệ thống trả 403 và không đổi vai trò nào

#### Scenario: Gán vai cho người ngoài công ty
- **WHEN** owner gán vai cho một user không có membership đang hoạt động trong công ty
- **THEN** hệ thống từ chối với lỗi 422

#### Scenario: Có audit
- **WHEN** owner gán hoặc gỡ một vai trò
- **THEN** `activity_log` có một dòng ghi người thực hiện, người nhận và vai trò

### Requirement: Màn hình quản lý vai trò
Board UI SHALL có màn hình liệt kê nhân viên của công ty kèm vai trò; chủ sở hữu và instance admin MAY gán hoặc gỡ vai từ đó, người khác MUST chỉ xem. Màn hình MUST dùng cùng API quản lý vai trò và không có đường ghi riêng.

#### Scenario: Owner gán vai trên màn hình
- **WHEN** chủ sở hữu bật vai `tech_lead` cho một nhân viên và lưu
- **THEN** vai được ghi qua API quản lý vai trò và bảng hiện vai mới
- **AND** có một dòng `activity_log`

#### Scenario: Nhân viên thường
- **WHEN** nhân viên không phải owner mở màn hình
- **THEN** thấy danh sách vai nhưng không có điều khiển gán hoặc gỡ

#### Scenario: Chủ sở hữu hiển thị đúng
- **WHEN** danh sách có chủ sở hữu công ty hoặc instance admin
- **THEN** dòng đó nêu rõ người này luôn duyệt được dù chưa có vai

### Requirement: Stage duyệt đòi vai trò
Stage review của pipeline MAY cấu hình người duyệt theo vai trò (`approver.kind = role` với danh sách vai); khi đó hệ thống SHALL cho phép quyết định (approve, reject, request_changes) chỉ khi người dùng có **ít nhất một** vai trong danh sách, hoặc là chủ sở hữu công ty, hoặc là instance admin; mọi trường hợp khác MUST trả 403 `review_required` và không đổi trạng thái case. Agent MUST NOT bao giờ qua được stage này.

#### Scenario: Có đúng vai
- **WHEN** một người có vai `tech_lead` duyệt kế hoạch ở `plan_review`
- **THEN** quyết định được ghi như bình thường

#### Scenario: Thiếu vai
- **WHEN** một người chỉ có vai `ba` duyệt kế hoạch ở `plan_review` (chỉ cho `tech_lead`)
- **THEN** hệ thống trả 403 `review_required`
- **AND** case giữ nguyên stage và không có override nào được ghi

#### Scenario: Vai trong danh sách, không phải vai đầu
- **WHEN** một người chỉ có vai `tech_lead` duyệt spec ở `ba_review` (cho `ba` hoặc `tech_lead`)
- **THEN** quyết định được chấp nhận

#### Scenario: Chủ sở hữu khi chưa gán vai
- **WHEN** công ty chưa gán vai cho ai và chủ sở hữu duyệt ở bất kỳ stage nào dùng vai
- **THEN** quyết định được chấp nhận

#### Scenario: Agent
- **WHEN** một agent key cố duyệt hoặc chuyển case ra khỏi stage dùng vai
- **THEN** hệ thống trả 403 `review_required`

#### Scenario: Chuyển stage trực tiếp không né được
- **WHEN** người không có vai chuyển case ra khỏi stage duyệt bằng API chuyển stage thay vì API duyệt
- **THEN** hệ thống cũng trả 403 `review_required`

### Requirement: Pipeline `dev-request` dùng vai trò
Pipeline `dev-request` SHALL cấu hình `triage_review` và `ba_review` cho vai `ba` hoặc `tech_lead`, và `plan_review` chỉ cho `tech_lead`; việc cập nhật cấu hình này cho công ty đã seed SHALL chạy lại được và MUST NOT đổi các phần cấu hình khác của stage.

#### Scenario: Cập nhật công ty đã seed
- **WHEN** script seed chạy cho công ty đã có pipeline `dev-request`
- **THEN** `approver` của ba stage trên được đặt theo vai trò
- **AND** các trường khác của stage (stage đích, yêu cầu lý do) không đổi

#### Scenario: Chạy lại
- **WHEN** script chạy lần thứ hai
- **THEN** không có thay đổi nào được ghi

### Requirement: Màn hình duyệt phản ánh quyền
Chi tiết case của ba màn hình duyệt SHALL cho biết người xem có quyết định được không (`canDecide`); khi không, giao diện MUST tắt các nút quyết định và nêu vai cần có, nhưng quyền thật vẫn do máy chủ thi hành.

#### Scenario: Người xem không có vai
- **WHEN** nhân viên không có vai phù hợp mở một case ở `plan_review`
- **THEN** các nút approve, reject, request_changes bị tắt kèm lời giải thích về vai cần có
- **AND** nhân viên vẫn xem được nội dung case
