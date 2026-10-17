// Vietnamese status-change email. Only the request key, title, the requester-facing status label and a
// link go out: never Triage output, internal stage keys, or other people's data.

const oneLine = (text: string, max: number) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, max);

export function composeStatusEmail(input: {
  requestKey: string;
  requestNumber: number;
  title: string;
  statusLabel: string;
  portalBaseUrl: string;
}): { subject: string; body: string } {
  const title = oneLine(input.title, 120);
  return {
    subject: `[${input.requestKey}] Trạng thái yêu cầu: ${input.statusLabel}`,
    body: [
      "Xin chào,",
      "",
      `Yêu cầu ${input.requestKey} "${title}" của bạn vừa chuyển sang trạng thái: ${input.statusLabel}.`,
      "",
      `Xem chi tiết: ${input.portalBaseUrl}/portal/requests/${input.requestNumber}`,
      "",
      "Đây là thư tự động từ hệ thống DevFlow, vui lòng không trả lời thư này.",
    ].join("\n"),
  };
}
