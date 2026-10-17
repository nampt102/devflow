# 0008. LLM cho agent: API thương mại + local, chọn theo config (D6)

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt (adapter chưa xác nhận)
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Cần chạy agent qua API thương mại, endpoint OpenAI-compatible (vLLM self-host) và Claude Code headless cho bước Dev. Paperclip không có adapter OpenAI-compatible/vLLM riêng.

## Quyết định
Hỗ trợ cả API thương mại và model local, chọn theo config. Kiểm chứng ở spike: opencode_local, pi_local, http, hoặc viết adapter plugin.

## Lý do và hệ quả
Chưa xác nhận vLLM chạy qua adapter nào. Cần endpoint và model vLLM khi tới bước 6 (Triage agent).
