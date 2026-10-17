# Spike: Pipelines của Paperclip làm lõi workflow 7 stage

Phạm vi: đọc code, không chạy. Mọi dòng trích là `file:line` trong `D:\WORKING\SOURCECODE\DevFlow`. Chỗ nào chưa đọc tới code ghi "(chưa xác nhận)".
Viết tắt: S = `server/src/services/pipelines.ts`, R = `server/src/routes/pipelines.ts`, DB = `packages/db/src/schema`.

## 1. Approver model
- Cấu hình stage review: `approver: { kind: "any_human" | "user" | "agent"; id? }` + `requireApproval` (S:117-121). `reviewerKind: "human"|"any"` chỉ là alias legacy, ánh xạ sang `requireApproval` (S:975-979, S:1018-1024).
- `normalizeStageApprover` (S:1026-1049): `user`/`agent` bắt buộc có `id`. Không có kiểu `role` hay `group`.
- `assertActorCanApproveStageExit` (S:1061-1083) chỉ so khớp:
  - `requireApproval !== true` -> cho qua, ai cũng được.
  - `any_human` -> chỉ cần `actor.type === "user"`; không kiểm tra role hay membership ở tầng service.
  - `user` -> `actor.userId === approver.id`.
  - `agent` -> `actor.agentId === approver.id`.
- Hàm được gọi ở `transitionCaseInTransaction` (S:3240, khi `fromStage.id !== toStage.id`) và `reviewCase` (S:4915).
- Kết luận: không giới hạn theo ROLE (BA, Tech Lead). Chỉ có "mọi human" hoặc "đúng 1 user id". `approver.kind="agent"` cho phép agent duyệt, là bẫy cấu hình cho yêu cầu của ta.
- Role hiện có: `owner/admin/operator/viewer` (+ `member` legacy) (packages/shared/src/constants.ts:964-979). `grantsForHumanRole` (server/src/services/company-member-roles.ts:19-80): chỉ `operator` có `pipelines:write`; `viewer` = []. `owner`/`admin` không có grant `pipelines:write` trong danh sách này. Chưa kiểm tra việc `authorization.decide` có cho owner/admin qua bằng đường khác không (chưa xác nhận).
- Có thể ánh xạ BA/Tech Lead không? Không trực tiếp. 4 role là role quyền hạn, không phải role nghiệp vụ. Cách khả thi: (a) dùng `approver.kind="user"` mỗi stage (cứng, 1 người), hoặc (b) thêm kind `role` hay `group` cho approver (vá core, chỗ vá nhỏ: S:117, S:1026, S:1061, validator shared).

## 2. Quyền của agent
- `actorForMutation` (R:265-275): agent bắt buộc có `runId`, nếu không thì 422 `run_id_required`. Board = actor `user`. Actor `system` không đi qua route (nội bộ).
- Endpoint cho agent (đều chỉ qua `assertCaseAccess` = company access, R:593-597):
  - `PATCH /cases/:id`, `claim`, `release` (agent không được `force`, R:1821-1826), `transition`, `suggest-transition`, `resolve-suggestion`, `blockers`, `issue-links`, document PUT. Case-level mutation không kiểm tra `pipelines:write`.
  - `ingest` và `batch`, tạo/sửa pipeline và stage yêu cầu `pipelines:write` (R:1355-1370, R:1056-1160).
- Agent vượt stage review? Không, nếu stage `requireApproval=true` và approver `any_human` hoặc `user`: 403 `review_required`. Có test: pipelines-routes.test.ts:938-970 ("rejects agent exits from human review stages").
- Các đường có thể thủng, cần khóa:
  1. Stage `working` không có `requireApproval` (mặc định `kind==="review"` mới true, S:980) -> agent chuyển tự do. Không sao nếu đó là ý muốn ("AI chỉ đề xuất" thì stage working vẫn là agent tự chuyển; muốn chặn thì đặt `requireApproval:true` hoặc đổi stage thành `review`).
  2. `approver.kind="agent"` cho agent duyệt.
  3. Agent có `pipelines:write` (nếu được cấp) có thể `PATCH stage` đổi `requireApproval=false` rồi tự chuyển (R:1096-1107, S:3624). Việc agent có được cấp grant hay không phụ thuộc authorization (chưa xác nhận). Cần cấm agent sửa stage config.
  4. `transition` với `force` + `reason` vượt `enforceTransitions` (S:3251-3270) nhưng vẫn qua `assertActorCanApproveStageExit` (S:3240), nên không bypass approval. Event `transition_forced` được ghi.
  5. `transitionClass "auto"` chỉ `system` và bị chặn nếu stage `autonomy:"auto"` (S:3226-3228, S:3247-3249). Auto-advance khi children terminal có thể là system (S:3242); không bypass review vì `fromStage` review vẫn bị kiểm tra (chưa kiểm tra sâu nhánh `children_terminal`, chưa xác nhận).
- `suggest-transition` (S:4783): ghi `pendingSuggestion` (1 slot, ghi đè cái cũ, có `supersededSuggestionId`) + event `transition_suggested`. `resolveSuggestion accept` chạy lại `transitionCaseInTransaction` nên vẫn qua approver gate (S:4855-4866).
- Phát hiện: `assertLatestReviewApprovalStillCurrent` (S:1861) chặn chuyển sang `done` từ stage không-review nếu case đổi sau lần approve (`review_outdated`). Lưu ý: chỉ chặn ở đích `done`.

## 3. Events / audit
- `pipeline_case_events` (DB/pipeline_case_events.ts:7-27): `id, companyId, caseId, type, actorType(user|agent|system), actorUserId, actorAgentId, runId, fromStageId, toStageId, payload jsonb, createdAt, updatedAt`. Agent bắt buộc có `runId` (check `agent_run_check`, :55).
- Event types (CHECK, :33-56): ingested, updated, claimed, lease_released, lease_expired, transitioned, transition_forced, transition_suggested, suggestion_resolved, review_decided, conversation_opened, issue_linked/unlinked, automation_*, blockers_set/resolved, children_terminal, upstream_drift, drift_acknowledged. Muốn thêm kind phải đổi CHECK = migration.
- KHÔNG có diff field-level. Event `updated` chỉ lưu `previousVersion, version, parentCaseChanged, materialChanged, workspaceRefChanged` (S:3128-3170 vùng patchCaseContent, payload ở ~S:3152-3160). Không lưu giá trị cũ/mới của title/summary/fields; chỉ biết có đổi hay không. `fields` bị thay nguyên khối (không merge, S:3132-3140).
- `review_decided` payload có decision, reason, suggestionId, updateEventId, approvedCaseVersion (S:4950-4962); `reviewCase` với `edits` gom update + transition + decision trong 1 transaction (S:4924-4947), nhưng cũng không lưu diff giá trị.
- Nếu cần audit override per-field phải thêm: payload diff trong event `updated` (additive, sửa 1 chỗ), hoặc bảng riêng. Không có sẵn.
- Time in stage: tính được. Mỗi `transitioned` có `fromStageId/toStageId/createdAt`; hiệu thời điểm event liên tiếp = thời gian ở stage. Có API `GET /cases/:id/events` phân trang (R:2049, limit tối đa 100, S:`PIPELINE_CASE_EVENTS_MAX_LIMIT`) và `GET /companies/:id/case-events` (R:765). Chưa thấy view/aggregate sẵn "time in stage"; có `packages/shared/src/pipeline-health.ts` (chưa đọc, chưa xác nhận nó tính cái gì).

## 4. Case data
- `pipeline_cases.fields` jsonb `Record<string, unknown>` (DB/pipeline_cases.ts:49). Giới hạn 64KB (S:64, assertJsonSize S:607). Không có schema cấp pipeline.
- Có "variables" ở cấu hình stage (`config.variables`, S:123-133): `intakeFieldsForStage` (S:1228-1255) và `validateFieldsForIntakeStage` (S:1259-1297) kiểm required/select/number/boolean, nhưng tên hàm chỉ cho INTAKE khi ingest. Chưa xác nhận có áp dụng khi PATCH hay ở stage khác (chưa truy vết nơi gọi). `validateAddFormFieldsForStage` (S:1192-1214) tương tự cho add form. Đây là schema field nhẹ, không phải JSON Schema, không per-stage output của agent.
- `case_key`: text, unique theo `(pipelineId, caseKey)` (DB/pipeline_cases.ts:74). Mặc định `randomUUID()` nếu client không gửi (S:3913), tối đa 1024 ký tự (S:62). KHÔNG có bộ đếm kiểu REQ-123. Ingest idempotent theo caseKey (route trả 200 khi đã có, R:1360-1362). Muốn REQ-123 phải tự sinh phía caller (race-prone) hoặc thêm sequence per pipeline (vá core, S).
- Liên kết case-issue: bảng `pipeline_case_issue_links` role `origin|conversation|work|automation` (DB/pipeline_cases.ts:92-96), API `POST/DELETE /cases/:id/issue-links` (R:1977-2047), có event `issue_linked/unlinked`.
- Breakdown thành case con: `POST /cases/:id/breakdown` (R:1372); cấu hình stage `config.breakdown` {targetPipelineId, targetStageKey, pieceNoun, carryOverPolicy, inheritFields, advanceTo, waitForPieces, whenFinishedMoveTo} (S:743-775). Case con dùng `parentCaseId`, `requestKey` idempotent (unique `parent_case_id+request_key`, DB:75-77), counters `childCount/terminalChildCount`, gate `requireChildrenTerminal`, parent depth tối đa 32 (S:~1655). Có `blockers` (bảng riêng) và `upstream_drift` notify.
- Tài liệu: `pipeline_case_documents` keyed `(caseId, key)` + document revisions (R:1479-1700). Đây là chỗ tự nhiên cho output có cấu trúc theo stage (key = `ba_spec`, `tech_plan`...), có lịch sử revision. Chưa kiểm nội dung có validate schema không (chưa xác nhận).

## 5. request_changes / reject / enforceTransitions / concurrency
- Review có 3 lối ra: `approveToStageKey`, `rejectToStageKey`, `requestChangesToStageKey` (S:111-113, hàm `targetStageKeyForReviewDecision` ~S:1100). Approve/reject bắt buộc có đích hợp lệ khi lưu (S:991-1000, `assertReviewTargetsInSet` S:1085-1096).
- `requireRejectReason` mặc định true (S:88, S:1010); `requireRequestChangesReason` mặc định true. Thiếu reason -> 422 `validation` (S:4917-4922). Test: pipelines-routes.test.ts:1019-1064, 1124-1170 (kể cả `requireRejectReason:false`).
- Nếu không cấu hình `requestChangesToStageKey`: hành vi cụ thể chưa đọc (chưa xác nhận; test :1064 "routes request-changes to configured stage").
- `enforceTransitions` (cột `pipelines.enforce_transitions`, mặc định false, DB/pipelines.ts:15): khi bật, chuyển stage phải có edge trong `pipeline_transitions`, nếu không -> 409 `transition_not_allowed`, trừ khi `force:true` + `reason` không rỗng (khi đó ghi `transition_forced`) (S:3251-3270). Test: pipelines-service.test.ts:435.
- Concurrency: `version` int tăng khi material change/transition; mọi mutation cần `expectedVersion`, sai -> 409 "version conflict" kèm `conflictDetailsForCase` (code, currentVersion, stage) (S:3123-3125, S:3231-3233). Update dùng `WHERE version = current` (optimistic). Lease: `claim` -> `leaseToken`, hết hạn mặc định 15 phút, tối đa 24 giờ (S:60-61); khi case bị lease bởi actor khác -> 409 `lease_held`; người giữ lease phải gửi `leaseToken` (S:1590-1599). Client phải: lấy `version` từ GET, gửi `expectedVersion`, tùy chọn claim và gửi `leaseToken`, xử lý 409. Test: pipelines-service.test.ts:309, 339, 373, 412; routes :1271.
- Claim: route chặn actor `system` (R:1812-1818). Lease được xóa khi vào stage terminal (S:3291-3296).

## 6. Auth / tenancy
- Mọi route qua `assertPipelineCompanyAccess` -> `assertCompanyAccess` (server/src/routes/authz.ts:~68-112), lỗi cross-company đổi thành 404 (R:250-263; test routes :818 "returns 404 for cross-company").
- Actor types: `board` (session hoặc `local_implicit`, instance admin), `agent` (key/JWT; `source:"agent_key"` trong test), `none` (401). Board với membership `viewer` bị chặn mọi method không-GET (authz.ts:~96-110). Agent có `onBehalfOfUserId` kế thừa quyền của membership người chịu trách nhiệm (authz.ts:~80-95). Có cả "board key" (chưa xác nhận tên/phạm vi code path).
- Đọc: mọi member company (kể cả viewer) đọc được MỌI case trong company. Không có cột `ownerUserId` nào để lọc; `createdByUserId` tồn tại (DB/pipeline_cases.ts:64) nhưng `GET /pipelines/:id/cases` (R:1381) và `GET /cases/:id` (R:1446) không lọc theo nó. Không có route đọc "chỉ case của tôi".
- Vì vậy portal cho requester giới hạn: không có sẵn. Phải thêm (a) filter theo `createdByUserId` cho role đặc biệt, hoặc (b) route/proxy riêng ngoài Pipelines. Cũng chưa có role "requester": viewer thì read-only toàn company, còn operator ghi được rất rộng.

## 7. Feature flag
- `enablePipelines` trong instance settings experimental, mặc định false (packages/shared/src/validators/instance.ts:63; server/src/services/instance-settings.ts:243, 294). Khai báo `tier:"managed"`, cloudDefault/selfHostedDefault false (packages/shared/src/feature-catalog.ts:171-177). Bật qua `PATCH /instance/settings/experimental` (server/src/routes/instance-settings.ts:263) và trang `InstanceExperimentalSettings` ở UI. Chưa xác nhận biến môi trường hay managed config nào ép giá trị (tests managed-config tồn tại, chưa đọc).
- Khi tắt: chỉ UI ẩn mục sidebar (ui/src/components/Sidebar.tsx:102) và `PipelinesExperimentalGate` điều hướng về `/dashboard` (ui/src/components/PipelinesExperimentalGate.tsx:14-17). SERVER KHÔNG chặn: `api.use(pipelineRoutes(db))` luôn mount (server/src/app.ts:852), grep `enablePipelines` ở server/src chỉ thấy instance-settings.ts. API vẫn dùng được khi flag tắt (đã kiểm bằng grep, chưa chạy). Với ta thì tiện (bật flag UI, API luôn sẵn) nhưng cần biết khi bàn bảo mật.

## 8. Test coverage + dấu hiệu bất ổn
- `server/src/__tests__/pipelines-service.test.ts` (1909 dòng): seed stage, ingest idempotent/batch, workspaceRef, optimistic concurrency, lease, enforceTransitions, blockers, upstream drift, parent/child rollup + auto-advance, suggestion lifecycle, event cho mỗi mutation, automation theo stage (idempotent, title template, cross-company), retry.
- `server/src/__tests__/pipelines-routes.test.ts` (1285 dòng): route surface, cross-company 404, agent cần runId, agent không thoát review, validate config review, review atomic + reject reason, request_changes, review inbox, bulk review, conflict body, phân trang events, context-pack.
- Khác: `packages/db/src/pipelines-schema.test.ts`, `packages/shared/src/pipeline-health.test.ts`, `cli/src/__tests__/pipelines.test.ts`, `ui/src/pages/Pipelines.test.tsx`, `ui/src/pages/PipelineSettings.test.ts`, `ui/src/components/PipelinesExperimentalGate.test.tsx`, `tests/e2e/pipelines-tutorial-flow.spec.ts`, `doc/plans/2026-10-13-pipeline-bulk-review-test-audit.md` (chưa đọc nội dung). Tôi không chạy test nên chưa biết pass/fail.
- Thiếu test rõ: approver `user` mismatch (chỉ thấy test agent vs human), approver theo role (không tồn tại), field diff. (Dựa grep `approver|review_required` trong 2 file test: chỉ 1 hit `review_required`.)
- Marker: `TODO|FIXME` = 0 hit trong S, R, Pipelines.tsx, tutorial. Cờ "experimental" nằm ở flag/UI gate và ADR của ta (openspec/decisions/0003-pipelines-as-workflow-core.md:8). Pipelines.tsx 5286 dòng, S 5179 dòng, R 2798 dòng: file rất lớn, khó merge upstream.

## 9. Gap so với nhu cầu

| Nhu cầu | Có sẵn? | Cách bổ sung | Cỡ |
|---|---|---|---|
| Agent chỉ đề xuất, người duyệt ở review stage | Có: `kind:review` + `any_human`, test cover | Chỉ cấu hình; cấm agent PATCH stage/`approver.kind=agent` | S |
| Approver theo ROLE (BA, Tech Lead) | Không | Thêm `approver.kind="role"|"group"` + bảng/role nghiệp vụ; sửa `assertActorCanApproveStageExit` (cần truy membership, hiện hàm đồng bộ không có db) + validator + UI | M |
| Structured output theo stage của agent | Một phần | Dùng `pipeline_case_documents` key theo stage, hoặc ghi vào `fields[stageKey]`; validate bằng JSON Schema ở `config` (additive) | M |
| Audit override per-field (cũ/mới, ai, khi nào) | Không (chỉ cờ `materialChanged`) | Thêm diff vào payload `updated` + `review_decided.edits`; additive, không đổi CHECK | M |
| `case_key` dạng REQ-123 | Không (UUID) | Sequence per pipeline trong transaction ingest | S |
| Time in stage | Tính được từ `transitioned` | Query/view, hoặc endpoint mới | S |
| Requester portal (chỉ xem case của mình) | Không | Role `requester` + filter `createdByUserId`, hoặc route riêng; sửa authz cho GET | M-L |
| Field schema per pipeline | Rất nhẹ (variables) | Thêm validate cho mọi PATCH, không chỉ intake | M |
| Cưỡng chế server khi flag tắt | Không | 1 middleware gate trước `pipelineRoutes` | S |

Đa số là thay đổi additive trong core (service + route + validator + UI), không có cái nào cần plugin hóa. Plugin SDK có tồn tại không và có hook vào pipeline không: chưa xác nhận. Không có gì buộc phải viết lại state machine.

## Verdict: needs patches (không phải "sound base" nguyên trạng, nhưng không cần bỏ)
Nền tốt: state machine, stage review với 3 lối ra, agent không vượt được stage human (có test), optimistic version + lease, events có actor/run, child cases, tenancy trả 404. Điểm yếu đúng vào chỗ ta cần: role-based approver, per-field audit, requester isolation, field schema.

Patch cần làm:
1. Approver theo role (M): sửa S:1026-1083 + validators shared + UI settings.
2. Per-field diff trong event `updated`/`review_decided` (M): S ~3150-3170, S:4950.
3. Structured per-stage output + validate (M): dùng case documents hoặc `fields`.
4. Khóa cấu hình: cấm agent sửa stage config và `approver.kind="agent"` cho workflow này (S): R:1096-1160, S:1026.
5. `case_key` REQ-n (S): S:3913.
6. Requester portal / lọc theo owner (M-L): authz + route + role mới. Có thể tách thành route riêng ngoài Pipelines nếu muốn giảm rủi ro merge upstream.
7. Gate flag phía server (S), time-in-stage endpoint (S).
Rủi ro: file lớn (~5k dòng S, ~5k UI) và tính experimental làm merge upstream tốn công; nên giữ patch nhỏ, tập trung 1-2 module phụ.

## Chưa xác nhận
- `authorization.decide` cấp `pipelines:write` cho owner/admin và cho agent như thế nào (grep authorization.ts không thấy từ "pipeline"; có thể cấp qua grants).
- Agent có thể được cấp `pipelines:write` mặc định hay không (liên quan đường sửa stage config).
- `validateFieldsForIntakeStage` / `validateAddFormFieldsForStage` được gọi ở đâu (có áp dụng khi PATCH không).
- Hành vi khi `requestChangesToStageKey` không đặt (fallback).
- Nhánh `children_terminal` auto-advance có né approver ở stage review của parent hay không.
- Nội dung `pipeline-health.ts`; nội dung `doc/plans/2026-10-13-pipeline-bulk-review-test-audit.md`.
- Biến môi trường/managed config ép `enablePipelines`.
- Tests có pass hay không (không chạy).
- Plugin extension point cho pipelines; "board key" actor cụ thể.
- Document case có validate nội dung hay không.
