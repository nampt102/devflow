// A Tech Plan answer that passes the schema, for tests (openspec/changes/add-tech-plan-stage).
export const VALID_PLAN_OUTPUT = {
  summary: "Thêm tên người xử lý vào màn hình trạng thái của requester, lấy từ người được giao ở bước duyệt.",
  approach: "Mở rộng DTO của portal bằng trường assigneeName, đọc từ bảng pipeline_cases; không thêm bảng mới.",
  tasks: [
    {
      id: "T1",
      title: "Thêm assigneeName vào DTO của requester",
      system: "portal",
      description: "Đọc tên người xử lý trong portal-service và trả về cùng trạng thái.",
      size: "S",
      files: [{ path: "server/src/devflow/portal/portal-service.ts", line: 17, change: "thêm trường assigneeName vào DTO" }],
      dependsOn: [],
    },
    {
      id: "T2",
      title: "Hiện tên người xử lý trên trang yêu cầu",
      system: "portal",
      description: "Thêm một dòng trên trang chi tiết yêu cầu của portal.",
      size: "M",
      files: [{ path: "portal/src/pages/RequestDetail.tsx", line: null, change: "hiện assigneeName" }],
      dependsOn: ["T1"],
    },
  ],
  dataChanges: [],
  apiChanges: ["GET /api/portal/requests/:id trả thêm assigneeName"],
  testPlan: ["Test portal-service trả assigneeName khi có người xử lý và null khi chưa có"],
  risks: [],
  openQuestions: ["Có hiện tên đầy đủ hay chỉ tên gọi?"],
  confidence: "medium",
};

/** An approved BA spec as BA review stores it in `data.approved`. */
export const APPROVED_BA_SPEC = {
  summary: "Requester thấy ai đang xử lý yêu cầu.",
  businessGoal: "Giảm email hỏi lại.",
  inScope: ["Hiện tên người xử lý"],
  outOfScope: [],
  userStories: [{ asA: "người yêu cầu", iWant: "biết ai đang xử lý", soThat: "tôi biết hỏi ai" }],
  acceptanceCriteria: ["Trang yêu cầu hiện tên người xử lý (đã sửa bởi người duyệt)"],
  affectedAreas: [{ system: "portal", path: "server/src/devflow/portal/portal-service.ts", line: 17, why: "DTO của requester" }],
  dataChanges: [],
  risks: [],
  openQuestions: [],
  confidence: "medium",
};
