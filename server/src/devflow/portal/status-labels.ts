// Vietnamese status labels shown to requesters (openspec/changes/add-intake-portal, "Status visibility").
// Single source: the client never derives a label from a raw stage key.
export const DEV_REQUEST_PIPELINE_KEY = "dev-request";

const STAGE_LABELS_VI: Record<string, string> = {
  triage: "Đã tiếp nhận",
  triage_review: "Đang chờ duyệt phân loại",
  ba_spec: "Đang phân tích nghiệp vụ",
  ba_review: "Đang chờ duyệt phân tích",
  tech_plan: "Đang lập kế hoạch kỹ thuật",
  plan_review: "Đang chờ duyệt kế hoạch",
  dev: "Đang phát triển",
  code_review: "Đang kiểm tra mã nguồn",
  qa: "Đang kiểm thử",
  qa_signoff: "Đang chờ xác nhận kiểm thử",
  done: "Hoàn thành",
  cancelled: "Không tiếp tục xử lý",
};

export function statusLabelVi(stageKey: string | null | undefined): string {
  return (stageKey && STAGE_LABELS_VI[stageKey]) || "Đang xử lý";
}
