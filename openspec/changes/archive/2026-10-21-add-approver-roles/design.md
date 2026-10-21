# Design

## Context

- Stage review của Paperclip có `approver` ba kiểu `any_human | user | agent` (`packages/shared/src/validators/pipeline.ts:13`). Kiểm tra ở `assertActorCanApproveStageExit` (`server/src/services/pipelines.ts:1061`) là hàm **đồng bộ**, chỉ đọc cấu hình stage và actor; không có DB, không có `companyId`. Nó được gọi ở hai nơi trong giao dịch: `transitionCaseInTransaction` (:3240) và `reviewCase` (:4918), nên chặn cả đường duyệt lẫn đường chuyển stage trực tiếp.
- Ba service duyệt của DevFlow (`triage-review`, `ba`, `plan`) đều gọi `reviewCase` của lõi với actor `user`, và route chỉ kiểm `staffUser` (board user có quyền truy cập công ty, chặn requester và agent key).
- `company_memberships.membership_role` chỉ một giá trị mỗi người mỗi công ty (unique `company, principalType, principalId`) và dùng cho quyền của Paperclip (`owner`, `admin`, ...), không phải vai nghiệp vụ. `principal_permission_grants` cho nhiều dòng mỗi người nhưng `permission_key` bị ràng buộc bởi `PERMISSION_KEYS` của `packages/shared`.
- Đã có `dr_*` trong `packages/db` (ADR 0004, ADR 0010: khóa ngoại kép `(id, company_id)` để cách ly công ty).

## Goals / Non-Goals

**Goals:**
- Người duyệt phải có đúng vai; một người có thể có nhiều vai.
- Chặn ở máy chủ cho cả hai đường (duyệt và chuyển stage), không chỉ ẩn nút.
- Công ty chưa gán vai không bị khóa; thay đổi vai có audit.

**Non-Goals:**
- Vai theo hệ thống hoặc theo pipeline, vai cho requester, nhóm/SSO.
- Đổi cách Paperclip phân quyền (`membership_role`, permission grants).

## Decisions

**D1. Bảng riêng `dr_member_roles`, không dùng `membership_role` hay permission grants.**
Cột: `id`, `company_id` (FK companies), `user_id` (text, id người dùng của better-auth), `role` (text, CHECK `role in ('ba','tech_lead')`), `granted_by_user_id`, `created_at`; unique `(company_id, user_id, role)`; index `(company_id, user_id)`. Lý do: `membership_role` chỉ một giá trị và mang nghĩa quyền khác; `permission_key` là enum cố định của Paperclip (thêm khóa là đổi lõi ở nhiều chỗ). Vai nghiệp vụ là khái niệm riêng của DevFlow, đúng chỗ của bảng `dr_*`. Không có FK tới bảng user (Paperclip quản `user`); tính hợp lệ của `user_id` (phải là thành viên đang hoạt động của công ty) kiểm ở service khi gán. Người rời công ty giữ dòng vai nhưng vô hiệu vì kiểm quyền vẫn đòi truy cập công ty.

**D2. Approver kiểu `role` với danh sách `roles`.**
Mở rộng validator: `{ kind: "role", roles: Array<"ba"|"tech_lead"> (1 đến 4 phần tử, không trùng) }`; `id` không dùng với kiểu này. Qua được khi người duyệt có **bất kỳ** vai nào trong danh sách. Thay thế phương án một vai mỗi stage vì `triage_review` và `ba_review` cần cả hai vai. `normalizeStageConfig` kiểm cấu hình (kind lạ hoặc `roles` rỗng thì 422 `validation`, như các kind hiện có).

**D3. Bất đồng bộ hóa kiểm tra approver.**
`assertActorCanApproveStageExit(tx, stage, actor, companyId)` thành `async`; hai chỗ gọi `await` nó (cả hai đã trong `db.transaction`, có `tx` và `companyId`). Nhánh `any_human`, `user`, `agent` giữ nguyên từng dòng và không thêm truy vấn DB (chỉ nhánh `role` mới truy vấn), nên hành vi cũ không đổi; test hồi quy `pipelines-*` là mốc. Nhánh `role` làm: actor không phải `user` thì 403; actor có quyền bỏ qua thì qua; ngược lại đọc `dr_member_roles` theo `(company_id, user_id)` và so với danh sách.

**D4. Quyền bỏ qua: owner và instance admin.**
Owner là `company_memberships.membership_role = 'owner'` đang `active`; instance admin theo `req.actor.isInstanceAdmin`. Lõi `PipelineActor` chỉ có `{type:"user", userId}`, nên cờ instance admin được truyền thêm vào actor (`instanceAdmin?: boolean`) bởi route DevFlow; HTTP của Paperclip không truyền nên mặc định không bỏ qua. Lý do giữ ngoại lệ: không có nó, đổi cấu hình trước khi gán vai sẽ khóa công ty. `admin` (membership) không được bỏ qua để vai nghiệp vụ có nghĩa; chủ dự án đổi được ở D4 nếu muốn.

**D5. Quản lý vai bằng API, script và màn hình Roles (D8).**
`GET /api/companies/:id/devflow/member-roles` (liệt kê thành viên staff kèm vai), `PUT .../member-roles/:userId` (thay toàn bộ danh sách vai của một người trong một giao dịch, idempotent). Chỉ owner hoặc instance admin; đường đi dùng `staffUser` rồi kiểm owner. Ghi `activity_log` `devflow.roles_changed` (chỉ ghi khi có thay đổi). `scripts/devflow/set-member-roles.mjs --company <id> --email <email> --roles ba,tech_lead`. Chọn PUT thay danh sách để gán và gỡ cùng một thao tác, tránh gán dở khi lỗi giữa chừng.

**D6. `canDecide` trong chi tiết case.**
Ba service chi tiết trả thêm `canDecide: boolean` và `requiredRoles: string[]` (rỗng khi stage không dùng vai), dùng chung một hàm tính quyền với D3 để UI và máy chủ không lệch. UI chỉ tắt nút và hiện lý do; không bao giờ là nơi chặn.

**D7. Cập nhật pipeline đã seed bằng `setup-dev-request-pipeline.mjs`.**
Cấu hình stage nằm trong DB theo từng công ty nên sửa `dev-request-pipeline.json` chỉ áp cho công ty mới. Script seed chạy lại được; thêm bước: nếu pipeline đã có, đối chiếu `approver` của ba stage và PATCH chỉ trường đó. Việc đọc script hiện tại (cách nó cập nhật stage) làm ở task 4.1 trước khi viết.

**D8. Màn hình Roles dùng lại API D5.**
Trang `/roles` (mục "Roles" trong nhóm DevFlow của sidebar) gọi `GET member-roles` để hiện bảng nhân viên (tên, email, vai trò membership, hai ô bật tắt `ba` và `tech_lead`) và `PUT member-roles/:userId` khi lưu một dòng. GET trả thêm `canManage: boolean` của người xem; khi `false` (nhân viên thường) bảng chỉ đọc. GET mở cho mọi staff (để ai cũng biết ai là BA hoặc Tech Lead), PUT vẫn chỉ owner hoặc instance admin. Cùng một mã lỗi, không có đường ghi thứ hai. Chủ sở hữu và instance admin hiện nhãn "Luôn duyệt được" vì họ bỏ qua kiểm vai (D4), tránh hiểu nhầm là chưa có vai thì không duyệt được.

## Risks / Trade-offs

- **GET mở cho staff**: lộ danh sách email nhân viên trong công ty cho mọi nhân viên. Chấp nhận vì họ cùng công ty và cần biết người duyệt; requester và agent vẫn bị chặn bởi `staffUser`.

- **Vá lõi trong file rất lớn** (`pipelines.ts` ~5k dòng): thay đổi nhỏ (một hàm và hai chỗ gọi) nhưng phải chạy lại toàn bộ test `pipelines-*`; thêm test cho từng nhánh `kind` cũ để chứng minh không đổi hành vi. Merge với upstream khó hơn, đã chấp nhận ở rủi ro mở số 0 của `status.md`.
- **Khóa công ty khi triển khai sai thứ tự**: giảm bằng ngoại lệ owner (D4) và thứ tự triển khai ghi trong runbook (gán vai trước, đổi pipeline sau).
- **Nhân viên rời công ty**: dòng vai vẫn còn nhưng không còn truy cập công ty nên không duyệt được (kiểm `staffUser`); không tự dọn. Chấp nhận, dọn khi làm màn hình quản lý.
- **Danh sách vai cố định trong CHECK**: thêm vai là một migration nhỏ; chấp nhận vì số vai ít và ổn định, đổi lấy ràng buộc ở DB.
## Migration Plan

1. Áp dụng migration `0360` khi server khởi động (bảng mới, không đụng bảng cũ).
2. Gán vai cho nhân viên hiện có bằng `set-member-roles.mjs`.
3. Chạy lại `setup-dev-request-pipeline.mjs` cho từng công ty (RESKI, DevFlow Verify) để đổi `approver`.
4. Kiểm bằng một tài khoản không có vai: thấy case, nút bị tắt, 403 khi gọi API.
Hoàn tác: đặt lại `approver` về `any_human` bằng cùng script (cờ `--any-human`); bảng vai để nguyên.
