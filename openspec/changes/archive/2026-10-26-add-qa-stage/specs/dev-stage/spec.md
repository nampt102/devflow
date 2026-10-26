## ADDED Requirements

### Requirement: Dev nhận phản hồi từ QA sign-off
Khi người ký QA chọn request_changes, DevFlow SHALL đưa yêu cầu về `dev`, và lượt Dev sau MUST nhận lý do của người ký cùng danh sách tiêu chí nghiệm thu QA báo không đạt, làm tiếp trên cùng nhánh `devflow/<REQ>` và cập nhật cùng PR.

#### Scenario: Trả lại từ QA
- **WHEN** QA sign-off request_changes REQ-5 với lý do và AC2 không đạt
- **THEN** yêu cầu về `dev`, `request.md` của lượt Dev sau có lý do và AC2, và commit mới được đẩy lên nhánh cũ
