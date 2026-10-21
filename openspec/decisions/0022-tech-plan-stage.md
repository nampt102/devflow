# 0022. Tech Plan stage: khung chạy agent dùng chung, agent Planner riêng, một lượt một lần cho mọi stage

- **Ngày:** 2026-10-20
- **Trạng thái:** đã chốt (chủ dự án duyệt change `add-tech-plan-stage`, D1 đến D7)
- **Người quyết định:** chủ dự án (Technical Lead)

## Quyết định
- **Khung chạy agent dùng chung** (`server/src/devflow/agent-stage/`): runner, cấu hình chuẩn theo role, workspace, vòng chạy (thử lại khi JSON sai, sổ chi phí, ghi đề xuất có kiểm version, chuyển stage, trần ngày), worker và metrics. BA và Tech Plan chỉ khác ở "định nghĩa stage" (prompt, schema, ngữ cảnh đầu vào). Hành vi BA không đổi: 117 test BA cũ pass với kỳ vọng nguyên vẹn.
- **Agent riêng mỗi stage** ("DevFlow BA", "DevFlow Planner"), nhận diện bằng `metadata.devflowRole`; mỗi stage một thư mục workspace (`/paperclip/devflow/ws/ba`, `/paperclip/devflow/ws/plan`) dùng chung cho mọi công ty.
- **Một khóa advisory chung `dr-agent-stage-worker`** cho mọi worker stage: cả instance chỉ một lượt agent tại một thời điểm, nên dữ liệu công ty khác không bao giờ nằm trên đĩa cạnh agent.
- **Chặn chéo:** luật `--disallowedTools` của mỗi agent chặn workspace và thư mục transcript Claude Code của các stage khác (phòng khi một lượt bị cắt ngang để lại dữ liệu). Worker đòi đủ luật mới, nên agent BA tạo trước Tech Plan bị từ chối (`agent_instance_not_denied`) cho đến khi chạy lại `setup-ba-agent.mjs`.
- **Đầu vào của Planner là spec BA đã duyệt** (`data.approved`), không phải bản nháp của agent BA. Thiếu spec đã duyệt là lỗi cấu hình (`no_approved_spec`): thử lại nhẹ nhàng, không bỏ cuộc.
- **Đầu ra:** task theo hệ thống có cỡ tương đối S/M/L, file trích dẫn, phụ thuộc (không vòng), thay đổi dữ liệu/API, kế hoạch test. Người duyệt sửa được văn bản và tiêu đề/mô tả/cỡ của task; đổi danh sách task phải gửi lại agent.
- **Model mặc định** `claude-sonnet-5-5`, 2 USD mỗi lượt, trần ngày riêng của Tech Plan (sổ `agent.plan_run`), tách khỏi BA.

## Hệ quả
- Thông lượng toàn instance là tuần tự cho mọi stage: một spec hoặc một kế hoạch tại một thời điểm. Chấp nhận cho pilot; nâng cấp bằng workspace theo lượt khi cần.
- Thêm stage agent sau này (Dev, QA) là thêm role vào `STAGE_ROLES` và một định nghĩa stage; mọi agent đã có phải chạy lại script setup vì danh sách chặn chéo đổi.
- Secret key Anthropic dùng chung giữa các agent (`devflow-ba-anthropic`, tên giữ nguyên để không phải tạo lại).
- Tự chạy setup agent khi tạo công ty là việc sau (backlog B-40).
