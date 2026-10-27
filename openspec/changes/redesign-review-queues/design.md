## Context

Năm trang duyệt có cùng khung: hàng chờ (`queue`), chi tiết (`detail`), quyết định (`decision` với `outputId`, `expectedVersion`), số liệu (`metrics`), nhãn New theo `seenAt` trong localStorage, `accessBlocker` cho vai. Mỗi trang tự viết lại khung này (`lg:grid-cols-3`, `onDecided={() => setSelectedId(null)}` đưa về mục đầu). `DESIGN.md`: token là nguồn duy nhất, một component cho một việc, footer phụ trái/chính phải, trạng thái có hệ thống, giá trị máy dùng font mono. Đánh giá theo ui-ux-pro-max (ưu tiên 1–9: a11y, tương tác, bố cục, màu, form, điều hướng).

## Decisions

**D1. Một khung, năm cấu hình.** `ReviewWorkspace<TItem, TDetail>` nhận: `title`, `api` (queue/detail/decide/metrics), `itemLine(item)` (một dòng trạng thái), `sections(detail)` (danh sách `{ id, label, count?, render }`), `blocker(decision, reason, detail)`, `decisionCopy`. Không component nào mới ngoài khung (Badge, Button, Textarea, Dialog có sẵn). Lý do: hết lệch giữa năm trang; sửa một chỗ.

**D2. Thanh quyết định ghim** (`sticky bottom-0` trong vùng chi tiết cuộn riêng). Phụ trái, chính phải. Lý do mở bằng progressive disclosure; Reject mở `Dialog` xác nhận ghi rõ hậu quả (đóng PR, hủy yêu cầu). Approve không bị chặn bởi khuyến nghị (giữ nguyên quy tắc hiện có).

**D3. Tự sang mục kế tiếp** = mục ngay sau mục vừa quyết trong danh sách hiện tại (theo sắp xếp đang chọn); hết thì mục trước; trống thì trạng thái rỗng có hướng dẫn.

**D4. Phím tắt** qua một hook `useReviewHotkeys`, bỏ qua khi focus ở `input/textarea/[contenteditable]`, có `?` mở bảng; nút hiện gợi ý phím. Không dùng phím đơn khi bảng hoặc hộp thoại đang mở.

**D5. Link sâu** bằng query `?case=<caseKey>` (đồng bộ hai chiều với mục đang chọn, `replace` để không làm đầy lịch sử). Email nhắc nhân viên dùng link này.

**D6. Màu theo ý nghĩa** dùng token trạng thái hiện có (không thêm hex): khuyến nghị approve = trung tính + ✓; changes = nền cảnh báo nhạt + ↺; chặn (lệnh lỗi, high issue, diff bị chặn, thiếu PR) = destructive + ⚠. Một dòng trạng thái ở thẻ hàng chờ lấy mức nặng nhất.

**D7. Vòng trước.** Nếu yêu cầu có đề xuất `superseded` cùng stage kèm quyết định request_changes, chi tiết hiện khối "Since last round": lý do, và với trường có cấu trúc (ưu tiên, phân loại, tiêu chí, task) là cũ → mới. Nếu API chi tiết chưa trả dữ liệu vòng trước, thêm trường `previousRound` (chỉ đọc) vào năm endpoint chi tiết; đây là thay đổi API nhỏ, ghi ở tasks.

**D8. Màn hình hẹp** (< 1024px): danh sách và chi tiết là hai màn, chi tiết có nút Back giữ vị trí cuộn của danh sách.

**D9. Làm từng trang.** Khung trước, chuyển QA (mới nhất, ít nợ) làm mẫu, rồi Code, Plan, BA, Triage (nhiều trường sửa nhất). Mỗi trang một commit, test UI giữ nguyên hành vi quyết định.

## Risks / Trade-offs

- Viết lại năm trang có thể làm sót hành vi riêng (Triage sửa trường, chọn bản trùng, chọn hệ thống). Giảm bằng: giữ helper `lib/*-review.ts` và test của chúng, thêm test cho khung (sang mục kế, phím tắt, link sâu, xác nhận Reject).
- Phím một chữ dễ bấm nhầm: Reject luôn qua hộp xác nhận; Request changes cần lý do nên không gửi ngay.

## Open Questions (mặc định nếu duyệt không trả lời)
1. Phím tắt một chữ? Mặc định **có**, tắt được ở bảng `?`.
2. Reject cần xác nhận? Mặc định **có**.
3. Thêm `previousRound` vào API chi tiết nếu thiếu? Mặc định **có** (chỉ đọc).
