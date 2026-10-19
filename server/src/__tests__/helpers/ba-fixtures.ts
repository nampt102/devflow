// A valid BA agent answer, shared by the BA tests.
export const VALID_BA_OUTPUT = {
  summary: "Cho phép người yêu cầu thấy ai đang xử lý yêu cầu của mình.",
  businessGoal: "Giảm số email hỏi lại tiến độ.",
  inScope: ["Hiển thị tên người xử lý trên cổng"],
  outOfScope: ["Gửi tin nhắn trực tiếp cho nhân viên"],
  userStories: [{ asA: "người yêu cầu", iWant: "biết ai đang xử lý", soThat: "tôi biết hỏi ai" }],
  acceptanceCriteria: ["Trang chi tiết yêu cầu hiện tên người xử lý khi đã có"],
  affectedAreas: [{ system: "portal", path: "server/src/devflow/portal/portal-service.ts", line: 17, why: "DTO của requester không có trường này" }],
  dataChanges: [],
  risks: ["Lộ tên nhân viên cho bên ngoài"],
  openQuestions: ["Có hiển thị cho mọi trạng thái không?"],
  confidence: "medium",
};
