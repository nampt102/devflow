# Tech stack và cách chạy

Nguồn: tài liệu Paperclip (`doc/DEVELOPING.md`, `doc/DATABASE.md`, `AGENTS.md`) và `openspec/kb/paperclip-architecture.md`. **Chưa chạy thử trên máy này** (chưa xác nhận).

- Node ≥ 24.11 (bản Paperclip yêu cầu; kiểm tra lại ở bước 0), pnpm monorepo.
- Server: Express 5. UI: React 19 + Vite + Tailwind 4. DB: PostgreSQL + Drizzle. Auth: better-auth.
- DevFlow dev bằng **Docker**, Postgres có extension `vector` (ADR 0009, 0005).

```
pnpm install
pnpm dev                 # server + UI; không có DATABASE_URL thì dùng DB nhúng của Paperclip
pnpm test                # Vitest, mặc định rẻ
pnpm -r typecheck
pnpm build
pnpm db:generate         # sinh migration từ schema Drizzle (packages/db)
pnpm db:migrate
```

Kiểm tra đầy đủ trước bàn giao PR: `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`. Script build dùng lệnh kiểu Unix (Git Bash/WSL/Docker).
Bật Pipelines bằng cờ `enablePipelines` (mặc định tắt).
Lưu ý: `AGENTS.md` mô tả PGlite cho dev, `doc/DATABASE.md` mô tả khác; DevFlow dùng Docker Postgres (ADR 0009).
