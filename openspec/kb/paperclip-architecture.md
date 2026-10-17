# DevFlow trên nền Paperclip: tài liệu kiến trúc (khảo sát)

Ngày khảo sát: 2026-10-17. Phạm vi: đọc code, không chạy hệ thống. Mọi mục chưa tự tay kiểm chứng (chạy thử) đều đánh dấu "(chưa xác nhận)".

Mục tiêu sản phẩm: quản lý vòng đời yêu cầu phần mềm (Intake -> Triage -> BA Spec -> Tech Plan -> Dev -> QA -> Done), AI agent đề xuất, con người duyệt tại các cổng (gate), đa công ty (multi-company).

Nguồn đọc chính: `AGENTS.md`, `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md` (chỉ đọc lướt, rất dài), `doc/DEVELOPING.md`, `doc/DATABASE.md`, `doc/SEARCH.md`, `doc/execution-semantics.md`, `docs/pipelines-tutorial.md` (của Paperclip), `docs/agents-runtime.md`, `docs/adapters/*`, `rules/*.mdc`, và code trong `packages/db`, `packages/shared`, `server`, `ui`.

---

## 0. Phát hiện quan trọng nhất: Paperclip đã có "Pipelines"

Paperclip có sẵn một khái niệm rất gần với yêu cầu của DevFlow. Có hai thứ khác nhau, cần phân biệt:

### 0.1 Pipelines (stage workflow theo "case"), đang là tính năng Experimental

- Bảng: `pipelines`, `pipeline_stages`, `pipeline_transitions` (`packages/db/src/schema/pipelines.ts`); `pipeline_cases`, `pipeline_case_issue_links`, `pipeline_case_blockers`, `pipeline_documents`, `pipeline_case_documents`, `pipeline_automation_executions` (`packages/db/src/schema/pipeline_cases.ts`); `pipeline_case_events` (`packages/db/src/schema/pipeline_case_events.ts`). Migration bắt đầu từ `packages/db/src/migrations/0113_pipeline_foundation.sql` đến `0122_pipeline_case_documents.sql` (và các migration sau đó).
- Định nghĩa: một `pipeline` là một loại việc (mỗi pipeline = một "case type", xem `packages/shared/src/pipeline-case-type.ts`: `deriveCaseType` lấy từ `pipelines.key`). Một `pipeline_case` là một đối tượng đi qua các stage. Stage có `kind` trong DB là `working | review | done | cancelled` (check constraint `pipeline_stages_kind_check`); API vẫn nhận `open` kiểu cũ (`packages/shared/src/validators/pipeline.ts`: `legacyPipelineStageKindSchema`, `server/src/routes/pipelines-schemas.ts`: `stageKindSchema`).
- Cổng duyệt (gate) là first-class. `pipelineStageConfigSchema` (`packages/shared/src/validators/pipeline.ts`) có: `requireApproval`, `approver` (`any_human | user | agent`), `approveToStageKey`, `rejectToStageKey`, `requestChangesToStageKey`, `requireRejectReason`, `requireChildrenTerminal`, `requireNoUnresolvedDrift`, `onEnter` (`run_routine`), `automation` (`routineId`, `assigneeAgentId`, `instructionsBody`, workspace), `breakdown` (tách case con sang pipeline khác), `variables` (form intake).
- Enforce server-side: `assertActorCanApproveStageExit` (`server/src/services/pipelines.ts` ~dòng 1061): với `approver.kind = any_human` thì chỉ actor `user` mới qua được, agent bị 403 `review_required`. `reviewCase` (~dòng 4893) xử lý `approve | reject | request_changes`, bắt buộc lý do nếu cấu hình. `transitionCaseInTransaction` (~dòng 3206) kiểm tra optimistic version (`expectedVersion`), lease, `enforceTransitions` (bảng `pipeline_transitions`, có `force` + lý do), blockers.
- Agent chỉ được đề xuất: `pipeline_cases.pendingSuggestion` (`toStageKey`, `rationale`, `confidence`, `suggestedByAgentId`, `runId`), route `POST /api/cases/:caseId/suggest-transition` và `/resolve-suggestion`. Chế độ `autonomy: "auto"` hiện bị chặn có chủ đích: `transitionCaseInTransaction` ném `autonomy_not_enabled` trừ khi actor là `system`. Đây đúng mô hình "AI đề xuất, người duyệt".
- Agent làm việc thông qua issue được liên kết: `pipeline_case_issue_links` (role `origin | conversation | work | automation`); stage có `automation` sẽ tạo "routine execution issue" qua `pipeline_automation_executions`, có ledger idempotency + retry (`routes/pipelines.ts`: `/cases/:caseId/automation/retry`).
- API đầy đủ: `server/src/routes/pipelines.ts` (~2800 dòng), ví dụ `POST /companies/:companyId/pipelines`, `POST /pipelines/:pipelineId/cases`, `POST /cases/:caseId/transition|review|claim|release|suggest-transition|resolve-suggestion`, `GET /companies/:companyId/review-cases`, `POST /companies/:companyId/review-cases/bulk`, `GET /cases/:caseId/events`, `/context-pack`, `/rollup`. CLI: `paperclipai pipelines ...` (`cli/src/commands/pipelines.ts`). UI: `ui/src/pages/Pipelines.tsx` (kèm `ReviewQueue`, `PipelineItemDetail`), `PipelineSettings.tsx`, cổng bởi `PipelinesExperimentalGate`.
- Bật bằng cờ experimental của instance: `enablePipelines` (mặc định `false`, `server/src/services/instance-settings.ts`). Hướng dẫn thực hành: `docs/pipelines-tutorial.md` (của Paperclip) (3 pipeline liên kết: release-coverage, feature-content, content-production), smoke: `pnpm smoke:pipelines-tutorial`.
- Hệ quả cho DevFlow: Intake -> ... -> Done có thể ánh xạ gần như trực tiếp thành 1 pipeline "software-request" với stage `working` (Intake, Triage, BA Spec, Tech Plan, Dev, QA), stage `review` có `requireApproval` ở các gate (sau Triage, BA Spec, Tech Plan, QA), stage `done`/`cancelled`. Còn lại: mức độ ổn định của tính năng Experimental (chưa xác nhận), UI tiếng Việt (xem mục 11).

### 0.2 "Cases" (khác Pipelines), cũng Experimental

- Bảng `cases` (`packages/db/src/schema/cases.ts`): `caseNumber`, `identifier`, `caseType`, `key`, `status` (`draft | in_progress | in_review | approved | done | cancelled` theo check constraint), `fields` jsonb, `parentCaseId`. Có chỉ mục `gin_trgm_ops` cho tìm kiếm title/summary. Routes: `server/src/routes/cases.ts`, gate bởi `enableCases` (mặc định `false`). Không có định nghĩa stage cấu hình được; status cố định. Quan hệ giữa `cases` và `pipeline_cases` (chưa xác nhận: có vẻ là hai tính năng độc lập).

### 0.3 Execution policy trên issue (cổng review/approval cho từng issue)

- `issues.executionPolicy` (jsonb) với `stages: [{type: "review" | "approval", participants, approvalsNeeded: 1}]`, `commentRequired`, `maxReviewRounds`... (`packages/shared/src/validators/issue.ts`: `issueExecutionPolicySchema`). Quyết định lưu ở `issue_execution_decisions`. Tài liệu: `docs/guides/execution-policy.md`. Đây là cổng ở mức issue, không phải workflow nhiều bước kiểu pipeline.

---

## 1. Cấu trúc repo

Monorepo pnpm (`pnpm-workspace.yaml`: `packages/*`, `packages/adapters/*`, `packages/plugins/*`, `server`, `ui`, `cli`). Node >= 24.11, `packageManager: pnpm@9.15.4` (`package.json`). Giấy phép MIT.

| Thư mục | Vai trò |
|---|---|
| `server/` | API REST Express 5 + dịch vụ điều phối (`server/src/routes`, `services`, `middleware`, `auth`, `adapters`, `realtime`) |
| `ui/` | Board UI: React 19 + Vite 8 + Tailwind 4 + react-router 7 + TanStack Query 5 + radix-ui; i18n bằng i18next |
| `packages/db/` | Drizzle schema (`src/schema/*.ts`), migrations SQL (`src/migrations`), client, embedded Postgres |
| `packages/shared/` | Types, constants (`constants.ts`), validators zod (`validators/`), đường dẫn API |
| `packages/adapters/*` | Adapter chạy agent: claude-local, codex-local, cursor-cloud, cursor-local, gemini-local, grok-local, hermes, hermes-gateway, kimi-local, openclaw-gateway, opencode-local, pi-local |
| `packages/adapter-utils/` | Tiện ích dùng chung cho adapter (kiểu `ServerAdapterModule`, ssh, acpx-engine...) |
| `packages/plugins/` | `sdk`, `create-paperclip-plugin`, `examples/*`, `plugin-llm-wiki`, `plugin-workspace-diff`, `sandbox-providers` |
| `packages/mcp-server`, `google-sheets-mcp-server`, `kv-demo-mcp-server` | MCP server |
| `packages/paperclip-runner`, `paperclip-eval-kernel` | Runner native (adapter `paperclip_runner`) và eval |
| `packages/skills-catalog`, `teams-catalog` | Catalog skill/team đi kèm app |
| `cli/` | CLI `paperclipai` (`cli/src/commands/*`: onboard, run, doctor, pipelines, routines, mcp, worktree, db-backup...) |
| `skills/` | Skill vận hành runtime (paperclip, paperclip-board, ...) cho agent |
| `doc/`, `docs/` | `doc/` = tài liệu vận hành/sản phẩm nội bộ; `docs/` = tài liệu kiểu Mintlify (`docs/docs.json`) |
| `rules/` | Quy tắc kiến trúc `.mdc` (xem 1.1) |
| `maps/`, `tests/`, `scripts/`, `evals/`, `patches/` | Feature map, e2e/smoke, script dev/release, patch pnpm |

### 1.1 Quy tắc bắt buộc đọc trước khi sửa (từ `AGENTS.md`, `rules/`)

- Thứ tự đọc: `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, `doc/DATABASE.md`.
- Bất biến cần giữ (AGENTS.md mục 5): mọi entity scope theo company; single-assignee task; atomic checkout; approval gate cho hành động bị quản trị; budget hard-stop auto-pause; activity log cho mọi mutation. Đổi schema/API phải đồng bộ `packages/db`, `packages/shared`, `server`, `ui`.
- `rules/*.mdc`: `product-harness-responsibility.mdc` (alwaysApply: việc lặp để harness lo, UI chỉ lộ chi tiết phục vụ quyết định thật), `pull-request-review.mdc` (alwaysApply), `database-migration-snapshots.mdc` (giữ 5 snapshot Drizzle mới nhất), `heartbeat-execution-boundaries.mdc`, `chat-channel-platform-boundaries.mdc`, `runtime-dependency-boundaries.mdc`. `rules/README.md` mô tả cách viết rule và Greptile.
- Quy ước PR: bắt buộc dùng `.github/PULL_REQUEST_TEMPLATE.md` (AGENTS.md mục 10). Không commit `pnpm-lock.yaml` trong PR (`doc/DEVELOPING.md`, "Dependency Lockfile Policy"). Plan doc mới đặt ở `doc/plans/YYYY-MM-DD-slug.md`.
- Lưu ý: DevFlow là bản clone; tài liệu này nằm ở `openspec/kb/paperclip-architecture.md` theo yêu cầu, không phải `doc/plans/`.

---

## 2. Stack, chạy, test, typecheck, build

Stack server: Express 5, zod 4, pino, ws, better-auth 1.7.2, drizzle-orm 0.45 (`server/package.json`). Server cũng phụ thuộc `@ai-sdk/anthropic|openai|google|xai|amazon-bedrock` (dùng cho các tính năng LLM phía server, không phải adapter agent; chi tiết dùng ở đâu: chưa xác nhận).

Lệnh (từ `package.json` gốc, `doc/DEVELOPING.md`, `AGENTS.md`):

| Việc | Lệnh |
|---|---|
| Cài đặt | `pnpm install` |
| Dev (watch, API + UI cùng cổng 3100) | `pnpm dev` (UI do server phục vụ ở chế độ Vite middleware) |
| Dev không watch (tự áp migration chờ) | `pnpm dev:once` |
| Liệt kê/dừng dev service | `pnpm dev:list`, `pnpm dev:stop` |
| Chỉ server / chỉ UI | `pnpm dev:server`, `pnpm dev:ui` |
| Data dir cô lập | `pnpm dev --data-dir ./tmp/paperclip-dev` |
| Health check | `curl http://localhost:3100/api/health` |
| Test mặc định (Vitest) | `pnpm test` (= `pnpm test:run`, `scripts/run-vitest-stable.mjs`) |
| Test watch | `pnpm test:watch` |
| E2E / release smoke (opt-in) | `pnpm test:e2e`, `pnpm test:release-smoke` |
| Typecheck toàn repo | `pnpm -r typecheck` (hoặc `pnpm typecheck`) |
| Build toàn repo | `pnpm build` |
| Gate trước khi bàn giao PR | `pnpm -r typecheck && pnpm test:run && pnpm build` (AGENTS.md mục 7) |
| Kiểm tra khác | `pnpm check:module-boundaries`, `pnpm check:tokens`, `pnpm check:no-git-push` |
| Reset DB dev | xoá thư mục DB của instance (xem mục 3), rồi `pnpm dev` |
| Storybook | `pnpm storybook` |

Ghi chú: `AGENTS.md` mục 4 nói "embedded PGlite" và `rm -rf data/pglite`, nhưng `doc/DEVELOPING.md` và `doc/DATABASE.md` (mới hơn) nói embedded PostgreSQL tại `~/.paperclip/instances/default/db`. Code `packages/db/src/runtime-config.ts` vẫn còn nhánh `database.mode === "pglite"`. Coi DEVELOPING/DATABASE là đúng (chưa xác nhận bằng cách chạy).

Môi trường Windows: nhiều script `build` dùng `rm -rf`, `mkdir -p`, `cp -R` (ví dụ `packages/db/package.json`, `server/package.json`), và `docker`/`.sh`. Chạy trên Windows cần Git Bash/WSL (chưa xác nhận trên máy này). Khuyến nghị WSL2 hoặc Docker (`doc/DOCKER.md`, `Dockerfile`).

---

## 3. DB, ORM, migration

- PostgreSQL + Drizzle ORM (`packages/db`). Có 3 chế độ (`doc/DATABASE.md`): (1) embedded PostgreSQL không cần cấu hình khi `DATABASE_URL` không đặt (gói `embedded-postgres`, dữ liệu ở `~/.paperclip/instances/default/db`, đổi bằng `PAPERCLIP_HOME`/`PAPERCLIP_INSTANCE_ID`); (2) PostgreSQL local qua Docker; (3) PostgreSQL hosted (Supabase). Đặt `DATABASE_URL` để dùng DB ngoài.
- Schema: `packages/db/src/schema/*.ts`, export qua `packages/db/src/schema/index.ts`. Hiện có 354 file migration (`0000` đến `0354_agent_connection_assignment_hooks.sql`) trong `packages/db/src/migrations`, kèm `meta/_journal.json`.
- Sinh migration: `pnpm db:generate` (= `pnpm --filter @paperclipai/db generate`: chạy `check:migrations`, clean, `tsc`, `drizzle-kit generate`, rồi `prune:snapshots`). `packages/db/drizzle.config.ts` đọc schema đã compile ở `dist/schema/*.js`, output `./src/migrations`, dialect `postgresql`. Chỉ giữ 5 snapshot mới nhất (`rules/database-migration-snapshots.mdc`). Có kiểm tra `check-migration-numbering.ts` và `check-migration-safety.ts`; xem "Migration authoring checklist" trong `doc/DATABASE.md`.
- Áp migration: `pnpm db:migrate` (`packages/db/src/migrate.ts`: `inspectMigrations` + `applyPendingMigrations`). Server khởi động từ chối chạy với schema cũ trừ khi đặt `PAPERCLIP_MIGRATION_AUTO_APPLY=true` (`server/src/index.ts` ~dòng 260-330); `pnpm dev:once` tự áp. DB rỗng được tự migrate khi dùng embedded.
- Backup: tự động (mặc định bật, mỗi 60 phút, `doc/DEVELOPING.md` "Automatic DB Backups"), `pnpm db:backup`.
- Cô lập theo plugin: mỗi plugin có namespace schema Postgres riêng (`plugin_database.ts`, `database.namespace.*`).
- Không thấy Row Level Security trong migration (grep không có kết quả); cô lập tenant do tầng ứng dụng (mục 6).

---

## 4. Mô hình dữ liệu chính (bảng, cột chính, file)

Tất cả nằm trong `packages/db/src/schema/`. Hầu hết có `company_id`.

| Khái niệm | Bảng | Cột chính | File |
|---|---|---|---|
| Company | `companies` | `id`, `name`, `status` (`active|paused|archived`), `issuePrefix`, `issueCounter`, `budgetMonthlyCents`, `spentMonthlyCents`, `requireBoardApprovalForNewAgents`, `interactionResolverGovernance`, `defaultResponsibleUserId` | `companies.ts` |
| Thành viên company | `company_memberships` | `companyId`, `principalType`, `principalId`, `status`, `membershipRole` (có `viewer`) | `company_memberships.ts` |
| Người dùng/auth | `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications` (better-auth) | | `auth.ts` |
| Agent | `agents` | `companyId`, `name`, `role`, `title`, `status`, `reportsTo`, `capabilities`, `adapterType`, `adapterConfig`, `runtimeConfig`, `budgetMonthlyCents`, `permissions`, `lastHeartbeatAt`, `lifecycleState` | `agents.ts` |
| Khoá agent | `agent_api_keys` | `agentId`, `companyId`, `keyHash`, `responsibleUserId`, `scopeConfig` | `agent_api_keys.ts` |
| Issue/task | `issues` | `companyId`, `projectId`, `goalId`, `parentId`, `title`, `description`, `status`, `priority`, `assigneeAgentId`, `assigneeUserId`, `checkoutRunId`, `executionRunId`, `reviewPolicy`, `executionPolicy`, `executionState`, `identifier`, `issueNumber`, `originKind`, `visibility`, `workMode`, `billingCode` | `issues.ts` |
| Quan hệ issue | `issue_relations`, `issue_documents`, `issue_attachments`, `issue_labels`, `issue_work_products`, `issue_thread_interactions`, `issue_execution_decisions`, `issue_approvals` | | các file cùng tên |
| Comment | `issue_comments` | `issueId`, `authorAgentId`, `authorUserId`, `authorType`, `createdByRunId`, `body`, `metadata`, `presentation`, `sourceTrust` | `issue_comments.ts` |
| Run/heartbeat | `heartbeat_runs` | `agentId`, `issueId`, `status`, `invocationSource`, `triggerDetail`, `startedAt`, `finishedAt`, `usageJson`, `resultJson`, `sessionIdBefore/After`, `logStore/logRef`, `retryOfRunId`, `errorCode` | `heartbeat_runs.ts` |
| Sự kiện run | `heartbeat_run_events` | log theo run (cũng nằm trong `doc/run-log-events.md`) | `heartbeat_run_events.ts` |
| Wakeup | `agent_wakeup_requests` | `agentId`, `source`, `reason`, `payload`, `status`, `coalescedCount`, `idempotencyKey`, `runId` | `agent_wakeup_requests.ts` |
| Approval | `approvals` | `companyId`, `type`, `requestedByAgentId/UserId`, `status`, `payload`, `decisionNote`, `decidedByUserId`, `decidedAt`; kèm `approval_comments`, `issue_approvals` | `approvals.ts` |
| Chi phí | `cost_events` | `agentId`, `issueId`, `projectId`, `heartbeatRunId`, `provider`, `model`, `inputTokens`, `outputTokens`, `costCents`, `billingType`, `occurredAt` | `cost_events.ts` |
| Ngân sách | `budget_policies`, `budget_incidents` | `scopeType`, `scopeId`, `metric`, `windowKind`, `amount`, `warnPercent`, `hardStopEnabled`, `isActive` | `budget_policies.ts`, `budget_incidents.ts` |
| Audit log | `activity_log` | `companyId`, `actorType`, `actorId`, `action`, `entityType`, `entityId`, `agentId`, `runId`, `details` | `activity_log.ts`; ghi qua `logActivity` (`server/src/services/activity-log.ts`) |
| Project | `projects` | `companyId`, `goalId`, `name`, `status`, `leadAgentId`, `executionWorkspacePolicy`, `env` | `projects.ts` |
| Workspace | `project_workspaces`, `execution_workspaces`, `workspace_runtime_services`, `workspace_operations`, `execution_workspace_repositories` | `cwd`, `repoUrl`, `repoRef`, `setupCommand`... | các file cùng tên |
| Routine (cron/webhook trigger) | `routines`, `routine_triggers` | `cronExpression`, `kind`, `nextRunAt`, `publicId` | `routines.ts` |
| Plugin | `plugins`, `plugin_config`, `plugin_company_settings`, `plugin_state`, `plugin_jobs` + `plugin_job_runs`, `plugin_webhooks` (`plugin_webhook_deliveries`), `plugin_entities`, `plugin_logs`, `plugin_database`, `plugin_managed_resources` | `pluginKey`, `packageName`, `version`, `manifestJson`, `status` | các file `plugin_*.ts` |
| Skill | `company_skills`, `company_skill_sources`, `company_skill_policies` | | các file cùng tên |
| Goal | `goals`, `project_goals` | | `goals.ts` |
| Secrets | `company_secrets`, `company_secret_versions`, `company_secret_bindings`, `secret_access_events` | | `company_secret*.ts` |
| Pipeline | xem mục 0.1 | | `pipelines.ts`, `pipeline_cases.ts`, `pipeline_case_events.ts` |
| Tài liệu | `documents`, `document_revisions`, `document_annotation_*` | dùng cho spec/plan gắn issue/case | `documents.ts`... |

Quy ước: tiền lưu theo cents (`numeric(24,7)` cho `spent`/`cost`); thời gian `timestamp with time zone`; metadata mở rộng bằng `jsonb`.

---

## 5. Cơ chế thực thi agent

- Mô hình: agent không chạy liên tục; chạy theo "heartbeat" (`docs/agents-runtime.md`): wakeup -> khởi động adapter -> đưa context/prompt -> chạy đến khi thoát/timeout/huỷ -> lưu kết quả, usage, lỗi, log -> cập nhật UI realtime. Nguồn wakeup: `timer` (`intervalSec`), `assignment`, `on_demand`, `automation`; wakeup trùng được gộp (`coalescedCount`). Control plane không tự chạy agent, chỉ điều phối (`doc/GOAL.md`).
- Dịch vụ lõi: `server/src/services/heartbeat.ts` + thư mục `server/src/services/heartbeat/`; ranh giới trách nhiệm trong `rules/heartbeat-execution-boundaries.mdc`. Ngữ nghĩa thực thi/status: `doc/execution-semantics.md`.
- Trạng thái run (`HEARTBEAT_RUN_STATUSES`, `packages/shared/src/constants.ts`): `queued | scheduled_retry | running | succeeded | interrupted | failed | cancelled | timed_out`. Agent status: `active | paused | idle | running | error | pending_approval | terminated`.
- Định nghĩa adapter: giao diện `ServerAdapterModule` (`packages/adapter-utils/src/types.ts` ~dòng 504): `type`, `execute(ctx)`, `testEnvironment(ctx)`, tuỳ chọn `models/listModels`, `sessionCodec`, `listSkills/syncSkills`, `onHireApproved`, `getQuotaWindows`... Hướng dẫn: `docs/adapters/creating-an-adapter.md`, bất biến "no remote git" trong `packages/adapters/AUTHORING.md`. Đăng ký ở `server/src/adapters/registry.ts`.
- Adapter built-in (`server/src/adapters/builtin-adapter-types.ts`): `acpx_local`, `claude_local`, `codex_local`, `paperclip_runner`, `cursor_cloud`, `cursor`, `gemini_local`, `grok_local`, `hermes_gateway`, `hermes_local`, `kimi_local`, `openclaw_gateway`, `opencode_local`, `pi_local`, `process`, `http`. Adapter ngoài (plugin) tải động qua `server/src/adapters/plugin-loader.ts` và `adapter-plugin-store.ts`, không được ghi đè built-in. Ví dụ adapter ngoài trong docs: `droid_local`.
- Claude Code: có (`packages/adapters/claude-local`, adapter `claude_local`, chạy CLI `claude` cục bộ đã đăng nhập; có nhánh ACP `acp.ts`). Xem `docs/adapters/claude-local.md`.
- OpenAI-compatible / vLLM: KHÔNG có adapter chuyên biệt (kiểm tra danh sách trên; grep `vllm` không có kết quả). Các đường khả thi: (a) `opencode_local` hỗ trợ provider `@ai-sdk/openai-compatible` với `baseURL` tuỳ chỉnh (`packages/adapters/opencode-local/src/server/runtime-config.ts`, test `runtime-config.test.ts`); (b) `pi_local` có tuỳ chọn `baseUrl` (thấy trong `execute.remote.test.ts`, chưa đọc kỹ cấu hình); (c) adapter `http` (gọi endpoint ngoài, `docs/adapters/http.md`); (d) viết adapter ngoài mới. Mức phù hợp của (a)/(b) với vLLM tự host (tool-calling, đặc thù model): chưa xác nhận.
- `paperclip_runner` (`packages/paperclip-runner`): runner native với các provider (ví dụ OpenAI Dot, `doc/openai-dot-runner.md`, cờ experimental); không rõ có dùng được cho endpoint OpenAI-compatible tuỳ ý (chưa xác nhận).
- Phiên (session) được lưu để heartbeat sau resume (`agent_task_sessions`, `agent_runtime_state`).

---

## 6. API, xác thực, cô lập đa công ty

- Base path `/api`. Routes ở `server/src/routes/*` (agents, issues, approvals, costs, activity, projects, goals, routines, plugins, companies, pipelines, cases, secrets, ...). OpenAPI: `server/src/routes/openapi.ts`. Tài liệu: `docs/api/*`.
- Hai chế độ triển khai (`doc/DEPLOYMENT-MODES.md`): `local_trusted` (không đăng nhập, mọi request là board local) và `authenticated` (với `private`/`public`).
- Loại actor (`server/src/middleware/auth.ts`, trường `source`): `local_implicit`, `session` (cookie better-auth), `board_key`, `agent_jwt`, `agent_key` (API key băm trong `agent_api_keys`), và các nguồn `cloud_tenant*` (dành cho Paperclip Cloud).
- Board = người điều hành, "full-control operator context" (AGENTS.md mục 8) nhưng bị giới hạn theo membership: `assertCompanyAccess` (`server/src/routes/authz.ts`) từ chối agent khác company, kiểm `companyIds` của board user, và chặn ghi cho role `viewer`. Hàm `getAccessibleResource`/`hasCompanyAccess` trả 404 thay vì 403 để không lộ sự tồn tại tài nguyên giữa các tenant.
- Agent JWT ngắn hạn theo run cấp trong heartbeat (`PAPERCLIP_API_KEY`), giới hạn theo agent + run (`docs/api/authentication.md`); API key dài hạn qua `POST /api/agents/{agentId}/keys`.
- Đăng nhập người dùng: better-auth, `emailAndPassword` (`requireEmailVerification: false`) trong `server/src/auth/better-auth.ts`. Không tìm thấy cấu hình SSO/OIDC/SAML cho người dùng nội bộ (grep `oidc|saml|socialProviders|genericOAuth` chỉ ra các file liên quan connector/tool OAuth, không phải đăng nhập). Kết luận: SSO/OIDC người dùng không có sẵn, cần thêm plugin better-auth hoặc reverse proxy (chưa xác nhận khả thi, better-auth có hệ plugin).
- Cô lập đa công ty: cưỡng chế ở tầng route/service bằng `companyId` trên mọi entity + `assertCompanyAccess`; không có RLS. Rủi ro cần test kỹ khi thêm route mới (AGENTS.md mục 5.1, 8).

---

## 7. Cơ chế mở rộng không sửa core

1. Plugin system (`packages/plugins/sdk`, `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`, `PLUGIN_SPEC.md`, `LOCAL_PLUGIN_DEVELOPMENT.md`). Plugin worker + UI. Manifest khai báo capability (`PLUGIN_CAPABILITIES`, `packages/shared/src/constants.ts`): đọc/ghi issue, comment, document, approvals (`approvals.read`, `approvals.respond`), agents (`agents.invoke`, `agents.managed`), `projects.managed`, `routines.managed`, `skills.managed`, `events.subscribe` (`PLUGIN_EVENT_TYPES`: `issue.created`, `issue.comment.created`...), `jobs.schedule`, `webhooks.receive`, `api.routes.register` (mount dưới `/api/plugins/:pluginId/api/*`), `http.outbound`, `agent.tools.register`, `database.namespace.migrate|write` (schema DB riêng), các slot UI (`PLUGIN_UI_SLOT_TYPES`: page, detailTab, dashboardWidget, sidebar, settingsPage...). Cảnh báo trong tài liệu: worker và UI plugin là mã tin cậy, UI chạy same-origin, không sandbox. Plugin đọc được một số bảng core qua `PLUGIN_DATABASE_CORE_READ_TABLES` (companies, projects, goals, agents, issues, issue_comments, heartbeat_runs, cost_events, approvals...). Ví dụ: `packages/plugins/examples/*`, `plugin-llm-wiki`. CLI scaffold: `create-paperclip-plugin`.
2. Adapter plugin ngoài (mục 5).
3. Skills: skill vận hành cho agent ở `skills/`; catalog `packages/skills-catalog`; skill theo company (`company_skills`, policy `company_skill_policies`, `doc/PRODUCT.md` mục "Company Skills and Policy"); plugin có thể quản lý skill (`skills.managed`). `packages/teams-catalog` cho mẫu team.
4. Routines: lịch cron/trigger tạo issue chạy agent (`routines`, `routine_triggers`); pipeline stage tái dùng routine làm automation.
5. Cấu hình: `config.json` + `.env` theo instance (`doc/DEVELOPING.md` "Local Instance Layout"), cờ experimental runtime (`instance_settings`), biến môi trường `PAPERCLIP_*`.
6. MCP: `packages/mcp-server`, public MCP experimental, quản trị truy cập MCP (`doc/MCP-ACCESS-GOVERNANCE.md`).
7. "Hooks": adapter có `onHireApproved`; migration `0354_agent_connection_assignment_hooks.sql` (ý nghĩa chưa đọc, chưa xác nhận). Không thấy cơ chế hook kiểu pre/post-transition cho người dùng cuối ngoài plugin events.

Đường đi khuyến nghị cho DevFlow (không sửa core): cấu hình pipeline + plugin tuỳ biến, nhưng phần lớn logic gate đã có sẵn trong pipeline nên rất ít cần plugin.

---

## 8. Thông báo, email, tìm kiếm, vector

- Email: có, nhưng là kênh cho agent (`server/src/routes/email.ts`, `services/email-channels.ts`, `email-connections.ts`, `agentmail-api.ts`, skill `skills/agentmail`, phụ thuộc AgentMail). Không thấy dịch vụ SMTP gửi thông báo duyệt cho con người (chưa xác nhận hoàn toàn; không có `nodemailer`/`smtp` trong `server/package.json`).
- Thông báo cho người: in-app Inbox (`ui/src/pages/Inbox.tsx`, `issue_inbox_archives`, `server/src/routes/attention.ts`, `sidebar-badges.ts`), hàng đợi duyệt `ReviewQueue` cho pipeline, `DecisionQueuePage.tsx` (experimental `enableDecisions`). Kênh chat: Slack, Telegram, Discord, Teams, GitHub (`server/src/services/chat-channels*`, `@chat-adapter/*`, cờ `enableChatConnectors`). Realtime qua `ws` (`server/src/realtime`).
- Tìm kiếm (`doc/SEARCH.md`): thuần lexical trên PostgreSQL, dùng chung `server/src/services/task-search.ts`; tất cả term phải khớp; tìm trong title/identifier/description/comment/document; chịu lỗi gõ nhẹ ở title; không synonym, không embedding, không stemming. Có chỉ mục `gin_trgm_ops` (pg_trgm) ví dụ trên `cases`. Vector/embedding/pgvector: không có (grep `pgvector|vector(` trong schema/migrations không có kết quả). Muốn semantic search cho DevFlow cần plugin + extension riêng (chưa xác nhận khả thi với embedded Postgres, vì cần cài extension pgvector).
- Bộ nhớ: `packages/plugins/plugin-llm-wiki`, skill `para-memory-files`, `doc/memory-landscape.md` (chưa đọc).

---

## 9. Cơ chế approval / review gate hiện có

Có bốn lớp, nên chọn lớp phù hợp:

1. Pipeline review stage (mục 0.1): gate theo stage, approver cấu hình (`any_human`/user/agent), 3 lối ra (approve/reject/request_changes), lý do bắt buộc, queue duyệt hàng loạt, sự kiện `review_decided` và `transition_suggested` trong `pipeline_case_events`, kiểm tra "latest review approval still current" (`assertLatestReviewApprovalStillCurrent`) trước khi sang `done`.
2. Approval company-level (`approvals`, `server/src/services/approvals.ts`): `APPROVAL_TYPES = hire_agent | approve_ceo_strategy | budget_override_required | request_board_approval`; trạng thái `pending | revision_requested | approved | rejected | cancelled`; liên kết issue qua `issue_approvals`. Agent mới có thể cần board duyệt (`companies.requireBoardApprovalForNewAgents`). Loại approval cố định theo enum, thêm loại mới cần sửa core (chưa xác nhận có cách mở rộng bằng plugin ngoài `approvals.read/respond`).
3. Execution policy theo issue (mục 0.3): review/approval stage, `ISSUE_REVIEW_POLICIES = anyone | not_creator | human_only`.
4. Issue thread interactions: thẻ quyết định trong thread (`suggest_tasks`, `ask_user_questions`, `request_confirmation`, `request_checkbox_confirmation`, `request_item_verdicts`...) với resolver policy `anyone | not_creator | human_only` (`ISSUE_THREAD_INTERACTION_*`, bảng `issue_thread_interactions`).

Ngoài ra: budget hard-stop (`budget_policies.hardStopEnabled`, `server/src/services/budgets.ts`) tự pause agent; `agents.permissions`.

---

## 10. Trạng thái issue và state machine

- Issue (`ISSUE_STATUSES`): `backlog | todo | in_progress | in_review | done | blocked | cancelled`. Mức ưu tiên: `critical | high | medium | low`. `workMode`: `standard | ask | planning | skill_test`. Project: `backlog | planned | in_progress | completed | cancelled`. Không có state machine cấu hình được ở mức issue; chuyển trạng thái do server ràng buộc theo ngữ nghĩa (checkout nguyên tử, lease, review/approval stage, blockers): `doc/execution-semantics.md`, và `doc/architecture/native-status-arbitration.md` (chưa đọc).
- State machine cấu hình được: chỉ có ở Pipelines (mục 0.1): stage tự định nghĩa, `enforceTransitions` + bảng `pipeline_transitions` (graph cạnh cho phép), `autoAdvanceOnChildrenTerminal`, `requireChildrenTerminal`, `requireNoUnresolvedDrift`, blockers giữa case (`pipeline_case_blockers`), version optimistic, lease agent/user.
- Đề xuất ánh xạ (cần thiết kế thêm, chưa triển khai): 1 pipeline `software-request`; stage Intake/Triage/BA Spec/Tech Plan/Dev/QA là `working` xen kẽ các `review` gate (approver `any_human`), `done`, `cancelled`. Tài liệu spec (BA Spec, Tech Plan) lưu bằng `pipeline_case_documents` (có revision, annotation); công việc Dev đi qua issue liên kết (`pipeline_case_issue_links` role `work`) để chạy agent, gắn workspace/repo. Phân rã sang case con cho từng feature qua `breakdown`.

---

## 11. i18n UI và khả năng tiếng Việt

- Hạ tầng: i18next + react-i18next (`ui/src/i18n/index.ts`), file locale tự nạp bằng `import.meta.glob("./locales/*.json")` (`ui/src/i18n/locales.ts`), có validator (`locale-validation.ts`). Có sẵn 40+ locale trong `ui/src/i18n/locales/` gồm `vi.json`, `en.json`, `zh-CN`, `ja`, `ko`, ...
- Thực trạng: gần như chưa i18n. `vi.json` và `en.json` mỗi file chỉ có 5 key (`app.noCompanies.*`, "Tạo công ty đầu tiên của bạn", ...) và chỉ `ui/src/App.tsx` dùng `useTranslation`. Hàng trăm chuỗi trong ~80+ trang (`ui/src/pages/*.tsx`) và `ui/src/components` là chuỗi tiếng Anh viết cứng.
- Kết luận: về hạ tầng, tiếng Việt khả thi (thêm key vào `vi.json`, đổi `lng`; chưa thấy UI chọn ngôn ngữ, chưa xác nhận); về nội dung, cần trích xuất toàn bộ chuỗi ra key, khối lượng lớn và dễ xung đột khi merge upstream. Với phạm vi DevFlow, chỉ cần địa phương hoá các màn hình mình dùng (Pipelines, ReviewQueue, CaseDetail, Inbox, Approvals), có thể làm theo từng trang. Giữ nguyên tiếng Anh cho phần ẩn.
- Lưu ý prompt agent/skill (`skills/`, template adapter) là tiếng Anh; nội dung spec do agent sinh ra có thể ép tiếng Việt qua instructions của agent/stage (`whatHappensHere`, `instructionsBody`), chưa xác nhận chất lượng.

---

## 12. Khái niệm Paperclip: giữ / ẩn / bỏ cho sản phẩm dev-workflow nội bộ

Nguyên tắc: không xoá code trong core (tránh xung đột khi đồng bộ upstream, và nhiều bất biến liên quan); ưu tiên ẩn bằng cờ experimental/nav/cấu hình và seed dữ liệu. Chỉ "bỏ" khi có tác dụng phụ rõ ràng.

| Khái niệm | Đề xuất | Lý do |
|---|---|---|
| Company (multi-tenant) | GIỮ | Đúng yêu cầu multi-company; là đơn vị cô lập, budget, membership, issue prefix |
| Pipelines + cases + review queue | GIỮ (lõi) | Chính là workflow + gate của DevFlow; cần bật `enablePipelines` |
| Issues, comments, documents, attachments, work products | GIỮ | Nơi agent làm việc và để lại bằng chứng; spec/plan lưu dạng document |
| Agents, adapters, heartbeat, runs, wakeups | GIỮ | Cơ chế chạy AI; heartbeat là đơn vị thực thi, nhưng ẩn khái niệm "heartbeat/interval" khỏi người dùng nghiệp vụ, chỉ để wake theo assignment/stage |
| Approvals, execution policy, interactions | GIỮ có chọn lọc | Dùng pipeline review làm gate chính; approvals company-level cho hire agent/budget |
| Projects, workspaces, execution workspaces | GIỮ | Cần repo/worktree cho giai đoạn Dev/QA |
| Costs, budgets, hard-stop | GIỮ | Kiểm soát chi phí LLM; hữu ích khi tự host nhiều agent |
| Activity log | GIỮ | Audit; bất biến "mọi mutation phải log" |
| Secrets, connections (Apps), MCP | GIỮ khi cần tích hợp (Git, Jira...) | Cấp token cho agent an toàn |
| Plugins, skills, routines | GIỮ | Điểm mở rộng không sửa core |
| Org chart, `reportsTo`, CEO/hire flow, `approve_ceo_strategy` | ẨN | Là ẩn dụ "công ty AI tự trị"; dev-workflow chỉ cần danh sách agent theo vai trò (Triage, BA, Tech, Dev, QA). `reportsTo` là cột có sẵn, có thể để trống (chưa xác nhận hệ quả ràng buộc trong onboarding) |
| Goals / mission (`goals`, `GoalDetail`) | ẨN (cờ `enableGoalsSidebarLink` đã mặc định `false`) | Mục tiêu công ty không phải khái niệm của vòng đời yêu cầu; vẫn tồn tại FK `issues.goalId` nên không xoá |
| Onboarding "tạo CEO agent", first task, built-in agents, announcements | ẨN/thay bằng seed riêng | Thay bằng seed pipeline + agent theo vai trò |
| Agent chat, conference room, voice, Muse, Grok bot, iMessage, OpenAI Dot, Smoke Lab, Storybook labs | ẨN/để tắt (đều là cờ experimental mặc định `false`) | Không phục vụ workflow; giảm bề mặt tấn công và UI nhiễu |
| Chat connectors (Slack/Teams...) | TUỲ CHỌN | Có ích để thông báo duyệt; bật nếu công ty dùng |
| Paperclip Cloud, telemetry first-party | TẮT/KIỂM TRA | Telemetry mặc định opt-out gửi ra endpoint Paperclip (AGENTS.md mục 5.7); nên tắt cho hệ thống nội bộ (cách tắt cụ thể: chưa xác nhận, xem `packages/shared/src/telemetry/README.md`) |
| Company export/import, teams catalog, skills catalog | TUỲ | Hữu ích để nhân bản cấu hình pipeline giữa company (chưa xác nhận pipeline có nằm trong export) |
| Feedback data sharing (`companies.feedbackDataSharing*`) | TẮT | Dữ liệu nội bộ |

---

## Chưa chắc / cần xác nhận

1. Mức độ ổn định/production-ready của Pipelines (đang là experimental, cờ `enablePipelines`); cần chạy `pnpm smoke:pipelines-tutorial` và `docs/pipelines-tutorial.md` (của Paperclip) trên instance dev để xác nhận. Chưa đọc hết `server/src/services/pipelines.ts` (~5200 dòng) và `routes/pipelines.ts` (~2800 dòng).
2. Quan hệ giữa `cases` (`enableCases`) và `pipeline_cases`; chưa xác định liệu `cases` có phải phiên bản trước/song song.
3. Agent có tạo/ingest case và đề xuất chuyển stage được bằng agent key hay chỉ qua run JWT, và quyền chi tiết của agent trên pipeline (chỉ thấy `actorForMutation`, `assertCaseAccess`; chưa kiểm tra phân quyền agent theo từng route).
4. Chạy trên Windows (script bash `rm -rf`, `cp -R`, `.sh`); chưa chạy thử `pnpm install`/`pnpm dev`/`pnpm test` ở đây.
5. Embedded Postgres vs PGlite: `AGENTS.md` mâu thuẫn với `doc/DEVELOPING.md`/`DATABASE.md`; code còn dấu vết `pglite`.
6. Adapter cho OpenAI-compatible/vLLM: chưa kiểm chứng `opencode_local` (provider `@ai-sdk/openai-compatible`) và `pi_local` (`baseUrl`) hoạt động với vLLM thực, cũng như yêu cầu tool-calling. Chưa rõ vai trò các gói `@ai-sdk/*` trong `server/package.json` (có thể cho tính năng LLM phía server như tóm tắt/đặt tên).
7. SSO/OIDC người dùng: không thấy; cần xác nhận khả năng thêm plugin better-auth, hoặc dùng header/proxy; chưa xem `server/src/routes/auth.ts` và `middleware/auth.ts` toàn bộ.
8. Thông báo email cho người duyệt: không thấy SMTP; cần xác nhận có đường ra khác (chat connectors, plugin) hay phải tự xây (plugin với `http.outbound` hoặc `events.subscribe`).
9. Embedding/vector search: không có sẵn; chưa xác nhận embedded Postgres cho cài pgvector.
10. Khả năng thêm loại `approval` mới hoặc hook pre/post-transition bằng plugin mà không sửa core; `0354_agent_connection_assignment_hooks.sql` chưa đọc.
11. i18n: chưa thấy bộ chọn ngôn ngữ trong UI, chưa kiểm tra `ui/src/i18n/locale-validation.ts` có ràng buộc đủ key; ước lượng số chuỗi cứng chưa đếm.
12. Tắt telemetry/Cloud connector cho bản nội bộ, và pipeline có đi theo export/import company hay không.
13. Chưa đọc đầy đủ `doc/SPEC-implementation.md` (152 KB) và `doc/DEVELOPING.md` (181 KB); các mục chỉ dựa trên phần đã đọc và đối chiếu code. `doc/architecture/native-status-arbitration.md`, `doc/memory-landscape.md`, `doc/AGENT-LIFECYCLE.md` chưa đọc.
14. Tính nhất quán số liệu "354 migration": dựa trên `ls | wc -l` (gồm cả thư mục `meta`), có thể lệch 1 so với số file SQL.
