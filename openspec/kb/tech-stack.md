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

## Ghi chú môi trường Docker trên Windows (đã gặp khi dựng, 2026-10-17)
- **RAM:** build image Paperclip (`pnpm install`, build server) bị kill (exit 137) khi WSL2 chỉ có 4 GB. Đã nâng `~/.wslconfig` lên `memory=10GB` (giữ `processors=4`; bản sao lưu `.wslconfig.bak`), sau đó `wsl --shutdown` và chờ Docker Desktop khởi động lại. Cần ≥ ~8 GB.
- **CRLF:** Git cài sẵn trên Windows đặt `core.autocrlf=true` làm file như `packages/paperclip-runner/protocol/manifest.json` thành CRLF, khiến kiểm tra "generated PRP contract manifest is stale" của Paperclip lỗi. Repo này đã đặt `core.autocrlf=false` (cục bộ), nhưng file đã checkout vẫn còn CRLF. Cách build đang dùng: `git archive <tree> | docker build -t devflow-paperclip:local -f Dockerfile -` để lấy bản LF từ git, không phụ thuộc working tree.
- **`opencode-ai`:** một lần build gặp lỗi cài `opencode-ai@latest` (EBADPLATFORM libc musl/glibc) trong Dockerfile; lần build sau (không sửa Dockerfile) cài thành công. Coi là lỗi tạm; image cuối có đủ `claude`, `codex`, `opencode`, `gemini`, `kimi`. Dockerfile của DevFlow **không** khác Paperclip.
- **Image upstream:** `ghcr.io/paperclipai/paperclip` trả `denied` (không pull được), nên phải build từ source.
- Có thể gặp lỗi mạng tạm (`EAI_AGAIN`) khi tải gói; thử build lại.

## Chạy stack DevFlow bằng Docker (đã xác nhận 2026-10-17)
```
# build từ git (LF) rồi chạy; compose override dùng image local, Postgres pgvector
git archive HEAD | docker build -t devflow-paperclip:local -f Dockerfile -
cd docker && docker compose -f docker-compose.yml -f docker-compose.devflow.yml up -d
curl http://localhost:3100/api/health
```
- Cần `docker/.env` (gitignore; mẫu `docker/.env.example`): `BETTER_AUTH_SECRET`, `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`.
- Instance mới ở `bootstrap_pending`: đăng ký (`POST /api/auth/sign-up/email`) rồi `POST /api/bootstrap/claim` (hoặc "Claim this instance" trên UI). Tài khoản test cục bộ dùng `DEVFLOW_TEST_ADMIN_EMAIL/PASSWORD` trong `docker/.env`.
- `git archive HEAD` không gồm thay đổi chưa commit; dùng `git archive $(git stash create)` để gồm cả thay đổi.
- Postgres `pgvector/pgvector:pg17` có extension `vector` 0.8.7 (chưa `CREATE EXTENSION`; sẽ làm trong migration).
