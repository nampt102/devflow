## Why

Ở Triage review, người duyệt chỉ có approve, reject, request_changes. Yêu cầu chưa quyết được ngay (chờ hỏi thêm ngoài hệ thống, chờ ngân sách quý sau, chờ hệ thống khác xong) phải nằm mãi đầu hàng chờ, làm số đếm sidebar và email nhắc không còn ý nghĩa. Plane có trạng thái **Snoozed** cho intake (hoãn tới một ngày, hết hạn tự quay lại hàng chờ); đây là một trong các phần định port theo ADR 0002 mà chưa làm.

## What Changes

- Nút **Snooze** ở Triage review: chọn ngày (1 ngày, 1 tuần, 1 tháng, hoặc ngày cụ thể; tối đa 90 ngày) và ghi chú tùy chọn. Yêu cầu rời hàng chờ chính tới ngày đó, rồi **tự quay lại** (không cần worker: hàng chờ lọc theo thời điểm).
- Mục **Snoozed (n)** trong trang để xem danh sách đang hoãn và **Unsnooze** sớm.
- Yêu cầu đang hoãn không tính vào số đếm sidebar, không vào email nhắc nhân viên; quay lại thì tính như yêu cầu mới (nhãn "New").
- Hoãn **không đổi stage** và **không báo requester** (vẫn là "đang xem xét"); quyết định vẫn chỉ là approve, reject, request_changes.
- Ghi sổ hoạt động `triage.snoozed`, `triage.unsnoozed`.
- Chỉ áp cho Triage review (giống Plane). Các trang duyệt khác giữ nguyên.

## Capabilities

### New Capabilities
- `triage-snooze`: hoãn một yêu cầu ở Triage review tới một ngày, tự quay lại hàng chờ khi hết hạn.

### Modified Capabilities
Không (spec chính của Triage review chưa có trong `openspec/specs`; hành vi hàng chờ ghi ở capability mới).

## Impact

- `packages/db`: **migration thêm 3 cột** vào `dr_requests`: `snoozed_until timestamptz null`, `snoozed_by text null`, `snooze_note text null` (DDL ở design, **chờ duyệt**).
- `server/src/devflow/triage-review/`: lọc hàng chờ và số đếm, endpoint snooze/unsnooze, danh sách đang hoãn; `email/staff-notify.ts` bỏ yêu cầu đang hoãn.
- `ui/`: nút Snooze, hộp chọn ngày, mục Snoozed.
- Không đổi pipeline, không đổi portal.

## Ngoài phạm vi
Snooze ở BA/Plan/Code/QA review; hoãn theo múi giờ công ty (dùng mốc 00:00 giờ Việt Nam); nhắc người duyệt khi hết hạn bằng email riêng; requester thấy trạng thái "hoãn".
