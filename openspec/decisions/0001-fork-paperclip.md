# 0001. Fork Paperclip làm lõi

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Cần hệ thống quản lý vòng đời yêu cầu phần mềm, agent đề xuất, người duyệt, multi-company, audit và chi phí token.

## Quyết định
Fork Paperclip (https://github.com/paperclipai/paperclip, MIT). Giữ stack Node.js + TypeScript (pnpm monorepo, Express 5, React 19 + Vite, Drizzle/PostgreSQL). Giữ nguyên LICENSE và copyright gốc (MIT, © 2025 Paperclip AI). Mục tiêu sở hữu source lâu dài; không bám upstream.

## Lý do và hệ quả
Paperclip có sẵn điều phối agent, approval gate, audit log, theo dõi chi phí, cách ly multi-company. Không đổi framework nếu không có lý do mạnh.
