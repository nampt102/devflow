# Pipeline `dev-request` (seed)

Định nghĩa: `server/src/devflow/dev-request-pipeline.json` (12 stage, 20 transition, `enforceTransitions: true`). Không đổi schema: chỉ là dữ liệu cấu hình cho Pipelines của Paperclip (ADR 0003).

| position | key | kind | exit |
|---|---|---|---|
| 100/150 | `triage` → `triage_review` | working → review | approve → `ba_spec`; request_changes → `triage`; reject → `cancelled` |
| 200/250 | `ba_spec` → `ba_review` | working → review | approve → `tech_plan` |
| 300/350 | `tech_plan` → `plan_review` | working → review | approve → `dev` |
| 400/450 | `dev` → `code_review` | working → review | approve → `qa` |
| 500/550 | `qa` → `qa_signoff` | working → review | approve → `done` |
| 900 / 1000 | `done` / `cancelled` | terminal | |

Quy tắc đã kiểm chứng: lối ra duy nhất của stage working là sang stage review của nó (không nhảy cách); review chỉ có 3 lối ra approve/reject/request_changes; reject và request_changes bắt buộc có lý do; approver là `any_human` (không bao giờ là agent); `done` chỉ vào được từ `qa_signoff`.

## Chạy
- Test định nghĩa (không cần DB): `pnpm --filter @paperclipai/server exec vitest run src/__tests__/devflow-dev-request-pipeline.test.ts`. Trên máy này chưa cài node_modules ở host; chạy trong image: xem `kb/tech-stack.md`. Đã kiểm tra 8/8 pass và 2 đột biến (agent approver, lối tắt `dev → done`) bị bắt.
- Seed + kiểm tra cổng trên instance đang chạy: `node scripts/devflow/setup-dev-request-pipeline.mjs --company <id> --verify` (cần `DEVFLOW_TEST_ADMIN_EMAIL/PASSWORD`, đọc từ env). Idempotent. 7/7 kiểm tra pass (xem log trong `status.md`).

## Chưa được kiểm chứng / còn hạn chế
- Approver theo **vai** (BA, Tech Lead): đã có từ 2026-10-21 (change `add-approver-roles`, ADR 0023). `triage_review` và `ba_review` cần `ba` hoặc `tech_lead`; `plan_review` và `code_review` (từ 2026-10-22, change `add-dev-stage`) cần `tech_lead`. Owner của công ty và instance admin luôn duyệt được. Công ty đã seed phải chạy lại `setup-dev-request-pipeline.mjs` để đổi `approver` (chỉ trường đó; `--any-human` để hoàn tác). Gán vai: màn hình `/roles` hoặc `scripts/devflow/set-member-roles.mjs`.
- "Agent không thể duyệt" mới kiểm chứng ở cấu hình và test sẵn có của Paperclip (`pipelines-routes.test.ts:938`), chưa thử runtime với agent key.
- `API /api/cases/:id/events` trả `{ items: [...] }`; kiểu event quan sát được: `ingested`, `transitioned`, `review_decided`. Chưa có diff field-level (bản vá M).
- `case_key` vẫn là UUID, chưa có `REQ-n`.
