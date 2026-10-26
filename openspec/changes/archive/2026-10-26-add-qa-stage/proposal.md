## Why

Sau P3, yêu cầu có code đã duyệt ở `code_review` chuyển sang stage `qa` rồi dừng: chưa có gì kiểm xem code **làm đúng điều BA spec đòi** (tiêu chí nghiệm thu đã duyệt) và không phá cái đang chạy. Hiện việc đó hoàn toàn thủ công, và `code_review` chỉ xem diff, không chạy gì. P4 cần một agent QA chạy nhánh của PR nháp ở runner, đối chiếu từng tiêu chí nghiệm thu với bằng chứng (test chạy được, kết quả lệnh kiểm tra), nêu lỗi và các bước kiểm thủ công cho người, để người ký duyệt ở `qa_signoff` có căn cứ. Agent chỉ đề xuất; người ký quyết định.

Khác Dev, QA **không sửa và không đẩy code**: nó đọc, chạy lệnh và báo cáo. Nên không cần token ghi, không mở PR, không cần kiểm diff.

## What Changes

- **Agent "DevFlow QA" mỗi công ty**: `claude_local`, `engine: cli`, chạy ở **cùng runner** của Dev (môi trường SSH `devflow-runner`), tool như Dev (`Read, Grep, Glob, Edit, Write, Bash`: cần Bash để chạy test, Edit/Write để tạo file thử tạm), model mặc định `claude-sonnet-5-5`, ngân sách mỗi lượt và mỗi ngày, hash prompt ghim. Kiểm trước mỗi lượt giống Dev (chỉ chạy trên runner).
- **QA worker** trên khung `agent-stage`: case ở `qa` chưa có đề xuất → với từng hệ thống đã được Dev làm (có PR ở `data.approved` của đề xuất `dev`): dựng workspace, clone đầy đủ **nhánh `devflow/<REQ>` đã đẩy** (bằng token đọc, hoặc token ghi nếu chỉ có token ghi), `request.md` có tiêu chí nghiệm thu đã duyệt (đánh mã AC1, AC2...), kế hoạch test đã duyệt, báo cáo của Dev, lệnh kiểm tra của hệ thống → agent chạy → báo cáo JSON strict → ghi đề xuất → chuyển `qa_signoff`.
- **Báo cáo QA**: với **mỗi tiêu chí nghiệm thu đúng một dòng** (đạt / không đạt / chưa kiểm được, kèm bằng chứng: tên test, lệnh, kết quả, hoặc lý do không kiểm tự động được), danh sách lệnh đã chạy và kết quả, lỗi tìm thấy (mức độ, các bước tái hiện), các bước kiểm thủ công cho người, độ tin cậy. DevFlow tự tính **khuyến nghị** (đạt hết và mọi lệnh đạt thì "nên duyệt", ngược lại "nên trả lại") nhưng người ký quyết định.
- **Chốt chặn:** mọi commit hay thay đổi file của QA bị **bỏ**; DevFlow không đẩy gì lên GitHub trong stage này, và đánh dấu cảnh báo nếu agent đã commit lên nhánh.
- **Màn hình QA sign-off** (Board UI `/qa-signoff`, cùng khuôn Code review): link PR, bảng tiêu chí với bằng chứng, lệnh đã chạy, lỗi, các bước kiểm thủ công. Approve → `done` (không merge), request_changes (bắt lý do) → **`dev`** (Dev làm tiếp trên cùng nhánh, nhận lý do và các tiêu chí không đạt làm phản hồi), reject → `cancelled` và đóng PR. Cần vai `qa` (hoặc `tech_lead`, owner, instance admin).
- **Vai `qa` mới** trong bảng vai (`dr_member_roles`): **cần sửa CHECK của bảng** (DDL ở design, chờ duyệt). Trang Roles và script gán vai thêm vai này.
- **Pipeline:** `qa_signoff` approver kiểu vai `["qa", "tech_lead"]`; `requestChangesToStageKey` đổi từ `qa` sang `dev`, thêm bước chuyển `qa_signoff → dev`; `setup-dev-request-pipeline.mjs` đồng bộ cả approver, đích request_changes và bước chuyển cho công ty đã seed.
- Email nhân viên cho hàng chờ `qa_signoff`, số liệu và chi phí QA, số đếm sidebar.

## Capabilities

### New Capabilities
- `qa-stage`: agent QA kiểm nhánh đã duyệt theo tiêu chí nghiệm thu ở runner riêng và báo cáo bằng chứng từng tiêu chí; nhân viên có vai `qa` hoặc `tech_lead` ký duyệt ở `qa_signoff`.

### Modified Capabilities
- `dev-stage`: request_changes ở QA sign-off đưa yêu cầu về `dev` (không phải `qa`), và Dev nhận lý do cùng các tiêu chí QA không đạt làm phản hồi.
- `approver-roles`: thêm vai `qa` vào danh sách vai đóng.

## Impact

- `packages/db`: migration thay CHECK của `dr_member_roles` thêm `qa` (chờ duyệt). Không bảng mới: đề xuất lưu ở `dr_agent_outputs` (stage `qa`), sổ chi phí `agent.qa_run`.
- `packages/shared`: `PIPELINE_APPROVER_ROLES` thêm `qa`.
- `server/src/devflow/`: `qa/` (agent, service, schema, review, routes, start), `prompts/qa.v1.ts`, mở rộng `agent-stage/` (role `qa`), chỉnh `dev-service` (phản hồi sau QA), `dev-request-pipeline.json`, `roles/`, `email/staff-notify.ts`.
- `ui/`: trang QA sign-off, sidebar, trang Roles.
- `scripts/devflow/`: `setup-qa-agent.mjs`, mở rộng `setup-dev-request-pipeline.mjs`, `smoke-p4.mjs`.
- `docker/`: biến `DEVFLOW_QA_*`; không đổi runner (cùng image, cùng môi trường).

## Ngoài phạm vi
QA viết test rồi đẩy vào PR (chỉ chạy và báo cáo ở bản đầu); kiểm thử giao diện trên trình duyệt hoặc thiết bị thật; deploy lên môi trường thử; merge PR; kiểm thử hiệu năng hoặc bảo mật; chạy song song nhiều lượt QA; model local.
