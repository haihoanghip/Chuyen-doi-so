# API dự kiến — MVP thương mại điện tử

API chạy trên Cloudflare Workers; D1 lưu dữ liệu nghiệp vụ, R2 lưu ảnh. Các endpoint tài khoản, sản phẩm, đơn hàng, quản trị và upload được triển khai dưới `/api/`. Prefix `/api/v1` trong bảng là định hướng phiên bản hóa sau này; reset mật khẩu, danh mục riêng, thanh toán online và rate limiting vẫn là phần cần bổ sung. Request/response dùng JSON trừ upload. Thời gian theo ISO 8601 UTC.

MVP hiện triển khai: `POST /api/auth/{register,login,logout}`, `GET /api/me`, `GET/POST /api/products`, `PATCH/DELETE /api/products/:id`, `GET/POST /api/orders`, `GET/PATCH /api/orders/:id`, `PATCH /api/admin/orders/:id/assignment`, `GET /api/admin/users`, `PATCH /api/admin/users/:id/{role,status}`, `POST /api/admin/bootstrap`, `POST /api/uploads`, `GET /api/images/:key`. Các hàng còn lại trong bảng là kế hoạch.

## Quy tắc chung

- Xác thực bằng session cookie `HttpOnly; Secure; SameSite=Lax`; không lưu access token trong `localStorage`.
- Mọi endpoint riêng tư kiểm tra session, trạng thái tài khoản và quyền ở server. Trả `401` khi chưa đăng nhập, `403` khi không đủ quyền, `404` khi không tồn tại, `422` khi dữ liệu không hợp lệ, `429` khi vượt giới hạn.
- API quản trị cần ghi `audit_logs` cho thao tác nhạy cảm. Không trả hash mật khẩu, secret thanh toán hoặc dữ liệu cá nhân không cần thiết.
- Danh sách dùng `limit` và cursor/offset có giới hạn. Tạo đơn hàng phải tính lại giá, khuyến mãi và tồn kho ở server; không tin tổng tiền do client gửi.
- Upload dùng URL ký có thời hạn hoặc endpoint proxy được xác thực. Kiểm tra MIME, kích thước và quyền; metadata/object key ở D1, bytes ở R2.

## Endpoint

| Method | Endpoint | Quyền | Mục đích |
|---|---|---|---|
| POST | `/auth/register` | Khách | Tạo tài khoản thành viên |
| POST | `/auth/login` | Khách | Đăng nhập, tạo session cookie |
| POST | `/auth/logout` | Đã đăng nhập | Thu hồi session |
| POST | `/auth/forgot-password` | Khách | Gửi yêu cầu đặt lại mật khẩu (không tiết lộ email có tồn tại) |
| POST | `/auth/reset-password` | Token đặt lại | Đặt mật khẩu mới |
| GET | `/me` | Thành viên | Hồ sơ và vai trò hiện tại |
| PATCH | `/me` | Thành viên | Cập nhật hồ sơ của chính mình |
| GET | `/products` | Công khai | Danh sách, tìm kiếm, lọc, phân trang |
| GET | `/products/:id` | Công khai | Chi tiết sản phẩm và ảnh |
| GET | `/categories` | Công khai | Danh sách danh mục |
| GET | `/cart` | Thành viên/guest session | Xem giỏ hàng |
| POST | `/cart/items` | Thành viên/guest session | Thêm mặt hàng |
| PATCH | `/cart/items/:id` | Chủ giỏ hàng | Cập nhật số lượng |
| DELETE | `/cart/items/:id` | Chủ giỏ hàng | Xóa mặt hàng |
| POST | `/orders` | Thành viên | Tạo đơn từ giỏ, kiểm tra giá/tồn kho phía server |
| GET | `/orders` | Thành viên | Xem đơn hàng của chính mình |
| GET | `/orders/:id` | Chủ đơn/nhân viên được giao/admin | Chi tiết đơn |
| POST | `/uploads` | Editor/admin | Tải ảnh trực tiếp vào R2 (MVP, tối đa 5 MB) |
| GET | `/images/:key` | Công khai | Phân phối ảnh đã lưu trong R2 |
| POST | `/payments/:provider/checkout` | Chủ đơn | Tạo phiên thanh toán VNPay/MoMo/Stripe sau khi tích hợp |
| POST | `/webhooks/:provider` | Chữ ký nhà cung cấp | Nhận callback thanh toán; xác minh chữ ký và chống xử lý lặp |
| GET | `/admin/users` | Admin/owner | Tìm kiếm/quản lý tài khoản |
| PATCH | `/admin/users/:id/status` | Admin/owner | Khóa/mở tài khoản |
| PATCH | `/admin/users/:id/role` | Admin/owner | Gán vai trò; chỉ owner có thể cấp admin |
| POST | `/admin/products` | Editor/admin | Tạo sản phẩm |
| PATCH | `/admin/products/:id` | Editor/admin | Cập nhật sản phẩm |
| DELETE | `/admin/products/:id` | Admin/owner | Lưu trữ/xóa sản phẩm |
| PATCH | `/orders/:id` | Staff được phân công/admin/owner | Cập nhật trạng thái đơn |
| PATCH | `/admin/orders/:id/assignment` | Admin/owner | Phân công đơn cho staff |
| GET | `/admin/audit-logs` | Admin/owner | Tra cứu nhật ký kiểm toán |

## Định dạng lỗi

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Dữ liệu gửi lên không hợp lệ",
    "details": []
  }
}
```

Không đưa stack trace, secret hoặc thông tin nội bộ vào response production. Webhook cần trả response theo yêu cầu của nhà cung cấp và chỉ xác nhận sau khi đã lưu/xếp hàng xử lý an toàn.

## Vai trò và quyền tối thiểu

- `guest`: catalog, danh mục, đăng ký/đăng nhập.
- `member`: hồ sơ và giỏ hàng của mình; tạo và xem đơn của mình.
- `staff`: xem/cập nhật đơn được phân công.
- `editor`: quản lý nội dung/sản phẩm và ảnh thuộc phạm vi được cấp.
- `admin`: quản lý người dùng, sản phẩm, đơn hàng và nhật ký theo quyền được cấp.
- `owner`: quản lý vai trò nhạy cảm và cấu hình quản trị.

Dùng quyền theo hành động như `products.write`, `orders.assign`, `orders.update_status`, `users.manage_roles`, `audit_logs.read`. Luôn kiểm tra quyền trên API và phạm vi bản ghi; role ở client chỉ quyết định cách hiển thị giao diện.

## Thứ tự triển khai đề xuất

1. D1 schema/migrations, session/auth, RBAC và rate limit.
2. Catalog, categories, upload R2 và giao diện quản trị nội dung.
3. Cart và đơn hàng; kiểm tra tồn kho và giá ở phía server.
4. Quản lý tài khoản/đơn hàng, audit log và giao diện mobile-first.
5. Tích hợp một cổng thanh toán sau khi chủ dự án tạo tài khoản merchant/test credentials.
6. Webhook đã xác minh chữ ký, chống replay/idempotency, sau đó mới bật thanh toán production.
