## ADDED Requirements

### Requirement: Khung duyệt chung
Các trang Triage review, BA review, Plan review, Code review và QA sign-off SHALL dùng chung một khung: thanh trên (số chờ, mục cũ nhất, lọc, sắp xếp, link số liệu), hàng chờ gọn (mã, tiêu đề, tuổi, một dòng trạng thái có biểu tượng), và vùng chi tiết có điều hướng theo mục. Quy tắc quyết định, quyền và API của từng stage SHALL giữ nguyên.

#### Scenario: Thẻ hàng chờ
- **WHEN** một mục có khuyến nghị "changes" và một lệnh kiểm lỗi
- **THEN** thẻ chỉ hiện một dòng trạng thái theo mức nặng nhất ("1 test failed") với biểu tượng cảnh báo, không chỉ bằng màu

### Requirement: Thanh quyết định luôn thấy
Vùng chi tiết SHALL có thanh quyết định ghim ở đáy, hành động phụ (Request changes, Reject) bên trái và Approve bên phải. Ô lý do SHALL chỉ mở khi chọn Request changes hoặc Reject. Reject SHALL cần xác nhận nêu rõ hậu quả.

#### Scenario: Đọc giữa trang
- **WHEN** người duyệt đang cuộn giữa phần tiêu chí
- **THEN** các nút quyết định vẫn thấy và bấm được

#### Scenario: Reject
- **WHEN** người duyệt bấm Reject với lý do
- **THEN** một hộp xác nhận nêu "đóng pull request và hủy yêu cầu" hiện ra, và chỉ khi xác nhận mới gửi

### Requirement: Sang mục kế tiếp và giữ chỗ
Sau một quyết định thành công, khung SHALL chọn mục ngay sau mục vừa quyết theo sắp xếp hiện tại (hết thì mục trước), và SHALL giữ vị trí cuộn của hàng chờ.

#### Scenario: Quyết định mục thứ hai
- **WHEN** người duyệt approve mục thứ hai trong năm mục
- **THEN** mục kế tiếp (trước đây thứ ba) được mở

### Requirement: Phím tắt và link sâu
Khung SHALL hỗ trợ `j`/`k` (lên, xuống), `a` (approve), `r` (request changes), `x` (reject, qua xác nhận), `?` (bảng phím), không kích hoạt khi đang gõ trong ô nhập. Mục đang chọn SHALL nằm trên URL (`?case=<mã>`) để tải lại hay mở từ email ra đúng mục.

#### Scenario: Mở từ email
- **WHEN** nhân viên mở link `…/qa-signoff?case=REQ-1`
- **THEN** trang mở với REQ-1 được chọn

#### Scenario: Đang gõ lý do
- **WHEN** focus ở ô lý do và người dùng gõ chữ "a"
- **THEN** không có quyết định nào được gửi

### Requirement: Vòng trước
Khi một mục quay lại sau request_changes, chi tiết SHALL hiện lý do vòng trước và các thay đổi của trường có cấu trúc (cũ → mới).

#### Scenario: Spec BA sửa lại
- **WHEN** spec BA quay lại sau khi người duyệt yêu cầu thêm tiêu chí
- **THEN** chi tiết hiện "Since last round" với lý do đã ghi và các tiêu chí mới thêm

### Requirement: Màn hình hẹp
Dưới 1024px, hàng chờ và chi tiết SHALL là hai màn, chi tiết có nút quay lại giữ vị trí cuộn, thanh quyết định vẫn ghim.

#### Scenario: Điện thoại
- **WHEN** mở trang trên màn 375px và chọn một mục
- **THEN** chi tiết chiếm toàn màn với nút Back và thanh quyết định ở đáy, không cuộn ngang
