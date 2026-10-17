## ADDED Requirements

### Requirement: Requester isolation
Hệ thống SHALL chỉ cho phép requester đọc và ghi các yêu cầu do chính họ tạo, trong công ty gắn với bản ghi `dr_requesters` của họ. Hệ thống SHALL lấy `companyId` và `requesterId` từ bản ghi `dr_requesters` của phiên đăng nhập, không từ tham số do client gửi.

#### Scenario: Requester không đọc được yêu cầu của người khác
- **WHEN** requester A gọi API chi tiết yêu cầu của requester B trong cùng công ty
- **THEN** hệ thống trả 404 và không tiết lộ sự tồn tại của yêu cầu

#### Scenario: Requester không vào được board
- **WHEN** requester gọi một route board (ví dụ danh sách pipeline hoặc case) của công ty mình
- **THEN** hệ thống trả 403 hoặc 404

#### Scenario: User không phải requester bị từ chối
- **WHEN** một user đã đăng nhập nhưng không có `dr_requesters` hoạt động gọi `/api/portal/*`
- **THEN** hệ thống trả 403

### Requirement: Submit request
Hệ thống SHALL cho phép requester gửi yêu cầu gồm tiêu đề, mô tả và tối đa 5 file đính kèm. Hệ thống SHALL tạo case ở stage `triage` của pipeline `dev-request` với `caseKey` dạng `REQ-<n>` theo công ty, ghi `dr_requests`, ghi nhận activity, và ghi tác nhân là chính requester trong event.

#### Scenario: Gửi yêu cầu hợp lệ
- **WHEN** requester gửi tiêu đề và mô tả hợp lệ
- **THEN** hệ thống tạo case ở `triage` với mã `REQ-n` liên tiếp trong công ty và trả mã đó cho requester

#### Scenario: Requester không chọn được stage hay trường nội bộ
- **WHEN** request gửi kèm `stageKey`, `priority` hoặc `fields`
- **THEN** hệ thống bỏ qua hoặc từ chối các trường đó và vẫn tạo case ở `triage`

#### Scenario: File vượt giới hạn
- **WHEN** file lớn hơn 10 MB, sai loại cho phép, hoặc quá 5 file
- **THEN** hệ thống từ chối và không tạo yêu cầu

### Requirement: Status visibility
Hệ thống SHALL trả cho requester chỉ các trường cho phép: mã, tiêu đề, mô tả, nhãn trạng thái tiếng Việt, thời gian và file đính kèm của chính họ. Hệ thống MUST NOT trả `pendingSuggestion`, `fields`, event nội bộ, comment nội bộ hay dữ liệu agent.

#### Scenario: Phản hồi không chứa dữ liệu nội bộ
- **WHEN** requester xem chi tiết yêu cầu đã có đề xuất của agent
- **THEN** phản hồi không chứa đề xuất agent, event hay `fields`

#### Scenario: Nhãn trạng thái tiếng Việt
- **WHEN** case ở một stage bất kỳ của pipeline
- **THEN** requester thấy nhãn tiếng Việt tương ứng với stage đó

### Requirement: Requester invitation
Hệ thống SHALL kết nạp requester bằng link mời một lần do nhân viên có quyền tạo. Token SHALL được lưu dạng băm, hết hạn, dùng một lần, và khi chấp nhận SHALL gắn với phiên của user hiện tại, không dựa vào việc email trùng.

#### Scenario: Chấp nhận link hợp lệ
- **WHEN** user đã đăng nhập mở link mời còn hạn chưa dùng
- **THEN** hệ thống tạo `dr_requesters` cho user đó và đánh dấu link đã dùng

#### Scenario: Link đã dùng hoặc hết hạn
- **WHEN** user mở link đã dùng hoặc quá hạn
- **THEN** hệ thống từ chối và không tạo `dr_requesters`

### Requirement: Registration through an invitation
Hệ thống SHALL cho phép người có link mời hợp lệ tạo tài khoản và trở thành requester trong một bước, kể cả khi đăng ký công khai đã đóng. Hệ thống SHALL kiểm tra link trước khi băm mật khẩu, SHALL tạo tài khoản, thông tin đăng nhập và `dr_requesters` trong cùng một giao dịch, và SHALL giới hạn số lần thử theo địa chỉ client. Nếu email đã có tài khoản, hệ thống MUST trả 409 và MUST NOT tiêu thụ link.

#### Scenario: Đăng ký bằng link hợp lệ khi đăng ký công khai đã đóng
- **WHEN** người chưa đăng nhập gửi tên, email và mật khẩu hợp lệ với link mời còn hiệu lực
- **THEN** hệ thống tạo tài khoản và requester, đánh dấu link đã dùng, và người đó đăng nhập được bằng mật khẩu vừa đặt

#### Scenario: Email đã có tài khoản
- **WHEN** email gửi lên (không phân biệt hoa thường) đã thuộc một tài khoản
- **THEN** hệ thống trả 409, không tạo gì và link vẫn dùng được

#### Scenario: Nhiều người dùng chung một link cùng lúc
- **WHEN** nhiều yêu cầu đăng ký đồng thời dùng cùng một link
- **THEN** đúng một yêu cầu thành công, các yêu cầu còn lại bị từ chối và không để lại tài khoản

#### Scenario: Link không dùng được
- **WHEN** link sai, đã dùng, hết hạn hoặc bị thu hồi
- **THEN** hệ thống từ chối trước khi băm mật khẩu và không tạo tài khoản

#### Scenario: Thử quá nhiều lần
- **WHEN** một địa chỉ client gửi quá giới hạn số lần thử đăng ký hoặc nhận lời mời trong một phút
- **THEN** hệ thống trả 429

#### Scenario: Người đã dùng link mở lại link
- **WHEN** chính người đã dùng một link (kể cả vừa đăng ký xong) gọi nhận lời mời lại với link đó và vẫn còn là requester hoạt động
- **THEN** hệ thống trả kết quả requester của họ, không tạo thêm bản ghi, còn người khác vẫn bị từ chối
