# 0021. BA Spec stage: DevFlow điều khiển agent chỉ có tool đọc; hệ thống gán ở Triage review

- **Ngày:** 2026-10-19
- **Trạng thái:** đã chốt (chủ dự án duyệt Option 3 và duyệt proposal + DDL theo mặc định); thiết kế chi tiết ở change `add-ba-spec-stage`
- **Người quyết định:** chủ dự án (Technical Lead)

## Quyết định
- **DevFlow điều khiển toàn bộ lượt chạy** của agent BA (dựng workspace, `wakeup` qua heartbeat của Paperclip, đọc `resultJson`, kiểm bằng Zod, ghi `dr_agent_outputs`, chuyển stage). Không dùng `onEnter`/routine: agent không có công cụ gọi API Paperclip, và routine gây vòng "disposition repair" (3 lượt chạy cho một case, issue kẹt `blocked`).
- **Chặn bằng danh sách tool, không bằng sandbox:** `engine: cli` + `--tools Read,Grep,Glob` + `--disallowedTools` cho đường dẫn nhạy cảm + `--max-budget-usd` mỗi lượt. Lý do: chặn tool Write không đủ (agent vòng qua Bash), bubblewrap cần tắt seccomp của cả container. DevFlow từ chối chạy agent đã bị đổi so với cấu hình chuẩn.
- **Một thư mục workspace chung, chạy tuần tự toàn instance**, dọn trước và sau mỗi lượt, để dữ liệu công ty khác không bao giờ nằm cạnh agent (luật chặn đường dẫn không liệt kê được "mọi công ty khác").
- **Agent tạo bằng API (script), không bằng code DevFlow**: tạo agent có nhiều tác dụng phụ (hire, quyền, skill, runner). Cấu hình chuẩn do server công bố, script chỉ áp dụng.
- **Hệ thống = repo GitHub của công ty** (bảng `dr_systems`), gán cho yêu cầu ở Triage review (Triage prompt v4 đề xuất, người duyệt xác nhận), đổi được ở BA review; token chỉ đọc là secret của công ty.
- **Spec đã duyệt giữ ở `data.approved`** của đề xuất; Tech Plan đọc một chỗ.
- **Trần chi phí:** theo lượt (`--max-budget-usd`) và theo ngày mỗi công ty tính từ sổ `agent.ba_run` của DevFlow (không phụ thuộc kế toán chi phí của Paperclip vốn có độ trễ).

## Hệ quả
- Rủi ro còn lại: agent đọc được mọi file không bị luật chặn trong container và có thể chép đoạn vào spec; không có kênh ra ngoài. Cách ly mạnh hơn (bubblewrap với profile seccomp riêng, hoặc runner tách) để P4.
- Thông lượng thấp (tuần tự); chấp nhận cho pilot.
- Đổi prompt BA phải tạo `ba.v2.ts` và chạy lại script setup cho từng công ty, nếu không worker từ chối (`agent_prompt_outdated`).
- Chưa chạy thật với repo và key thật tại thời điểm viết (xem `kb/ba-spec.md`).
