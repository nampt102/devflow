## Context

- Pipeline `dev-request` đã có `qa` (working) → `qa_signoff` (review) → `done`; hiện `qa_signoff` approve → `done`, reject → `cancelled`, request_changes → `qa`, và `code_review` approve → `qa`. Không có bước chuyển `qa_signoff → dev`.
- Dev (ADR 0024) đã chạy được ở runner qua SSH của Paperclip: workspace trên server (`/paperclip/devflow/ws/<role>`, repo neo + `.paperclip-repositories/<key>`, clone đầy đủ), agent kiểm trước mỗi lượt (môi trường runner, tool, ngân sách, prompt), kiểm GitHub trước khi chạy, `request.md` có ranh giới ngẫu nhiên, báo cáo JSON strict, sổ chi phí và trần ngày, worker dùng khóa chung `dr-agent-stage-worker`. Smoke thật trên RESKI: agent chạy được `dotnet test` và `flutter test` ở runner.
- Đề xuất Dev đã duyệt nằm ở `dr_agent_outputs` (stage `dev`, `data.approved.repos[]`: hệ thống, nhánh, `headSha`, `prUrl`, `prNumber`), spec BA đã duyệt có `acceptanceCriteria`, kế hoạch đã duyệt có `testPlan`.
- `dr_member_roles` có CHECK đóng danh sách vai (`ba`, `tech_lead`).

## Goals / Non-Goals

**Goals:** kiểm nhánh của PR theo từng tiêu chí nghiệm thu đã duyệt và đưa cho người ký một báo cáo có bằng chứng; không đổi gì ở GitHub; người ký quyết định; cùng mức an toàn và chi phí có trần như Dev; request_changes đưa về Dev kèm lý do và tiêu chí không đạt.

**Non-Goals:** QA viết test rồi đẩy vào PR, kiểm thử trên trình duyệt hoặc thiết bị thật, dịch vụ phụ (Postgres, Redis) trong runner, deploy lên môi trường thử, merge, chạy song song, model local.

## Decisions

### D1. QA chỉ đọc và chạy, không đẩy gì
- Agent có cùng bộ tool với Dev (`Read, Grep, Glob, Edit, Write, Bash`): cần Bash để chạy test và Edit/Write để tạo file thử tạm. Mọi thay đổi bị bỏ khi dọn workspace; DevFlow **không bao giờ** đẩy trong stage `qa` và không có token ghi trong luồng này (token đọc, hoặc token ghi chỉ để clone nếu hệ thống chỉ có token ghi, như Dev).
- Nếu agent commit lên nhánh (lệnh cấm trong prompt, nhưng DevFlow không tin), đề xuất ghi cảnh báo `qa_modified_branch`: so `HEAD` sau lượt chạy với commit lúc bắt đầu. Commit đó không rời máy.
- Phương án để sau (không làm ở change này): QA tự thêm test vào PR qua cơ chế kiểm diff và đẩy của Dev.

### D2. Đầu vào: nhánh đã đẩy, tiêu chí nghiệm thu đánh mã
- Với từng hệ thống có PR trong `data.approved.repos` của đề xuất Dev: clone đầy đủ **nhánh `devflow/<REQ>` đã có trên GitHub** (mở rộng `prepareDevRepo` với chế độ `existingOnly`: nhánh không có thì lỗi `branch_missing`, không tạo nhánh mới). Kiểm thử **đầu nhánh hiện tại**, ghi cả SHA đã duyệt và SHA đã kiểm; khác nhau thì đề xuất ghi cảnh báo (người có thể đã đẩy thêm sau khi duyệt code).
- Không hệ thống nào có PR → lỗi cấu hình `no_qa_target` (thử lại chậm, không tốn tiền).
- `request.md`: yêu cầu, **tiêu chí nghiệm thu đã duyệt đánh mã AC1, AC2, ... theo thứ tự** (DevFlow đánh mã, agent không tự đặt), kế hoạch test đã duyệt, tóm tắt/kiểm tra/rủi ro/câu hỏi mở của Dev **như dữ liệu chưa kiểm chứng** (prompt nói rõ: không coi lời của Dev là bằng chứng, tự chạy), hệ thống (thư mục, nhánh, lệnh kiểm tra, SHA), phản hồi của lần ký trước nếu có; mọi dữ liệu người viết nằm giữa ranh giới ngẫu nhiên.
- Workspace `/paperclip/devflow/ws/qa` (cùng cách dựng với Dev, đường dẫn giống nhau ở server và runner); mỗi lượt một hệ thống.

### D3. Agent QA, cấu hình và kiểm trước mỗi lượt
- Tạo bằng `scripts/devflow/setup-qa-agent.mjs` (dùng lại key Anthropic và môi trường `devflow-runner`), `claude_local`, `engine: cli`, `cwd` `/paperclip/devflow/ws/qa`, `--max-budget-usd` (mặc định 3), 150 lượt, 40 phút, tác giả git qua `GIT_CONFIG_*`. Role `qa` thêm vào `StageRole`.
- Kiểm trước mỗi lượt dùng lại `unsafeDevAgentReason` đã được tham số hóa theo role (tool, hash prompt, cwd): cùng các mã `agent_not_on_runner`, `runner_environment_invalid`, `runner_host_key_not_pinned`, `agent_tools_changed`, `agent_prompt_outdated`...
- Sổ chi phí `agent.qa_run`, trần ngày `DEVFLOW_QA_MAX_USD_PER_DAY` (20), tách khỏi Dev; dùng khóa chung (một lượt agent tại một thời điểm toàn instance).
- Kiểm GitHub trước khi chạy: chỉ cần **đọc** repo (token đọc hoặc ghi), không đòi quyền đẩy hay PR.

### D4. Báo cáo JSON strict
```
summary (≤800)
criteria: [{ id "AC<n>", verdict "pass"|"fail"|"not_verified", how "automated"|"code_reading"|"manual", evidence (≤600) }]
checks: [{ system, command, passed, outputTail ≤2000 }]  (≤20)
issues: [{ severity "high"|"medium"|"low", title ≤200, steps ≤800 }]  (≤20)
manualTests: [≤300 mỗi mục] (≤15)
confidence "low"|"medium"|"high"
```
- Bị từ chối nếu `criteria` không có đúng mỗi mã AC được giao một lần (thiếu, thừa, trùng), `checks` nêu hệ thống lạ, hoặc sai schema; chạy lại một lần với lý do (như Dev).
- `not_verified` bắt buộc có lý do trong `evidence` (ví dụ "test cần PostgreSQL, runner không có"); `pass` bằng `code_reading` thuần (không chạy gì) vẫn hợp lệ nhưng UI gắn nhãn riêng để người ký biết đó là đọc code.
- **Khuyến nghị** do DevFlow tính, lưu ở `data.recommendation`: `approve` khi mọi tiêu chí `pass`, mọi lệnh `passed`, không có lỗi `high`, và không có cảnh báo `qa_modified_branch`; ngược lại `changes` kèm các lý do. Không bao giờ thay quyết định.

### D5. QA sign-off
- API `GET …/devflow/qa-queue|qa-count|qa-metrics|qa-cases/:id|qa-agent`, `POST …/qa-cases/:id/decision`, khuôn như Code review (quyết định nguyên tử qua `beforeCommit`, 409 khi thua đua, không tự duyệt, 404 ngoài công ty, `canDecide` và `requiredRoles`). Trang `/qa-signoff`: PR, bảng tiêu chí (kèm nhãn cách kiểm), lệnh đã chạy, lỗi, bước kiểm thủ công, khuyến nghị và cảnh báo.
- **approve** → `done`, `data.approved` lưu báo cáo; không merge. **reject** → `cancelled`, đóng PR như Code review (dùng chung hàm đóng PR, tách ra khỏi `review-service` của Dev). **request_changes** → **`dev`**: `beforeCommit` đánh dấu đề xuất QA là `superseded` **và đề xuất Dev đã duyệt là `superseded`** để cơ chế phản hồi của Dev (chỉ lấy đề xuất `superseded` mới nhất cùng sự kiện `review_decided` sau đó) tìm thấy phản hồi.
- Phản hồi cho Dev gồm lý do của người ký **và** danh sách tiêu chí QA báo `fail` hoặc `not_verified` (mã, nội dung, bằng chứng, cắt gọn); Dev đọc chúng như dữ liệu người viết (nằm trong ranh giới).
- Vai: `qa_signoff` approver `role` `["qa", "tech_lead"]`; thêm vai `qa` (D6).

### D6. Vai `qa` và pipeline
- `dr_member_roles` đổi CHECK thêm `qa` (DDL dưới); `PIPELINE_APPROVER_ROLES` thêm `qa`; trang Roles, script `set-member-roles.mjs` và validator stage nhận vai mới.
- `dev-request-pipeline.json`: `qa_signoff` đổi `approver` sang vai, `requestChangesToStageKey` từ `qa` sang `dev`, thêm bước chuyển `qa_signoff → dev` (bỏ `qa_signoff → qa`).
- `setup-dev-request-pipeline.mjs` mở rộng đồng bộ cho công ty đã seed: `approver` (đã có), `requestChangesToStageKey` của `qa_signoff`, và **thêm bước chuyển còn thiếu** vào danh sách hiện có (chỉ thêm, không xóa bước chuyển nào đã có). Chạy lại không đổi gì; test trên định nghĩa thật. Công ty chưa đổi vẫn chạy được nhưng request_changes còn về `qa` cho đến khi chạy script.

### D7. Số liệu, email, cấu hình
- `stageMetricsService` cho role `qa`: hàng chờ, quyết định, thời gian, chi phí, lỗi; thêm **tỷ lệ người ký ngược khuyến nghị** (approve khi khuyến nghị `changes`, hoặc trả lại khi `approve`): thước đo chất lượng QA, như tỷ lệ override ở các stage khác.
- Email nhân viên: thư riêng cho hàng chờ `qa_signoff` (`staff.notified_qa`); số đếm sidebar.
- Biến: `DEVFLOW_QA_ENABLED`, `DEVFLOW_QA_MODEL`, `DEVFLOW_QA_MAX_USD_PER_RUN`, `DEVFLOW_QA_MAX_USD_PER_DAY`, `DEVFLOW_QA_INTERVAL_MS`.

## DDL đề xuất (chờ duyệt)

```sql
ALTER TABLE dr_member_roles DROP CONSTRAINT dr_member_roles_role_check;
ALTER TABLE dr_member_roles ADD CONSTRAINT dr_member_roles_role_check CHECK (role IN ('ba', 'tech_lead', 'qa'));
```
- Không bảng hay cột mới. Đề xuất QA ở `dr_agent_outputs` (`stage_key = 'qa'`, `prompt_role = 'qa'`); ví dụ dòng dữ liệu `data`: báo cáo, `repos` (hệ thống, nhánh, SHA đã duyệt, SHA đã kiểm), `recommendation`, cảnh báo.
- Dữ liệu cũ không bị ảnh hưởng (chỉ mở rộng tập giá trị cho phép).

## Risks / Trade-offs

- [QA chạy mã của PR (mã do Dev agent viết cùng test của repo) ở runner] → cùng cô lập như Dev (runner không có DB hay secret của server, mạng chỉ qua proxy cho phép, không token GitHub ghi); chạy trong runner đã chạy được test của RESKI.
- [Test cần dịch vụ ngoài (PostgreSQL, Redis) mà runner không có] → tiêu chí đó là `not_verified` kèm lý do và bước kiểm thủ công; thêm dịch vụ phụ vào runner là việc sau (ngoài phạm vi).
- [Agent QA đánh giá nhầm hoặc "đạt" dễ dãi] → báo cáo bắt buộc bằng chứng cho từng tiêu chí, nhãn `code_reading`, khuyến nghị do DevFlow tính chứ không phải agent, và số đo tỷ lệ người ký ngược khuyến nghị để hiệu chỉnh prompt.
- [Một lượt QA tới 40 phút giữ khóa chung, chặn BA/Plan/Dev của cả instance] → như Dev (ghi nhận ở ADR 0024); tách khóa theo nơi chạy khi thông lượng không đủ.
- [Đổi đích request_changes của `qa_signoff` và thêm bước chuyển cho công ty đã seed] → script đồng bộ chạy lại được, chỉ thêm; test trên định nghĩa thật; trước khi chạy script, hành vi cũ giữ nguyên.
- [Dev nhận phản hồi QA qua cơ chế `superseded`] → test vòng trọn (QA trả lại, Dev nhận lý do và tiêu chí không đạt, đẩy commit mới lên cùng nhánh, QA chạy lại).
- [Nhánh đã bị người đẩy thêm sau khi duyệt code] → kiểm đầu nhánh hiện tại và cảnh báo khác SHA.

## Open Questions (mặc định nếu không có ý kiến)
1. QA chỉ đọc và chạy, không đẩy test vào PR. **Mặc định: chỉ đọc và chạy.**
2. Thêm vai `qa` (cần duyệt DDL ở trên) hay dùng `tech_lead` cho ký duyệt QA. **Mặc định: thêm vai `qa`, `qa_signoff` cho `qa` hoặc `tech_lead`.**
3. request_changes ở QA về `dev` hay `qa`. **Mặc định: `dev`** (lỗi thường cần sửa code; chạy lại QA không đổi được kết quả).
4. Đầu nhánh hiện tại hay đúng SHA đã duyệt. **Mặc định: đầu nhánh hiện tại, cảnh báo nếu khác.**
5. Model `claude-sonnet-5-5`, 3 USD mỗi lượt, 20 USD mỗi ngày mỗi công ty, tối đa 40 phút. **Mặc định như trên.**
