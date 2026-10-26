# setup-ui Specification

## Purpose
TBD - created by archiving change add-agent-setup-ui. Update Purpose after archive.

## Requirements

### Requirement: Trang Setup cho owner và admin
Hệ thống SHALL có trang Setup trong Board UI hiện, cho công ty đang chọn, trạng thái của agent BA, Planner, Dev, QA, của pipeline `dev-request` và của runner. Chỉ owner hoặc admin của công ty (và instance admin) được xem và áp cấu hình; người khác nhận 403. Mọi thay đổi SHALL đi qua các API Paperclip hiện có bằng quyền của người đăng nhập.

#### Scenario: Công ty mới
- **WHEN** công ty chưa có agent nào và chưa có pipeline
- **THEN** mỗi agent hiện "Not created" với nút Create, và pipeline hiện "Not created" với nút Create

#### Scenario: Người không phải owner hoặc admin
- **WHEN** một nhân viên thường mở API trạng thái của trang
- **THEN** server trả 403 và giao diện không hiện nút nào

### Requirement: Cài và cập nhật agent
Với mỗi vai agent, nút Create hoặc Update SHALL đưa agent về đúng cấu hình DevFlow yêu cầu (cùng cấu hình mà `GET …/devflow/<vai>-agent` trả về), kể cả tool, môi trường runner, ngân sách, hướng dẫn và liên kết tệp hướng dẫn, và SHALL bật agent (trạng thái `idle`). Khóa Anthropic SHALL chỉ được nhập khi công ty chưa có secret của nó hoặc khi người dùng chọn thay, SHALL lưu thành secret của công ty, và SHALL không bao giờ được hiện lại hay ghi vào nhật ký.

#### Scenario: Agent lỗi thời sau nâng cấp
- **WHEN** hash prompt của agent khác bản trong code
- **THEN** trang hiện "Needs update: prompt outdated" và nút Update; bấm xong trạng thái thành "Ready"

#### Scenario: Agent đang xác minh
- **WHEN** Paperclip đang xác minh agent mới tạo (trạng thái `verifying`) hoặc xác minh lỗi
- **THEN** trang hiện "Verifying" cùng mã lỗi gần nhất nếu có, và nút Update tự thử lại khi xác minh xong, không báo lỗi 409 thô cho người dùng

#### Scenario: Chưa có khóa Anthropic
- **WHEN** công ty chưa có secret khóa Anthropic và người dùng bấm Create mà chưa nhập khóa
- **THEN** nút bị tắt kèm lý do "Paste the Anthropic key first"

### Requirement: Đồng bộ pipeline
Nút Create hoặc Sync SHALL tạo pipeline `dev-request` nếu chưa có, hoặc chỉ thêm vào pipeline hiện có những gì định nghĩa chuẩn có mà công ty còn thiếu (approver theo vai, đích request_changes của `qa_signoff`, bước chuyển) và SHALL không xóa hay đổi thứ khác. Chạy lại khi đã khớp SHALL không đổi gì.

#### Scenario: Công ty đã seed trước khi có QA
- **WHEN** pipeline thiếu bước chuyển `qa_signoff → dev`
- **THEN** trang hiện "1 transition missing"; sau Sync, bước chuyển có mặt và các bước khác nguyên vẹn

### Requirement: Runner chỉ đọc
Trang SHALL hiện trạng thái runner (môi trường Paperclip có, server có thấy máy chủ runner không) và, khi chưa sẵn sàng, lệnh `setup-dev-runner.mjs` cần chạy. Hệ thống SHALL không dựng, build hay khởi động lại container từ giao diện.

#### Scenario: Server mất mạng runner
- **WHEN** server không phân giải được máy chủ runner
- **THEN** trang hiện "Runner unreachable" cùng hướng dẫn chạy lại `setup-dev-runner.mjs`

### Requirement: Cảnh báo trên sidebar
Sidebar SHALL hiện chấm hoặc số cảnh báo cho owner/admin khi có agent cần cập nhật hoặc pipeline chưa khớp.

#### Scenario: Sau nâng cấp prompt
- **WHEN** một agent đã tạo có prompt lỗi thời
- **THEN** mục Setup trên sidebar hiện cảnh báo cho owner/admin và không hiện cho người khác
