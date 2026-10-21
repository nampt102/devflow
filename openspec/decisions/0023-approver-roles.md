# 0023. Vai trò BA / Tech Lead cho người duyệt: bảng riêng, approver kiểu `role`, kiểm ở lõi

- **Ngày:** 2026-10-21
- **Trạng thái:** đã chốt (chủ dự án duyệt change `add-approver-roles`, D1 đến D8)
- **Người quyết định:** chủ dự án (Technical Lead)

## Quyết định
- **Bảng riêng `dr_member_roles`** (migration `0360`): `(company_id, user_id, role)` unique, `role` chỉ `ba` hoặc `tech_lead` (CHECK). Một người có nhiều vai. Không dùng `membership_role` (một giá trị, mang nghĩa quyền của Paperclip) hay `principal_permission_grants` (enum cố định của Paperclip).
- **Approver kiểu `role`** ở lõi Pipelines: `{ kind: "role", roles: [...] }`, qua được khi người duyệt có bất kỳ vai nào trong danh sách. Kiểm ở `assertActorCanApproveStageExit` (nay `async`), nên chặn cả đường duyệt lẫn đường chuyển stage trực tiếp. Ba nhánh cũ `any_human|user|agent` không đổi và không thêm truy vấn.
- **Bỏ qua kiểm vai:** owner đang hoạt động của công ty và instance admin (cờ `instanceAdmin` do route DevFlow truyền vào actor). `admin` của membership không được bỏ qua. Lý do: đổi cấu hình trước khi gán vai không được khóa công ty.
- **Một hàm tính quyền duy nhất** (`userMayDecideAsRole`) cho lõi và cho `canDecide`/`requiredRoles` của ba màn hình duyệt: UI chỉ tắt nút và nêu lý do, máy chủ mới là nơi chặn.
- **Quản lý vai:** `GET/PUT /api/companies/:id/devflow/member-roles[/:userId]` (PUT thay cả danh sách trong một giao dịch, chỉ owner hoặc instance admin, ghi `activity_log` `devflow.roles_changed` khi có thay đổi), script `scripts/devflow/set-member-roles.mjs`, màn hình `/roles` (GET mở cho mọi staff, chỉ đọc nếu không phải owner).
- **Cấu hình pipeline:** `triage_review` và `ba_review` cần `ba` hoặc `tech_lead`; `plan_review` cần `tech_lead`. `setup-dev-request-pipeline.mjs` cập nhật công ty đã seed chỉ ở trường `approver`, chạy lại không đổi gì, `--any-human` để hoàn tác.

## Hệ quả
- Vá thêm một chỗ ở lõi (`pipelines.ts`, `pipeline-approver-roles.ts`); merge với upstream khó hơn, đã chấp nhận (rủi ro mở số 0).
- Thứ tự triển khai: gán vai trước, đổi `approver` sau; nếu quên, owner vẫn duyệt được.
- Người rời công ty giữ dòng vai nhưng không còn truy cập nên không duyệt được; chưa tự dọn.
- Thêm vai mới là một migration nhỏ (CHECK) và một phần tử trong `PIPELINE_APPROVER_ROLES`.
