// All user-facing text of the portal (Vietnamese only). Server status labels come from the API itself.
export const vi = {
  appName: "Cổng yêu cầu",
  loading: "Đang tải...",
  signOut: "Đăng xuất",
  back: "Quay lại",
  retry: "Thử lại",
  skipToContent: "Bỏ qua đến nội dung chính",
  brandSub: "Cổng yêu cầu",
  theme: { toLight: "Chuyển sang giao diện sáng", toDark: "Chuyển sang giao diện tối" },

  auth: {
    title: "Đăng nhập",
    inviteTitle: "Bạn được mời sử dụng cổng yêu cầu",
    inviteHint: "Đăng nhập hoặc tạo tài khoản để nhận lời mời.",
    name: "Họ và tên",
    email: "Email",
    password: "Mật khẩu",
    passwordHint: "Ít nhất 8 ký tự",
    showPassword: "Hiện mật khẩu",
    hidePassword: "Ẩn mật khẩu",
    signingIn: "Đang xử lý...",
    signIn: "Đăng nhập",
    registerAndAccept: "Tạo tài khoản và nhận lời mời",
    switchToRegister: "Chưa có tài khoản? Tạo tài khoản",
    switchToSignIn: "Đã có tài khoản? Đăng nhập",
    noAccountHint: "Chưa có tài khoản? Hãy mở đường dẫn lời mời mà bộ phận IT đã gửi cho bạn.",
  },

  invite: {
    accepting: "Đang xác nhận lời mời...",
    done: "Đã xác nhận lời mời. Bạn có thể gửi yêu cầu.",
    start: "Bắt đầu",
  },

  company: {
    pickTitle: "Chọn công ty",
    pickHint: "Tài khoản của bạn thuộc nhiều công ty. Chọn công ty bạn muốn gửi và theo dõi yêu cầu.",
    switchLabel: "Công ty",
  },

  noAccess: {
    title: "Tài khoản chưa được cấp quyền",
    body: "Tài khoản này chưa được mời vào cổng yêu cầu. Hãy mở đường dẫn lời mời mà bộ phận IT đã gửi cho bạn.",
  },

  list: {
    title: "Yêu cầu của tôi",
    subtitle: "Theo dõi trạng thái các yêu cầu bạn đã gửi.",
    count: "yêu cầu",
    newRequest: "Gửi yêu cầu mới",
    empty: "Bạn chưa gửi yêu cầu nào.",
    emptyHint: "Nhấn \"Gửi yêu cầu mới\" để bắt đầu.",
    sentOn: "Gửi ngày",
  },

  form: {
    title: "Gửi yêu cầu mới",
    subject: "Tiêu đề",
    subjectHint: "Tóm tắt yêu cầu trong một câu",
    description: "Mô tả chi tiết",
    descriptionHint: "Bạn cần gì, ở màn hình hoặc chức năng nào, hiện đang gặp vấn đề gì?",
    impact: "Ảnh hưởng đến công việc (không bắt buộc)",
    impactHint: "Ví dụ: số người dùng bị ảnh hưởng, mức độ gấp",
    files: "Tệp đính kèm (không bắt buộc)",
    filesHint: "Tối đa 5 tệp, mỗi tệp không quá 10 MB. Hỗ trợ ảnh, PDF, Word, Excel, PowerPoint, TXT, CSV.",
    chooseFiles: "Chọn tệp",
    dropPrompt: "Kéo thả tệp vào đây hoặc chọn từ máy",
    dropFull: "Đã đủ số tệp tối đa",
    required: "bắt buộc",
    optional: "không bắt buộc",
    removeFile: "Bỏ tệp",
    remove: "Bỏ",
    fieldRequired: "Trường này là bắt buộc.",
    submit: "Gửi yêu cầu",
    submitting: "Đang gửi...",
    submitted: "Đã gửi yêu cầu. Bộ phận IT sẽ xem xét và cập nhật trạng thái tại đây.",
    characters: "ký tự",
  },

  detail: {
    status: "Trạng thái",
    sentOn: "Gửi ngày",
    updatedOn: "Cập nhật",
    description: "Mô tả",
    impact: "Ảnh hưởng",
    attachments: "Tệp đính kèm",
    noAttachments: "Chưa có tệp đính kèm.",
    addFiles: "Bổ sung tệp",
    uploading: "Đang tải lên...",
    upload: "Tải lên",
    download: "Tải xuống",
    added: "Đã bổ sung tệp đính kèm.",
  },

  files: {
    tooMany: "Chỉ được đính kèm tối đa 5 tệp.",
    tooLarge: "Mỗi tệp không được quá 10 MB.",
    badType: "Loại tệp không được hỗ trợ.",
    empty: "Tệp rỗng.",
  },

  errors: {
    generic: "Có lỗi xảy ra. Vui lòng thử lại.",
    network: "Không kết nối được máy chủ. Kiểm tra mạng và thử lại.",
    sessionExpired: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
    badCredentials: "Email hoặc mật khẩu không đúng.",
    emailTaken: "Email này đã có tài khoản. Hãy đăng nhập.",
    accountExists: "Email này đã có tài khoản. Hãy đăng nhập để nhận lời mời.",
    weakPassword: "Mật khẩu cần ít nhất 8 ký tự.",
    notRequester: "Tài khoản chưa được cấp quyền sử dụng cổng yêu cầu.",
    inviteInvalid: "Đường dẫn lời mời không hợp lệ.",
    inviteUsed: "Lời mời này đã được sử dụng.",
    inviteExpired: "Lời mời đã hết hạn. Hãy xin bộ phận IT gửi lời mời mới.",
    inviteRevoked: "Lời mời đã bị thu hồi.",
    tooManyRequests: "Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
    fileTooLarge: "Tệp quá lớn (tối đa 10 MB).",
    fileType: "Loại tệp không được hỗ trợ.",
    fileContent: "Nội dung tệp không khớp với loại tệp.",
    tooManyFiles: "Chỉ được đính kèm tối đa 5 tệp.",
    pipelineMissing: "Công ty chưa được thiết lập quy trình tiếp nhận. Hãy liên hệ bộ phận IT.",
    notFound: "Không tìm thấy.",
    requiredField: "Vui lòng nhập thông tin bắt buộc.",
  },

  notFound: { title: "Không tìm thấy trang", home: "Về danh sách yêu cầu" },
} as const;

// Terminal status labels returned by the server (server/src/devflow/portal/status-labels.ts), used for colour only.
export const STATUS_DONE = "Hoàn thành";
export const STATUS_CLOSED = "Không tiếp tục xử lý";
