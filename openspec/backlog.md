# Backlog cải tiến DevFlow

Nơi duy nhất ghi các vấn đề nhỏ, lỗi và cải tiến chưa làm. Quy ước: chủ dự án báo trong chat (có thể kèm ảnh); Claude ghi vào đây với mã số, nguồn và mức ưu tiên đề xuất, rồi hỏi duyệt trước khi code nếu đổi hành vi, schema hoặc dependency. Khi xong thì đánh dấu `done` kèm commit. Việc lớn (BA Spec, Dev, QA) là P2/P3 trong `status.md`, không ghi ở đây. Cập nhật lần cuối: 2026-10-18.

Mức ưu tiên: **A** cần trước pilot, **B** nên làm sớm trong pilot, **C** khi có dữ liệu hoặc nhu cầu.

## Màn hình duyệt (nhân viên)
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| B-01 | **Không có thông báo khi có yêu cầu mới chờ duyệt**; phải vào trang và cuộn. Đề xuất: số đếm ở sidebar, nhãn "New" + đổi thứ tự, email cho nhân viên (gom 5 phút, danh sách `DEVFLOW_STAFF_NOTIFY_EMAILS`) | A | chủ dự án, 2026-10-18. **Đã chọn làm cả 3 (sidebar + nhãn New/sắp xếp + email gom 5 phút); chưa làm, chờ chủ dự án rà soát xong rồi mới code.** Chưa chốt: người nhận email ban đầu (đề xuất hai hộp thư test) |
| B-02 | Hàng chờ xếp cũ nhất trước nên yêu cầu mới ở cuối; chưa có tìm kiếm trong hàng chờ | B | thấy khi dùng |
| B-03 | Dưới 1024px hàng chờ xếp trên chi tiết, phải cuộn | C | `kb/triage-review.md` |
| B-04 | Chọn bản trùng chỉ trong danh sách ứng viên, chưa nhập mã REQ bất kỳ | B | `kb/triage-review.md` |
| C-05 | Chưa có snooze, duyệt hàng loạt, claim/lease (hai người có thể cùng mở một yêu cầu; người thứ hai bị 409 khi quyết định) | C | `kb/triage-review.md` |
| B-06 | Role BA/Tech Lead cho người duyệt (hiện mọi board user không phải viewer duyệt được) | B | `kb/spike-pipelines.md` |
| C-07 | Requester chỉ thấy "Không tiếp tục xử lý" cho cả reject lẫn trùng | C | `kb/triage-review.md` |
| B-08 | Agent "DevFlow Triage" hiện trong danh sách Agents với nút Test báo "Couldn't connect" (gây hiểu nhầm; đó là dòng giữ chỗ để ghi chi phí). Gắn nhãn hoặc ẩn | B | chủ dự án, 2026-10-18 |
| B-09 | Portal và Board dùng chung phiên đăng nhập trên `localhost:3100`: đăng nhập requester làm mất phiên admin (và chia sẻ khóa giao diện sáng/tối, việc này là chủ ý). Chỉ dẫn dùng cửa sổ ẩn danh; xem xét tách cookie hoặc cổng | B | chủ dự án, 2026-10-18 |
| C-10 | UI chưa có test render component (chỉ test logic thuần); `pnpm check:token-gates` đã báo vi phạm từ trước ở trang khác | C | `kb/triage-review.md` |

## Portal và tài khoản
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| A-11 | Chưa có màn hình cho nhân viên tạo link mời requester và tạo tài khoản (chỉ có API) | A | `kb/admin-accounts.md` |
| B-12 | Chưa có đổi mật khẩu, buộc đổi mật khẩu lần đầu, và email gửi thông tin tài khoản | B | `kb/admin-accounts.md` |
| A-13 | Đăng ký công khai đang mở; luồng bootstrap admin và mời thành viên board khi đóng chưa kiểm chứng | A | `kb/runbook.md` mục 8 |

## Triage agent và dedupe
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| A-14 | Định nghĩa mức ưu tiên và độ khó là bản TEMPORARY; cần định nghĩa của công ty (prompt v4) | A | `kb/triage-agent.md` |
| B-15 | Model hay chọn `medium`; yêu cầu không phải phát triển (ví dụ hỏi giờ làm việc IT) vẫn được phân loại; schema chưa có "ngoài phạm vi" | B | lần chạy thật đầu |
| C-16 | `requiresHuman=true` đôi khi không kèm lý do | C | lần chạy thật đầu |
| B-17 | Trung bình ~945 token ra cho JSON ngắn; chưa rõ model có "suy nghĩ" không | B | lần chạy thật đầu |
| B-18 | Trạng thái bỏ cuộc và breaker nằm trong bộ nhớ (khởi động lại mới thử lại); cân nhắc lưu xuống DB hoặc nút "thử lại" | B | `kb/triage-agent.md` |
| A-19 | Ngưỡng dedupe 0.3 (trigram) và 0.65 (vector) chưa hiệu chỉnh; cần ~20 yêu cầu mẫu thật và cặp trùng | A | `kb/triage-agent.md` |
| C-20 | Chưa đọc nội dung tệp đính kèm; chưa có chỉ mục GIN/HNSW; chưa thử vLLM/TEI và Qwen (thinking) thật | C | `kb/triage-agent.md` |
| C-21 | Chi phí `unpriced`: chưa có bảng giá nên ngân sách tiền của Paperclip không áp dụng (đã có trần token) | C | ADR 0019 |

## Email
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| B-22 | Lần bật email đầu trên instance có dữ liệu cũ sẽ gửi thư lịch sử (đã xảy ra, 10 thư tới địa chỉ giả). Làm an toàn mặc định: lần chạy đầu tự đánh dấu bỏ qua sự kiện cũ | B | sự cố 2026-10-18 |
| C-23 | Chưa có giới hạn tần suất theo người nhận, xử lý thư bị trả lại, mẫu HTML, hủy đăng ký; "sent" chỉ là SMTP chấp nhận, chưa kiểm hộp thư nhận | C | `kb/email-notifications.md` |

## Vận hành và pháp lý
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| A-24 | Xác nhận vị trí và chu kỳ sao lưu tự động của Paperclip; sao lưu thư mục tệp đính kèm | A | `kb/runbook.md` mục 6 |
| A-25 | Đánh giá AGPL (phần port từ Plane) trước khi triển khai ngoài thử nghiệm | A | ADR 0002 |
| B-26 | Chưa có CI chạy test DevFlow (hiện chạy tay trong container); build image thủ công (`git archive` + `docker build`) | B | `kb/tech-stack.md` |
| B-27 | Core `pipelines.ts` có thêm 4 dòng (hook `beforeCommit`), `app.ts` và `index.ts` có thêm mount worker/route: ghi nhớ khi gộp bản Paperclip mới | C | ADR 0017 |
| C-28 | Chưa quan sát lưu lượng ra ngoài để xác nhận Telemetry đã tắt | C | ADR 0019 |
| B-29 | Quét bí mật lịch sử upstream của Paperclip chưa làm; kho `nampt102/devflow` công khai | C | `kb/runbook.md` mục 11 |

## Đã xong gần đây
- Portal làm lại giao diện: đồng nhất token với Board, có chuyển sáng/tối dùng chung khóa `paperclip.theme` (xem `kb/intake-portal-web.md`).
- LLM max output tokens 1500 gây `truncated` → 4000 (commit `751f2f07b`).
- Quy tắc cờ nhầm "sập"/SAP, "lượng"/"lương" (commit `93a8fd34d`).
- Model từ chối `temperature` → tùy chọn (commit `fix(devflow): send temperature only when configured`).

## Giao diện portal (theo dõi)
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| C-30 | Portal chưa kiểm tra bằng trình đọc màn hình và chưa đo tương phản bằng công cụ; chưa có test render component | C | `kb/intake-portal-web.md` |
| C-31 | Staff UI (trang Triage review) vẫn tiếng Anh; phông Inter của portal lấy từ `/fonts/` của Board (nếu tách máy chủ phải đi kèm phông) | C | 2026-10-18 |
