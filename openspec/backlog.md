# Backlog cải tiến DevFlow

Nơi duy nhất ghi các vấn đề nhỏ, lỗi và cải tiến chưa làm. Quy ước: chủ dự án báo trong chat (có thể kèm ảnh); Claude ghi vào đây với mã số, nguồn và mức ưu tiên đề xuất, rồi hỏi duyệt trước khi code nếu đổi hành vi, schema hoặc dependency. Khi xong thì đánh dấu `done` kèm commit. Việc lớn (BA Spec, Dev, QA) là P2/P3 trong `status.md`, không ghi ở đây. Cập nhật lần cuối: 2026-10-20.

Mức ưu tiên: **A** cần trước pilot, **B** nên làm sớm trong pilot, **C** khi có dữ liệu hoặc nhu cầu.

## Màn hình duyệt (nhân viên)
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| B-01 | **Xong (chờ bạn kiểm tra trên stack)**: số đếm ở sidebar, nhãn New + sắp xếp (mặc định mới nhất trước), email gom 5 phút tới danh sách `DEVFLOW_STAFF_NOTIFY_EMAILS` hoặc owner/admin của công ty. Ghi chú gốc: không có thông báo khi có yêu cầu mới chờ duyệt**; phải vào trang và cuộn. Đề xuất: số đếm ở sidebar, nhãn "New" + đổi thứ tự, email cho nhân viên (gom 5 phút, danh sách `DEVFLOW_STAFF_NOTIFY_EMAILS`) | A | chủ dự án, 2026-10-18. **Đã chọn làm cả 3 (sidebar + nhãn New/sắp xếp + email gom 5 phút); chưa làm, chờ chủ dự án rà soát xong rồi mới code.** Chưa chốt: người nhận email ban đầu (đề xuất hai hộp thư test) |
| B-02 | Hàng chờ xếp cũ nhất trước nên yêu cầu mới ở cuối; chưa có tìm kiếm trong hàng chờ | B | thấy khi dùng |
| B-03 | Dưới 1024px hàng chờ xếp trên chi tiết, phải cuộn | C | `kb/triage-review.md` |
| B-04 | Chọn bản trùng chỉ trong danh sách ứng viên, chưa nhập mã REQ bất kỳ | B | `kb/triage-review.md` |
| C-05 | Chưa có snooze, duyệt hàng loạt, claim/lease (hai người có thể cùng mở một yêu cầu; người thứ hai bị 409 khi quyết định) | C | `kb/triage-review.md` |
| B-06 | Role BA/Tech Lead cho người duyệt (hiện mọi board user không phải viewer duyệt được) | B | `kb/spike-pipelines.md` |
| C-07 | Requester chỉ thấy "Không tiếp tục xử lý" cho cả reject lẫn trùng | C | `kb/triage-review.md` |
| B-08 | **Xong**: agent đổi tên "DevFlow Triage (internal)" và có ghi chú giải thích nút Test báo lỗi là bình thường (agent cũ được đổi tên khi worker chạy) | done | chủ dự án, 2026-10-18 |
| B-09 | Portal và Board dùng chung phiên đăng nhập trên `localhost:3100`: đăng nhập requester làm mất phiên admin (và chia sẻ khóa giao diện sáng/tối, việc này là chủ ý). Chỉ dẫn dùng cửa sổ ẩn danh; xem xét tách cookie hoặc cổng | B | chủ dự án, 2026-10-18 |
| C-10 | UI chưa có test render component (chỉ test logic thuần); `pnpm check:token-gates` đã báo vi phạm từ trước ở trang khác | C | `kb/triage-review.md` |

## Portal và tài khoản
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| A-11 | **Xong (chờ kiểm tra trên stack)**: trang Portal access (link mời requester; tạo tài khoản và reset mật khẩu cho instance admin), xem `kb/admin-accounts.md` | done | `kb/admin-accounts.md` |
| B-12 | Chưa có đổi mật khẩu, buộc đổi mật khẩu lần đầu, và email gửi thông tin tài khoản | B | `kb/admin-accounts.md` |
| A-13 | **Đã kiểm (2026-10-18)**: trên instance trống, đóng đăng ký khiến không tạo được admin đầu tiên; quy trình: bootstrap khi mở rồi mới đóng (runbook mục 8). Còn lại: chủ dự án quyết thời điểm đóng | done (kiểm tra) | `kb/runbook.md` mục 8 |

## Triage agent và dedupe
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| A-14 | Định nghĩa mức ưu tiên và độ khó là bản TEMPORARY trong `server/src/devflow/prompts/triage.v3.ts` (khối `DEFINITIONS`). Chờ chủ dự án đưa định nghĩa của công ty; khi có thì tạo `triage.v4.ts` (xem `kb/triage-agent.md` mục "Đổi prompt") | A | `kb/triage-agent.md` |
| B-15 | Model hay chọn `medium`; yêu cầu không phải phát triển (ví dụ hỏi giờ làm việc IT) vẫn được phân loại; schema chưa có "ngoài phạm vi" | B | lần chạy thật đầu |
| C-16 | `requiresHuman=true` đôi khi không kèm lý do | C | lần chạy thật đầu |
| B-17 | Trung bình ~945 token ra cho JSON ngắn; chưa rõ model có "suy nghĩ" không | B | lần chạy thật đầu |
| B-18 | Trạng thái bỏ cuộc và breaker nằm trong bộ nhớ (khởi động lại mới thử lại); cân nhắc lưu xuống DB hoặc nút "thử lại" | B | `kb/triage-agent.md` |
| A-19 | **Bỏ qua lúc này (chủ dự án, 2026-10-18)**.  Ngưỡng dedupe 0.3 (trigram) và 0.65 (vector) chưa hiệu chỉnh; cần ~20 yêu cầu mẫu thật và cặp trùng | A | `kb/triage-agent.md` |
| C-20 | Chưa đọc nội dung tệp đính kèm; chưa có chỉ mục GIN/HNSW; chưa thử vLLM/TEI và Qwen (thinking) thật | C | `kb/triage-agent.md` |
| C-21 | Chi phí `unpriced`: chưa có bảng giá nên ngân sách tiền của Paperclip không áp dụng (đã có trần token) | C | ADR 0019 |

## Email
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| B-22 | **Xong**: lần chạy email đầu (outbox trống) ghi toàn bộ sự kiện cũ là `skipped` (`before_email_enabled`) thay vì gửi | done | sự cố 2026-10-18 |
| C-23 | Chưa có giới hạn tần suất theo người nhận, xử lý thư bị trả lại, mẫu HTML, hủy đăng ký; "sent" chỉ là SMTP chấp nhận, chưa kiểm hộp thư nhận | C | `kb/email-notifications.md` |

## Vận hành và pháp lý
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| A-24 | **Đã xác nhận (2026-10-18)**: sao lưu mỗi 60 phút, giữ 7 ngày, trong volume `docker_paperclip-data`, khôi phục thử thành công. Còn lại: sao chép ra ngoài máy (cùng ổ đĩa với dữ liệu thật), kể cả tệp đính kèm | done (xác nhận) | `kb/runbook.md` mục 6 |
| A-25 | **Bỏ qua lúc này (chủ dự án, 2026-10-18)**.  Đánh giá AGPL (phần port từ Plane) trước khi triển khai ngoài thử nghiệm | A | ADR 0002 |
| B-26 | Chưa có CI chạy test DevFlow (hiện chạy tay trong container); build image thủ công (`git archive` + `docker build`) | B | `kb/tech-stack.md` |
| B-27 | Core `pipelines.ts` có thêm 4 dòng (hook `beforeCommit`), `app.ts` và `index.ts` có thêm mount worker/route: ghi nhớ khi gộp bản Paperclip mới | C | ADR 0017 |
| C-28 | Chưa quan sát lưu lượng ra ngoài để xác nhận Telemetry đã tắt | C | ADR 0019 |
| B-29 | Quét bí mật lịch sử upstream của Paperclip chưa làm; kho `nampt102/devflow` công khai | C | `kb/runbook.md` mục 11 |

## Đã xong gần đây
- Portal làm lại giao diện: đồng nhất token với Board, có chuyển sáng/tối dùng chung khóa `paperclip.theme` (xem `kb/intake-portal-web.md`).
- LLM max output tokens 1500 gây `truncated` → 4000 (commit `751f2f07b`).
- Quy tắc cờ nhầm "sập"/SAP, "lượng"/"lương" (commit `93a8fd34d`).
- Model từ chối `temperature` → tùy chọn (commit `fix(devflow): send temperature only when configured`).

## P2 BA Spec (theo dõi)
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| C-32 | Chạy BA song song (workspace theo lượt) khi một spec mỗi 1 đến 3 phút không đủ | C | `kb/ba-spec.md` |
| C-33 | Cách ly agent mạnh hơn: bubblewrap với profile seccomp riêng hoặc runner tách (P4) | B | ADR 0020 |
| C-34 | Chưa kiểm: repo lớn, model local cho agent adapter. Repo riêng có token và giao diện BA review đã kiểm với RESKI (2026-10-19) | B | smoke P2 |
| B-37 | **Xong 2026-10-20**: nguyên nhân là Sophos ký lại TLS cho `api.openai.com`; container tin CA đó qua `NODE_EXTRA_CA_CERTS` + `docker/certs/` (`kb/tech-stack.md`). Backfill embedding nay nghỉ tăng dần sau lỗi (trước đó case REQ-29 của DevFlow Verify ghi 5.322 dòng `agent.embed_failed` trong 22 giờ). Gốc: embedding lỗi `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, dedupe chỉ chạy trigram | done | RESKI, 2026-10-19 |
| B-38 | **Xong 2026-10-20**, nghiêm trọng hơn ghi chép ban đầu: thư mục transcript của Claude Code cho workspace BA giữ lượt chạy của mọi công ty và agent đọc được. Worker xóa nó trước/sau mỗi case; luật chặn thêm thư mục phiên Claude, `.cache`, `.claude.json`; worker đòi đủ luật mới (chạy lại `setup-ba-agent.mjs` mỗi công ty). `memory/` trống vì agent không có tool ghi (`kb/ba-spec.md`) | done | RESKI, 2026-10-19 |
| C-39 | **Xong 2026-10-20**: case `verify 1792397041188` của RESKI đã chuyển `cancelled` bằng transition `force` của board (pipeline không có đường `ba_spec → cancelled`; có lý do trong activity log). Lưu ý còn hiệu lực: `--verify` nên chạy trên công ty thử, không phải công ty pilot | done | RESKI, 2026-10-19 |
| C-35 | Số liệu BA theo hệ thống (override và chi phí mỗi hệ thống) | C | 2026-10-19 |
| C-36 | Xóa được agent "Spike BA …" (API trả 409 vì có run); nút "Set up BA agent" trong UI thay cho script | C | spike |
| B-40 | Tự chạy setup agent BA và Planner khi tạo công ty, và tự đồng bộ lại khi cấu hình chuẩn đổi (hiện phải chạy tay `setup-ba-agent.mjs`, `setup-plan-agent.mjs` cho từng công ty, ví dụ khi thêm luật chặn chéo của `add-tech-plan-stage`) | B | chủ dự án, 2026-10-20 |

## Giao diện portal (theo dõi)
| Mã | Nội dung | Ưu tiên | Nguồn |
|---|---|---|---|
| C-30 | Portal chưa kiểm tra bằng trình đọc màn hình và chưa đo tương phản bằng công cụ; chưa có test render component | C | `kb/intake-portal-web.md` |
| C-31 | Staff UI (trang Triage review) vẫn tiếng Anh; phông Inter của portal lấy từ `/fonts/` của Board (nếu tách máy chủ phải đi kèm phông) | C | 2026-10-18 |
