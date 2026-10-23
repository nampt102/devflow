# dev-stage Specification

## Purpose
Hiện thực kế hoạch kỹ thuật đã duyệt thành pull request nháp: agent Dev chạy ở runner riêng không có dữ liệu của server, DevFlow kiểm diff và bảo vệ nhánh rồi đẩy nhánh `devflow/*` và mở PR nháp bằng token ghi riêng của hệ thống, người có vai `tech_lead` duyệt ở Code review. DevFlow không bao giờ merge.

## Requirements

### Requirement: Agent Dev chỉ chạy ở runner riêng
Agent Dev SHALL chạy trong runner tách khỏi container server: runner MUST NOT có quyền vào cơ sở dữ liệu, secret của server hay dữ liệu của instance, và mạng ra ngoài MUST giới hạn theo danh sách cho phép. DevFlow MUST từ chối chạy agent Dev không được cấu hình chạy trên runner.

#### Scenario: Agent cấu hình sai nơi chạy
- **WHEN** agent Dev của công ty không gắn môi trường runner
- **THEN** worker không chạy lượt nào và ghi lỗi cấu hình `agent_not_on_runner`

#### Scenario: Host không được phép
- **WHEN** một lệnh trong runner gọi tới host ngoài danh sách cho phép
- **THEN** kết nối bị từ chối

### Requirement: Hiện thực kế hoạch đã duyệt thành PR nháp
Khi yêu cầu ở `dev` có kế hoạch đã duyệt và ít nhất một hệ thống được gán đã bật Dev, DevFlow SHALL chạy agent Dev trên nhánh `devflow/<mã REQ>` của repo đó, kiểm diff, đẩy nhánh và mở pull request **nháp**, lưu đề xuất (task đã làm, lệnh kiểm tra và kết quả, link PR, commit) và chuyển yêu cầu sang `code_review`. Agent MUST NOT có token GitHub; DevFlow MUST NOT đẩy vào nhánh nào ngoài `devflow/*` và MUST NOT merge.

#### Scenario: Lượt chạy thành công
- **WHEN** REQ-5 vào `dev` với hệ thống `reski` đã bật Dev
- **THEN** có nhánh `devflow/REQ-5` trên GitHub, một PR nháp tới nhánh mặc định, đề xuất có `prUrl` và kết quả kiểm tra, và yêu cầu ở `code_review`

#### Scenario: Nhánh mặc định không được bảo vệ
- **WHEN** nhánh mặc định của repo không bắt buộc đi qua PR
- **THEN** DevFlow không đẩy gì, ghi lỗi `repo_unprotected`, và yêu cầu vẫn ở `dev`

#### Scenario: Repo không thể bật bảo vệ nhánh nhưng đã được cho phép
- **WHEN** hệ thống có `allow_unprotected` bật và nhánh mặc định không được bảo vệ
- **THEN** DevFlow vẫn đẩy `devflow/*` và mở PR nháp, đề xuất ghi cảnh báo, và không bao giờ merge

#### Scenario: Token ghi thiếu quyền
- **WHEN** token ghi của hệ thống không đẩy được, không đọc được pull request, hoặc không thấy repo
- **THEN** DevFlow dừng **trước khi chạy agent** với lỗi `write_token_cannot_push` hoặc `github_forbidden`, không tốn chi phí và không đẩy gì

#### Scenario: Diff chạm đường dẫn cấm
- **WHEN** commit của agent sửa `.github/workflows/deploy.yml`
- **THEN** DevFlow không đẩy, đề xuất ghi lý do `forbidden_paths` để người duyệt thấy

### Requirement: Bật Dev theo hệ thống với token ghi riêng
Nhân viên SHALL bật hoặc tắt agent Dev cho từng hệ thống; bật Dev MUST cần token ghi riêng, lưu thành secret công ty và không bao giờ trả lại qua API. Lệnh kiểm tra và đường dẫn cấm thêm là tùy chọn.

#### Scenario: Bật Dev không có token ghi
- **WHEN** nhân viên bật Dev cho hệ thống chưa có token ghi
- **THEN** yêu cầu bị từ chối (400 hoặc 422) và hệ thống vẫn tắt Dev

### Requirement: Duyệt code
Người có vai `tech_lead` (hoặc owner, instance admin) SHALL approve, request_changes hoặc reject ở `code_review`; request_changes MUST có lý do và lượt sau làm tiếp trên cùng nhánh; reject MUST đóng PR; approve chuyển sang `qa` và không merge.

#### Scenario: Approve khi chưa có pull request
- **WHEN** đề xuất không có pull request (agent không commit gì) hoặc DevFlow đã từ chối đẩy một diff
- **THEN** approve bị từ chối (422); người duyệt chỉ có thể request_changes hoặc reject

#### Scenario: Request changes
- **WHEN** người duyệt chọn request_changes với lý do "thiếu test cho trường hợp voucher hết hạn"
- **THEN** yêu cầu quay về `dev`, lượt sau nhận lý do, commit mới được đẩy lên cùng nhánh và PR cũ được cập nhật

#### Scenario: Reject
- **WHEN** người duyệt reject với lý do
- **THEN** PR được đóng, nhánh giữ nguyên, yêu cầu sang `cancelled`
