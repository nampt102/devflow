## ADDED Requirements

### Requirement: Agent QA kiểm nhánh đã duyệt theo tiêu chí nghiệm thu
Khi yêu cầu ở `qa` có đề xuất Dev đã duyệt kèm pull request, DevFlow SHALL chạy agent QA của công ty ở runner riêng trên **nhánh đã đẩy** của từng hệ thống, với tiêu chí nghiệm thu đã duyệt, kế hoạch test đã duyệt và báo cáo của Dev làm đầu vào, kiểm đầu ra bằng schema strict, lưu đề xuất và chuyển yêu cầu sang `qa_signoff`. Báo cáo MUST có **đúng một dòng cho mỗi tiêu chí nghiệm thu** (đạt, không đạt, hoặc chưa kiểm được, kèm bằng chứng hoặc lý do).

#### Scenario: Lượt chạy thành công
- **WHEN** REQ-5 vào `qa` với bốn tiêu chí nghiệm thu đã duyệt và PR nháp của hệ thống `reski`
- **THEN** có đề xuất với bốn dòng tiêu chí, danh sách lệnh đã chạy và kết quả, các bước kiểm thủ công, và yêu cầu ở `qa_signoff`

#### Scenario: Báo cáo thiếu hoặc thừa tiêu chí
- **WHEN** agent trả báo cáo bỏ sót AC3 hoặc thêm AC9 không có trong spec
- **THEN** DevFlow chạy lại một lần với lý do, và nếu vẫn sai thì không ghi đề xuất (`invalid_output`)

#### Scenario: Không có pull request để kiểm
- **WHEN** đề xuất Dev đã duyệt không có hệ thống nào có pull request
- **THEN** worker không chạy lượt nào và ghi lỗi cấu hình `no_qa_target`

### Requirement: QA không sửa và không đẩy code
Agent QA MUST NOT làm thay đổi nào tới GitHub: DevFlow SHALL không đẩy gì trong stage `qa`, bỏ mọi thay đổi và commit của agent khi dọn workspace, và đánh dấu cảnh báo trong đề xuất nếu agent đã commit lên nhánh. Agent QA MUST NOT có token GitHub.

#### Scenario: Agent commit lên nhánh
- **WHEN** agent QA tạo một commit mới trên nhánh của yêu cầu
- **THEN** commit không được đẩy, đề xuất ghi cảnh báo `qa_modified_branch`, và PR không đổi

### Requirement: Khuyến nghị do DevFlow tính, người ký quyết định
DevFlow SHALL tính khuyến nghị từ báo cáo: "nên duyệt" chỉ khi mọi tiêu chí đạt và mọi lệnh kiểm tra đạt, ngược lại "nên trả lại"; khuyến nghị MUST NOT thay quyết định của người ký.

#### Scenario: Một tiêu chí không đạt
- **WHEN** báo cáo có một tiêu chí không đạt
- **THEN** khuyến nghị là "nên trả lại" và nút Approve vẫn dùng được cho người có quyền

### Requirement: Ký duyệt QA
Người có vai `qa` hoặc `tech_lead` (hoặc owner, instance admin) SHALL approve, request_changes hoặc reject ở `qa_signoff`; request_changes và reject MUST có lý do; approve chuyển sang `done` và không merge; request_changes đưa yêu cầu về `dev`; reject đóng các PR và chuyển sang `cancelled`.

#### Scenario: Approve
- **WHEN** người có vai `qa` approve REQ-5
- **THEN** yêu cầu sang `done`, PR không bị merge hay đóng

#### Scenario: Request changes
- **WHEN** người ký chọn request_changes với lý do "AC2 sai khi voucher hết hạn"
- **THEN** yêu cầu về `dev` và lượt Dev sau nhận lý do cùng các tiêu chí QA không đạt

#### Scenario: Thiếu vai
- **WHEN** người chỉ có vai `ba` duyệt ở `qa_signoff`
- **THEN** API trả 403, nút tắt và màn hình nói rõ cần vai nào

### Requirement: Cùng giới hạn an toàn với Dev
Agent QA SHALL chỉ chạy ở runner (không bao giờ trong container server), với danh sách tool, ngân sách mỗi lượt, trần chi phí mỗi ngày mỗi công ty và hash prompt được kiểm trước mỗi lượt; DevFlow MUST từ chối chạy agent QA sai cấu hình.

#### Scenario: Agent không ở runner
- **WHEN** agent QA của công ty không gắn môi trường runner
- **THEN** worker không chạy lượt nào và ghi lỗi cấu hình `agent_not_on_runner`
