## ADDED Requirements

### Requirement: Hoãn yêu cầu ở Triage review
Người có quyền duyệt Triage SHALL hoãn được một yêu cầu đang chờ duyệt tới một ngày trong vòng 90 ngày, kèm ghi chú tùy chọn. Hoãn SHALL không đổi stage, không ghi quyết định và không gửi gì cho requester. Hệ thống SHALL ghi sổ hoạt động `triage.snoozed`.

#### Scenario: Hoãn một tuần
- **WHEN** người duyệt chọn Snooze tới ngày sau 7 ngày
- **THEN** yêu cầu rời hàng chờ chính, không tính vào số đếm sidebar và email nhắc, và hiện trong mục Snoozed với ngày quay lại

#### Scenario: Ngày không hợp lệ
- **WHEN** ngày hoãn là hôm nay, đã qua, hoặc quá 90 ngày
- **THEN** server trả 422 và không đổi gì

#### Scenario: Có người vừa quyết định
- **WHEN** phiên bản case đã đổi so với lúc người duyệt mở
- **THEN** server trả 409

### Requirement: Tự quay lại khi hết hạn
Yêu cầu SHALL tự quay lại hàng chờ chính từ 00:00 giờ Việt Nam của ngày hoãn mà không cần tác vụ nền, và SHALL hiện nhãn "New" như yêu cầu mới tới.

#### Scenario: Hết hạn
- **WHEN** đến ngày hoãn
- **THEN** yêu cầu có lại trong hàng chờ và số đếm, với nhãn New

### Requirement: Bỏ hoãn sớm và quyết định
Người duyệt SHALL bỏ hoãn được bất kỳ lúc nào (ghi `triage.unsnoozed`). Một quyết định approve, reject hay request_changes SHALL xóa trạng thái hoãn.

#### Scenario: Bỏ hoãn
- **WHEN** người duyệt bấm Unsnooze ở mục Snoozed
- **THEN** yêu cầu về hàng chờ chính ngay
