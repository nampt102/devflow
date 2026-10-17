# 0003. Dùng Pipelines của Paperclip làm lõi workflow (D1)

- **Ngày:** 2026-10-17
- **Trạng thái:** đã chốt (xác nhận lại sau spike bước 1)
- **Người quyết định:** chủ dự án (Technical Lead)

## Bối cảnh
Paperclip có Pipelines (pipelines, pipeline_stages, pipeline_transitions, pipeline_cases, pipeline_case_events...) gần giống Workflow Core: stage review có approver và 3 lối ra, agent chỉ đề xuất qua pendingSuggestion. Tính năng đang experimental (enablePipelines mặc định false).

## Quyết định
Dùng Pipelines, vá nếu cần; không tạo state machine thứ hai. Một yêu cầu là một pipeline_case trong pipeline dev-request.

## Lý do và hệ quả
Nhanh nhất, tận dụng gate sẵn có. Rủi ro: experimental, phải vá lõi. Spike ở plan bước 1 sẽ xác nhận (approver theo role, quyền agent key, audit field-level).
