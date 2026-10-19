# Chuyển Đổi Số

Ứng dụng web ưu tiên trải nghiệm trên điện thoại, xây dựng và vận hành tối đa trên nền tảng Cloudflare.

> Tài liệu này mô tả kiến trúc mục tiêu. Các dịch vụ được nêu là định hướng triển khai, không khẳng định đã được cấu hình trong môi trường production.

> **MVP hiện có:** storefront mobile-first, đăng ký/đăng nhập, giỏ hàng, đặt đơn chưa thanh toán, khu vực quản trị sản phẩm/đơn hàng/tài khoản, Worker API, migration D1 và upload ảnh vào R2. Cổng thanh toán, email đặt lại mật khẩu, Turnstile và thông báo chưa được tích hợp.

## Nguyên tắc kiến trúc

- **Cloudflare-first:** dùng dịch vụ Cloudflare cho ứng dụng, API, cơ sở dữ liệu, lưu trữ tệp và xử lý nền.
- **Mobile-first UX:** thiết kế từ màn hình điện thoại, sau đó mở rộng cho tablet và desktop.
- **Phân đúng loại dữ liệu:** dữ liệu nghiệp vụ có cấu trúc lưu trong D1; tệp ảnh lưu trong R2; dữ liệu truy cập nhanh hoặc tạm thời lưu trong KV khi phù hợp.
- **Tính toán tại biên:** xử lý API và nghiệp vụ bằng Workers; chuyển tác vụ dài hoặc chạy theo lịch sang Queues/Workflows hoặc Cron Triggers tùy yêu cầu.

## Kiến trúc Cloudflare

```text
Điện thoại / Trình duyệt
          │
          ▼
Cloudflare (DNS, CDN, WAF)
          │
          ├── Cloudflare Workers: ứng dụng web, API và nghiệp vụ
          ├── Cloudflare D1: dữ liệu quan hệ, giao dịch và dữ liệu nghiệp vụ
          ├── Cloudflare R2: ảnh và các tệp tải lên
          └── Cloudflare KV: cache/key-value phân tán, dữ liệu tạm hoặc cấu hình phù hợp
```

### Ứng dụng web và API

- Triển khai web app trên **Cloudflare Workers** (ví dụ ứng dụng full-stack dùng framework có adapter tương thích Workers).
- Dùng **Workers** cho API, xác thực, kiểm tra quyền và các phép tính nghiệp vụ cần phản hồi nhanh.
- Tài nguyên tĩnh được phân phối qua Cloudflare CDN.
- Chỉ dùng Cloudflare Pages nếu cách triển khai frontend tĩnh riêng phù hợp với kiến trúc thực tế; Workers vẫn là runtime cho API và phần server-side khi cần.

### Cơ sở dữ liệu — D1

Dùng **Cloudflare D1** làm cơ sở dữ liệu chính cho dữ liệu quan hệ, ví dụ người dùng, danh mục, nội dung, đơn hàng và lịch sử giao dịch. Quản lý thay đổi schema bằng migration có phiên bản. Không lưu ảnh hoặc tệp nhị phân trong D1.

### Hình ảnh và tệp — R2

Dùng **Cloudflare R2** làm nơi lưu trữ tập trung cho toàn bộ ảnh do ứng dụng quản lý, gồm ảnh nội dung, ảnh hồ sơ và ảnh tải lên. D1 chỉ lưu object key, metadata và thông tin liên kết cần thiết. Việc tải lên cần kiểm tra quyền, loại tệp và kích thước; phân phối ảnh qua URL/domain được cấu hình phù hợp.

### Key-value và dữ liệu dạng NoSQL — KV

Dùng **Cloudflare KV** cho dữ liệu key-value có thể chấp nhận tính nhất quán cuối cùng, chẳng hạn cache, cấu hình ít thay đổi hoặc dữ liệu tạm. KV không phải Redis và không nên thay thế D1 cho giao dịch hay dữ liệu cần cập nhật nhất quán tức thời. Nếu cần thao tác kiểu Redis như TTL ngắn, counter hoặc truy cập có độ trễ thấp, đánh giá **Cloudflare Durable Objects** hoặc dịch vụ phù hợp thay vì giả định KV có đầy đủ hành vi Redis.

### Phần tính toán

- Tính toán nhẹ, có giới hạn thời gian và xử lý theo yêu cầu: **Workers**.
- Tác vụ bất đồng bộ, cần thử lại hoặc xử lý theo lô: **Cloudflare Queues**.
- Luồng công việc nhiều bước, cần điều phối và chờ: cân nhắc **Workflows**.
- Tác vụ định kỳ: **Cron Triggers**.
- Chọn dịch vụ theo khối lượng, thời gian chạy và giới hạn runtime; không đưa tác vụ nặng hoặc kéo dài vào request tương tác.

## Mobile-first UX

- Xây dựng layout từ viewport điện thoại; nội dung và thao tác chính dễ dùng bằng một tay.
- Có vùng chạm đủ rộng, chữ dễ đọc, biểu mẫu ngắn và bàn phím phù hợp loại dữ liệu.
- Tối ưu ảnh theo kích thước hiển thị, định dạng và tải trì hoãn để giảm dung lượng mạng di động.
- Hiển thị trạng thái tải, lỗi, thành công và trạng thái mất kết nối rõ ràng.
- Đảm bảo tương phản, điều hướng bàn phím và nhãn trợ năng; mở rộng bố cục cho màn hình lớn mà không làm giảm trải nghiệm mobile.

## Vai trò người dùng và chức năng

Phân quyền được kiểm tra ở API/Workers trên từng yêu cầu; ẩn nút trên giao diện chỉ hỗ trợ UX, không thay thế kiểm tra quyền phía server. Dùng mô hình **RBAC** (role-based access control): tài khoản có một hoặc nhiều vai trò, vai trò gom các quyền theo chức năng. Dữ liệu tài khoản, vai trò và quyền lưu trong D1.

| Vai trò | Chức năng chính |
|---|---|
| Khách (`guest`) | Xem trang công khai, nội dung được phép xem, tìm kiếm; đăng ký hoặc đăng nhập |
| Thành viên (`member`) | Quản lý hồ sơ; sử dụng chức năng nghiệp vụ dành cho người dùng; xem và cập nhật dữ liệu của chính mình; gửi yêu cầu hỗ trợ |
| Nhân viên (`staff`) | Xử lý hồ sơ/yêu cầu được phân công; cập nhật trạng thái và ghi chú; xem dữ liệu cần thiết cho công việc |
| Biên tập viên (`editor`) | Tạo, chỉnh sửa, xuất bản hoặc lưu nháp nội dung; quản lý ảnh nội dung trong phạm vi được cấp |
| Quản trị viên (`admin`) | Quản lý người dùng, nội dung và cấu hình nghiệp vụ; phân vai trò thông thường; xem nhật ký hoạt động |
| Chủ hệ thống (`owner`) | Toàn quyền cấu hình hệ thống và phân quyền quản trị; quản lý vai trò nhạy cảm và thiết lập vận hành |

### Các chức năng cần có

- **Tài khoản:** đăng ký/đăng nhập/đăng xuất, khôi phục mật khẩu, hồ sơ cá nhân và trạng thái tài khoản.
- **Phân quyền:** kiểm tra quyền tại từng API; giới hạn dữ liệu theo chủ sở hữu hoặc nhiệm vụ được giao; từ chối mặc định khi chưa được cấp quyền.
- **Quản trị:** danh sách/tìm kiếm tài khoản, khóa hoặc mở tài khoản, gán vai trò, quản lý nội dung và xem lịch sử thao tác.
- **Nghiệp vụ chính:** thiết kế thành các module theo yêu cầu sản phẩm; mỗi module cần xác định ai được xem, tạo, sửa, duyệt và xóa dữ liệu.
- **Tệp và ảnh:** tải lên, xem trước, thay thế và xóa; chỉ người có quyền truy cập đối tượng mới được thao tác với tệp tương ứng trong R2.
- **Thông báo và hỗ trợ:** thông báo trạng thái xử lý, gửi yêu cầu hỗ trợ và theo dõi phản hồi.
- **Nhật ký kiểm toán:** ghi nhận các thao tác nhạy cảm như đổi vai trò, khóa tài khoản, xuất bản hoặc xóa dữ liệu; chỉ vai trò phù hợp được xem.

Quyền nên được đặt tên theo hành động và tài nguyên, ví dụ `users.read`, `users.manage_roles`, `content.publish`, `requests.assign`, `files.upload`. Không cho phép `admin` tự nâng thành `owner`; các thao tác cấp quyền cao cần được giới hạn và ghi nhật ký. Giao diện mobile hiển thị dashboard và hành động phù hợp với vai trò hiện tại.

### Dữ liệu phân quyền trong D1

MVP lưu một role trên `users.role` để đơn giản hóa khởi đầu; `sessions` giữ session đã băm và `audit_logs` ghi thao tác quản trị. Khi cần một tài khoản có nhiều vai trò hoặc quyền tùy chỉnh, mở rộng thành `roles`, `permissions`, `user_roles`, `role_permissions`. Phạm vi dữ liệu theo chủ sở hữu/người được giao vẫn phải được kiểm tra ở truy vấn server.

## Sơ đồ trách nhiệm dữ liệu

| Loại dữ liệu | Dịch vụ | Ghi chú |
|---|---|---|
| Người dùng, nội dung, dữ liệu nghiệp vụ | D1 | Dữ liệu quan hệ; schema quản lý bằng migration |
| Ảnh và tệp tải lên | R2 | D1 lưu metadata/object key, không lưu nội dung tệp |
| Cache, cấu hình key-value, dữ liệu tạm phù hợp | KV | Không dùng thay cơ sở dữ liệu giao dịch hoặc Redis đầy đủ |
| API và nghiệp vụ đồng bộ | Workers | Xác thực, phân quyền, kiểm tra dữ liệu và tính toán nhanh |
| Tác vụ nền / định kỳ | Queues, Workflows, Cron Triggers | Chọn theo kiểu xử lý và yêu cầu vận hành |

## Nguyên tắc bảo mật và vận hành

- Không đưa secrets vào mã nguồn hoặc frontend; cấu hình bằng secrets/bindings của Cloudflare.
- Kiểm tra dữ liệu đầu vào và phân quyền tại server/API.
- Dùng migration có thể kiểm soát cho D1; tách cấu hình môi trường phát triển, staging và production.
- Giới hạn quyền truy cập R2; không để lộ bucket riêng tư qua cấu hình public ngoài chủ đích.
- Theo dõi lỗi, thời gian phản hồi và mức sử dụng tài nguyên; đặt giới hạn cho upload và các phép tính.

## Chức năng MVP

- Cửa hàng công khai có tìm kiếm, lọc danh mục và giỏ hàng trên điện thoại.
- Tài khoản thành viên có đăng ký/đăng nhập/đăng xuất bằng session cookie HttpOnly.
- Thành viên gửi đơn hàng; giá và tồn kho được kiểm tra phía server. Thanh toán hiện là COD/chờ xác nhận.
- Admin/editor quản lý sản phẩm; staff xử lý đơn được phân công; admin/owner xem và cập nhật đơn.
- Owner/admin quản lý tài khoản và vai trò; tạo owner đầu tiên bằng bootstrap secret một lần.
- Ảnh sản phẩm được tải lên R2 qua Worker; D1 lưu dữ liệu sản phẩm, tài khoản, session, đơn hàng và audit log.

KV dùng cache danh sách sản phẩm công khai trong 60 giây; D1 vẫn là nguồn dữ liệu chính. Cổng thanh toán, quên mật khẩu, phân công nhân viên qua giao diện, rate limiting và Turnstile chưa hoàn thiện.

## Cấu trúc giao diện và mã nguồn

```text
public/
├── index.html          # Khung trang và các hộp thoại
├── styles.css          # Toàn bộ giao diện responsive/mobile-first
└── js/
    ├── core.js         # State, API client, format tiền và tiện ích
    ├── storefront.js   # Cửa hàng, tìm kiếm, giỏ hàng, lịch sử đơn
    ├── admin.js        # Dashboard và thao tác quản trị
    └── main.js         # Khởi động ứng dụng, điều hướng và form handlers

src/worker.js           # API Cloudflare Worker
migrations/             # Schema D1 và dữ liệu mẫu
```

Chỉnh nội dung/khung trang trong `public/index.html`, màu sắc và bố cục trong `public/styles.css`, chức năng theo module trong `public/js/`. `index.html` ở thư mục gốc chỉ chuyển tới `public/` để tiện mở bằng Apache/XAMPP; Workers phục vụ trực tiếp thư mục `public`.

## Phát triển và triển khai

Dự án dùng HTML/CSS/JavaScript thuần cho giao diện và Cloudflare Worker cho API. Chạy local với Wrangler; `index.html` ở thư mục gốc là bản sao để xem giao diện tĩnh, còn Worker cần chạy để dùng đăng nhập, D1, R2 và đặt hàng.

```powershell
npx wrangler login
npx wrangler d1 create chuyen-doi-so-db
npx wrangler r2 bucket create chuyen-doi-so-images
npx wrangler kv namespace create CACHE
```

Thay `database_id` và KV `id` trong `wrangler.toml` bằng ID Wrangler trả về. Tạo `.env` bằng cách sao chép `.env.example`, thay hai giá trị mẫu `PASSWORD_PEPPER` và `BOOTSTRAP_SECRET` bằng hai chuỗi ngẫu nhiên khác nhau, rồi chạy:

```powershell
npx wrangler d1 migrations apply chuyen-doi-so-db --local
npx wrangler dev
```

Mở URL local mà Wrangler hiển thị. Tạo owner lần đầu qua **Đăng nhập → Khởi tạo cửa hàng lần đầu** bằng đúng `BOOTSTRAP_SECRET`; sau đó đăng nhập bằng tài khoản vừa tạo. Chỉ bootstrap được một owner và endpoint sẽ khóa sau lần tạo thành công. Wrangler nạp secrets local từ `.env`; không tạo đồng thời `.dev.vars` vì Wrangler chỉ dùng một trong hai nguồn.

Để áp dụng schema và dữ liệu mẫu lên D1 production rồi deploy:

```powershell
npx wrangler d1 migrations apply chuyen-doi-so-db --remote
npx wrangler secret put PASSWORD_PEPPER
npx wrangler secret put BOOTSTRAP_SECRET
npx wrangler deploy
```

Trước deploy, cần thay ID D1/KV trong `wrangler.toml` và chắc chắn R2 bucket đã được tạo. Không dùng placeholder ID trong production.

Worker đặt CPU budget 1 giây cho request đăng nhập/đăng ký dùng PBKDF2. Workers Free mặc định giới hạn CPU 10 ms; cấu hình CPU tùy chỉnh cần Workers Paid. Xem [giới hạn CPU của Workers](https://developers.cloudflare.com/workers/platform/limits/) trước khi deploy production.

### Cấu hình bí mật và API bên ngoài

- Tạo `.env` từ [.env.example](.env.example) cho cấu hình không nhạy cảm của công cụ phát triển; không đặt secret có tiền tố `VITE_` vì các biến này có thể được đóng gói vào trình duyệt.
- Secret local được đặt trong `.env` (tạo theo [.env.example](.env.example)); production dùng `wrangler secret put TEN_BIEN`. Không commit `.env`, `.dev.vars` hoặc file chứa credentials.
- Secrets thực sự dùng trong MVP là `PASSWORD_PEPPER` và `BOOTSTRAP_SECRET`. Thông tin VNPay, MoMo, Stripe, email hoặc Turnstile chưa cần vì các tích hợp đó chưa được bật.
- API đã triển khai và API dự kiến được đánh dấu riêng trong [docs/API.md](docs/API.md). Không cần API key bên thứ ba cho catalog, giỏ hàng, tài khoản hoặc đặt đơn COD.

### Thông tin cần chuẩn bị để triển khai

1. **Cloudflare account:** đăng nhập bằng `npx wrangler login`; tự tạo D1, R2 và KV bằng các lệnh ở trên. ID D1/KV và tên bucket sẽ gắn vào `wrangler.toml`; chúng không phải secret ứng dụng.
2. **Tên miền:** chỉ cần nếu muốn dùng domain riêng; có thể chạy bằng domain `workers.dev` trong giai đoạn đầu.
3. **Secrets ứng dụng:** tự tạo chuỗi ngẫu nhiên riêng cho `PASSWORD_PEPPER` và `BOOTSTRAP_SECRET`; lưu local trong `.env`, production dùng `wrangler secret put`. Không gửi secret qua chat hoặc commit vào Git.
4. **Thanh toán:** chưa cần khóa thanh toán để chạy MVP. Khi muốn nhận thanh toán online, cần chọn VNPay, MoMo hoặc Stripe và tự tạo tài khoản merchant để lấy khóa sandbox.

Không cần tự tạo Cloudflare API token để ứng dụng hoạt động: dùng Wrangler đăng nhập khi triển khai. Nếu sau này có CI/CD, tạo token riêng với quyền tối thiểu cho đúng tài khoản và tài nguyên.
