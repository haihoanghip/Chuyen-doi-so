const COOKIE = "shop_session";
const SESSION_DAYS = 14;
const ADMIN_ROLES = new Set(["admin", "owner"]);
const ID = () => crypto.randomUUID();
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
});
const fail = (status, code, message) => json({ error: { code, message } }, status);
const cleanText = (value, max = 500) => String(value ?? "").trim().slice(0, max);
function r2ImagePath(value, requestUrl) {
  if (!value) return null;
  try {
    const candidate = new URL(String(value), requestUrl);
    if (candidate.origin !== requestUrl.origin || !/^\/api\/images\/[A-Za-z0-9/_-]+$/.test(candidate.pathname)) return false;
    return candidate.pathname;
  } catch { return false; }
}
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const randomToken = () => bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async (value) => bytesToB64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

async function passwordHash(password, salt, pepper) {
  const material = new TextEncoder().encode(`${password}:${pepper || ""}`);
  const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 210000 }, key, 256);
  return bytesToB64(bits);
}
function cookieHeader(value, request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
function readCookie(request) {
  const raw = request.headers.get("cookie") || "";
  const found = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  return found ? decodeURIComponent(found.slice(COOKIE.length + 1)) : "";
}
async function currentUser(request, env) {
  const token = readCookie(request);
  if (!token) return null;
  const result = await env.DB.prepare(`SELECT u.id, u.email, u.name, u.role, u.status
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at > datetime('now') LIMIT 1`).bind(await sha256(token)).first();
  return result?.status === "active" ? result : null;
}
async function bodyJson(request) {
  try { return await request.json(); } catch { return null; }
}
async function readBounded(stream, limit) {
  if (!stream) return null;
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return false; }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}
function requireBindings(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
}

async function api(request, env) {
  requireBindings(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const isUpload = path === "/api/uploads" && method === "POST";
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (!isUpload && contentLength > 1024 * 1024) return fail(413, "REQUEST_TOO_LARGE", "Request tối đa 1 MB.");
  const body = method === "GET" || method === "HEAD" || isUpload ? null : await bodyJson(request);
  if (method !== "GET" && method !== "HEAD" && !isUpload && body === null) return fail(400, "INVALID_JSON", "Request body phải là JSON hợp lệ.");

  if (path === "/api/health" && method === "GET") return json({ ok: true, service: "chuyen-doi-so-shop" });

  if (path === "/api/auth/register" && method === "POST") {
    if (!env.PASSWORD_PEPPER) return fail(503, "CONFIGURATION_ERROR", "Thiếu PASSWORD_PEPPER trong cấu hình Worker.");
    const email = cleanText(body.email, 254).toLowerCase();
    const name = cleanText(body.name, 100);
    const password = String(body.password || "");
    if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || password.length < 10) return fail(422, "VALIDATION_ERROR", "Vui lòng nhập email hợp lệ, tên từ 2 ký tự và mật khẩu tối thiểu 10 ký tự.");
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (exists) return fail(409, "EMAIL_EXISTS", "Email này đã được đăng ký.");
    const id = ID(), salt = randomToken(), hash = await passwordHash(password, salt, env.PASSWORD_PEPPER);
    await env.DB.prepare("INSERT INTO users (id,email,name,password_hash,role) VALUES (?,?,?,?, 'member')").bind(id, email, name, `${salt}.${hash}`).run();
    const token = randomToken(), expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await env.DB.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)").bind(await sha256(token), id, expires).run();
    return json({ user: { id, email, name, role: "member" } }, 201, { "set-cookie": cookieHeader(token, request, SESSION_DAYS * 86400) });
  }

  if (path === "/api/auth/login" && method === "POST") {
    if (!env.PASSWORD_PEPPER) return fail(503, "CONFIGURATION_ERROR", "Thiếu PASSWORD_PEPPER trong cấu hình Worker.");
    const email = cleanText(body.email, 254).toLowerCase();
    const user = await env.DB.prepare("SELECT id,email,name,role,status,password_hash FROM users WHERE email=?").bind(email).first();
    const [salt, stored] = String(user?.password_hash || ".").split(".");
    const calculated = salt ? await passwordHash(String(body.password || ""), salt, env.PASSWORD_PEPPER) : "";
    if (!user || user.status !== "active" || !safeEqual(stored, calculated)) return fail(401, "INVALID_CREDENTIALS", "Email hoặc mật khẩu không chính xác.");
    const token = randomToken(), expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await env.DB.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)").bind(await sha256(token), user.id, expires).run();
    return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } }, 200, { "set-cookie": cookieHeader(token, request, SESSION_DAYS * 86400) });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const token = readCookie(request);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", request, 0) });
  }

  if (path === "/api/me" && method === "GET") {
    const user = await currentUser(request, env);
    return user ? json({ user }) : fail(401, "UNAUTHENTICATED", "Vui lòng đăng nhập.");
  }

  if (path === "/api/admin/bootstrap" && method === "POST") {
    if (!env.PASSWORD_PEPPER) return fail(503, "CONFIGURATION_ERROR", "Thiếu PASSWORD_PEPPER trong cấu hình Worker.");
    if (!env.BOOTSTRAP_SECRET || !safeEqual(request.headers.get("x-bootstrap-secret") || "", env.BOOTSTRAP_SECRET)) return fail(403, "FORBIDDEN", "Mã khởi tạo quản trị không hợp lệ.");
    const owner = await env.DB.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").first();
    if (owner) return fail(409, "ALREADY_BOOTSTRAPPED", "Tài khoản chủ hệ thống đã được tạo.");
    const email = cleanText(body.email, 254).toLowerCase(), name = cleanText(body.name, 100), password = String(body.password || "");
    if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || password.length < 12) return fail(422, "VALIDATION_ERROR", "Email không hợp lệ; tên tối thiểu 2 ký tự; mật khẩu quản trị tối thiểu 12 ký tự.");
    const id = ID(), salt = randomToken(), hash = await passwordHash(password, salt, env.PASSWORD_PEPPER);
    await env.DB.prepare("INSERT INTO users (id,email,name,password_hash,role) VALUES (?,?,?,?, 'owner')").bind(id, email, name, `${salt}.${hash}`).run();
    await env.DB.prepare("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id) VALUES (?,?, 'bootstrap_owner','user',?)").bind(ID(), id, id).run();
    return json({ ok: true, message: "Tạo tài khoản owner thành công. Hãy đăng nhập." }, 201);
  }

  const user = await currentUser(request, env);
  if (path === "/api/products" && method === "GET") {
    const admin = user && ADMIN_ROLES.has(user.role);
    const status = admin ? cleanText(url.searchParams.get("status"), 20) : "active";
    const q = cleanText(url.searchParams.get("q"), 80);
    const cacheKey = "products:active:all:v1";
    if (!admin && !q && env.CACHE) {
      const cached = await env.CACHE.get(cacheKey, "json");
      if (cached) return json({ products: cached });
    }
    const query = `SELECT id,name,description,price,category,image_url,stock,status,created_at FROM products
      WHERE (?='' OR status=?) AND (?='' OR name LIKE '%'||?||'%' OR category LIKE '%'||?||'%')
      ORDER BY created_at DESC LIMIT 100`;
    const rows = await env.DB.prepare(query).bind(status, status, q, q, q).all();
    if (!admin && !q && env.CACHE) await env.CACHE.put(cacheKey, JSON.stringify(rows.results || []), { expirationTtl: 60 });
    return json({ products: rows.results || [] });
  }
  if (path === "/api/products" && method === "POST") {
    if (!user || !["admin", "owner", "editor"].includes(user.role)) return fail(user ? 403 : 401, "FORBIDDEN", "Bạn không có quyền quản lý sản phẩm.");
    const name = cleanText(body.name, 160), description = cleanText(body.description, 3000), category = cleanText(body.category, 80) || "Khác";
    const price = Number(body.price), stock = Number(body.stock), status = body.status === "draft" ? "draft" : "active";
    if (name.length < 2 || !Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(stock) || stock < 0) return fail(422, "VALIDATION_ERROR", "Tên, giá hoặc tồn kho không hợp lệ.");
    const imageUrl = r2ImagePath(body.image_url, url);
    if (imageUrl === false) return fail(422, "INVALID_IMAGE_URL", "Ảnh sản phẩm phải được tải lên R2 của cửa hàng này.");
    const id = ID();
    await env.DB.prepare("INSERT INTO products (id,name,description,price,category,image_url,stock,status) VALUES (?,?,?,?,?,?,?,?)").bind(id, name, description, price, category, imageUrl, stock, status).run();
    await env.DB.prepare("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id) VALUES (?,?, 'product.create','product',?)").bind(ID(), user.id, id).run();
    if (env.CACHE) await env.CACHE.delete("products:active:all:v1");
    return json({ product: { id, name, description, price, category, image_url: imageUrl, stock, status } }, 201);
  }
  const productMatch = path.match(/^\/api\/products\/([\w-]+)$/);
  if (productMatch && method === "PATCH") {
    if (!user || !["admin", "owner", "editor"].includes(user.role)) return fail(user ? 403 : 401, "FORBIDDEN", "Bạn không có quyền quản lý sản phẩm.");
    const id = productMatch[1], old = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(id).first();
    if (!old) return fail(404, "NOT_FOUND", "Không tìm thấy sản phẩm.");
    const imageUrl = body.image_url === undefined ? old.image_url : r2ImagePath(body.image_url, url);
    if (imageUrl === false) return fail(422, "INVALID_IMAGE_URL", "Ảnh sản phẩm phải được tải lên R2 của cửa hàng này.");
    const values = {
      name: body.name === undefined ? old.name : cleanText(body.name, 160),
      description: body.description === undefined ? old.description : cleanText(body.description, 3000),
      price: body.price === undefined ? old.price : Number(body.price),
      category: body.category === undefined ? old.category : cleanText(body.category, 80),
      image_url: imageUrl,
      stock: body.stock === undefined ? old.stock : Number(body.stock),
      status: body.status === undefined ? old.status : body.status
    };
    if (values.name.length < 2 || !Number.isSafeInteger(values.price) || values.price < 0 || !Number.isSafeInteger(values.stock) || values.stock < 0 || !["active", "draft", "archived"].includes(values.status)) return fail(422, "VALIDATION_ERROR", "Dữ liệu sản phẩm không hợp lệ.");
    await env.DB.prepare("UPDATE products SET name=?,description=?,price=?,category=?,image_url=?,stock=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(values.name, values.description, values.price, values.category, values.image_url, values.stock, values.status, id).run();
    await env.DB.prepare("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id) VALUES (?,?, 'product.update','product',?)").bind(ID(), user.id, id).run();
    if (env.CACHE) await env.CACHE.delete("products:active:all:v1");
    return json({ product: { id, ...values } });
  }
  if (productMatch && method === "DELETE") {
    if (!user || !ADMIN_ROLES.has(user.role)) return fail(user ? 403 : 401, "FORBIDDEN", "Chỉ admin mới được lưu trữ sản phẩm.");
    await env.DB.prepare("UPDATE products SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(productMatch[1]).run();
    await env.DB.prepare("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id) VALUES (?,?, 'product.archive','product',?)").bind(ID(), user.id, productMatch[1]).run();
    if (env.CACHE) await env.CACHE.delete("products:active:all:v1");
    return json({ ok: true });
  }

  if (path === "/api/orders" && method === "POST") {
    if (!user) return fail(401, "UNAUTHENTICATED", "Vui lòng đăng nhập để đặt hàng.");
    const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
    const customerName = cleanText(body.customer_name, 120), phone = cleanText(body.phone, 30), address = cleanText(body.address, 500);
    if (!items.length || customerName.length < 2 || phone.length < 8 || address.length < 8) return fail(422, "VALIDATION_ERROR", "Vui lòng nhập thông tin nhận hàng và ít nhất một sản phẩm.");
    const normalized = new Map();
    for (const item of items) {
      const id = cleanText(item.id, 80), quantity = Number(item.quantity);
      if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) return fail(422, "VALIDATION_ERROR", "Sản phẩm hoặc số lượng không hợp lệ.");
      normalized.set(id, (normalized.get(id) || 0) + quantity);
    }
    const lines = [];
    for (const [id, quantity] of normalized) {
      const product = await env.DB.prepare("SELECT id,name,price,stock,status FROM products WHERE id=?").bind(id).first();
      if (!product || product.status !== "active" || product.stock < quantity) return fail(409, "OUT_OF_STOCK", `Sản phẩm ${product?.name || "đã chọn"} hiện không đủ tồn kho.`);
      lines.push({ ...product, quantity });
    }
    const total = lines.reduce((sum, item) => sum + item.price * item.quantity, 0);
    if (!Number.isSafeInteger(total)) return fail(422, "INVALID_TOTAL", "Tổng đơn hàng vượt giới hạn xử lý.");
    const orderId = ID();
    const reserved = [];
    for (const line of lines) {
      const result = await env.DB.prepare("UPDATE products SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active' AND stock>=?").bind(line.quantity, line.id, line.quantity).run();
      if (result.meta?.changes !== 1) {
        for (const prior of reserved) await env.DB.prepare("UPDATE products SET stock=stock+? WHERE id=?").bind(prior.quantity, prior.id).run();
        return fail(409, "OUT_OF_STOCK", `Sản phẩm ${line.name} vừa hết hàng.`);
      }
      reserved.push({ id: line.id, quantity: line.quantity });
    }
    const statements = [env.DB.prepare("INSERT INTO orders (id,user_id,customer_name,phone,address,note,total) VALUES (?,?,?,?,?,?,?)").bind(orderId, user.id, customerName, phone, address, cleanText(body.note, 500), total)];
    for (const line of lines) statements.push(env.DB.prepare("INSERT INTO order_items (id,order_id,product_id,product_name,unit_price,quantity) VALUES (?,?,?,?,?,?)").bind(ID(), orderId, line.id, line.name, line.price, line.quantity));
    try { await env.DB.batch(statements); }
    catch (error) {
      for (const prior of reserved) await env.DB.prepare("UPDATE products SET stock=stock+? WHERE id=?").bind(prior.quantity, prior.id).run();
      throw error;
    }
    return json({ order: { id: orderId, total, status: "pending" } }, 201);
  }
  if (path === "/api/orders" && method === "GET") {
    if (!user) return fail(401, "UNAUTHENTICATED", "Vui lòng đăng nhập.");
    const rows = ADMIN_ROLES.has(user.role)
      ? await env.DB.prepare("SELECT o.*,u.email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 100").all()
      : user.role === "staff"
        ? await env.DB.prepare("SELECT o.*,u.email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.assigned_to=? ORDER BY o.created_at DESC LIMIT 100").bind(user.id).all()
        : user.role === "editor"
          ? { results: [] }
      : await env.DB.prepare("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(user.id).all();
    return json({ orders: rows.results || [] });
  }
  const orderMatch = path.match(/^\/api\/orders\/([\w-]+)$/);
  if (orderMatch && method === "GET") {
    if (!user) return fail(401, "UNAUTHENTICATED", "Vui lòng đăng nhập.");
    const order = user.role === "staff"
      ? await env.DB.prepare("SELECT * FROM orders WHERE id=? AND assigned_to=?").bind(orderMatch[1], user.id).first()
      : await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderMatch[1]).first();
    if (!order) return fail(404, "NOT_FOUND", "Không tìm thấy đơn hàng.");
    if (order.user_id !== user.id && !["staff", "admin", "owner"].includes(user.role)) return fail(403, "FORBIDDEN", "Bạn không có quyền xem đơn hàng này.");
    const items = await env.DB.prepare("SELECT product_id,product_name,unit_price,quantity FROM order_items WHERE order_id=?").bind(order.id).all();
    return json({ order, items: items.results || [] });
  }
  if (orderMatch && method === "PATCH") {
    if (!user || !["staff", "admin", "owner"].includes(user.role)) return fail(user ? 403 : 401, "FORBIDDEN", "Bạn không có quyền cập nhật đơn hàng.");
    const status = cleanText(body.status, 20);
    if (!["confirmed", "shipping", "completed", "cancelled"].includes(status)) return fail(422, "VALIDATION_ERROR", "Trạng thái đơn hàng không hợp lệ.");
    const previous = status === "confirmed" ? ["pending"] : status === "shipping" ? ["confirmed"] : status === "completed" ? ["shipping"] : ["pending", "confirmed"];
    const previousSql = previous.map(() => "?").join(",");
    const result = user.role === "staff"
      ? await env.DB.prepare(`UPDATE orders SET status=? WHERE id=? AND assigned_to=? AND status IN (${previousSql}) RETURNING id`).bind(status, orderMatch[1], user.id, ...previous).first()
      : await env.DB.prepare(`UPDATE orders SET status=? WHERE id=? AND status IN (${previousSql}) RETURNING id`).bind(status, orderMatch[1], ...previous).first();
    if (!result) return fail(409, "INVALID_ORDER_TRANSITION", "Không tìm thấy đơn hoặc trạng thái không cho phép thao tác này.");
    if (status === "cancelled") {
      const items = await env.DB.prepare("SELECT product_id,quantity FROM order_items WHERE order_id=?").bind(orderMatch[1]).all();
      for (const item of items.results || []) await env.DB.prepare("UPDATE products SET stock=stock+?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(item.quantity, item.product_id).run();
    }
    await env.DB.prepare("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id) VALUES (?,?, 'order.status','order',?)").bind(ID(), user.id, orderMatch[1]).run();
    return json({ ok: true });
  }

  const assignmentMatch = path.match(/^\/api\/admin\/orders\/([\w-]+)\/assignment$/);
  if (assignmentMatch && method === "PATCH") {
    if (!user || !ADMIN_ROLES.has(user.role)) return fail(user ? 403 : 401, "FORBIDDEN", "Chỉ quản trị viên mới được phân công đơn hàng.");
    const staffId = cleanText(body.staff_id, 80);
    const staff = await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='staff' AND status='active'").bind(staffId).first();
    if (!staff) return fail(422, "INVALID_STAFF", "Tài khoản nhân viên không hợp lệ.");
    const order = await env.DB.prepare("UPDATE orders SET assigned_to=? WHERE id=? RETURNING id").bind(staffId, assignmentMatch[1]).first();
    if (!order) return fail(404, "NOT_FOUND", "Không tìm thấy đơn hàng.");
    await env.DB.prepare("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id) VALUES (?,?, 'order.assign','order',?)").bind(ID(), user.id, assignmentMatch[1]).run();
    return json({ ok: true });
  }

  if (path === "/api/admin/users" && method === "GET") {
    if (!user || !ADMIN_ROLES.has(user.role)) return fail(user ? 403 : 401, "FORBIDDEN", "Bạn không có quyền xem tài khoản.");
    const rows = await env.DB.prepare("SELECT id,email,name,role,status,created_at FROM users ORDER BY created_at DESC LIMIT 200").all();
    return json({ users: rows.results || [] });
  }
  const userMatch = path.match(/^\/api\/admin\/users\/([\w-]+)\/(role|status)$/);
  if (userMatch && method === "PATCH") {
    if (!user || !ADMIN_ROLES.has(user.role)) return fail(user ? 403 : 401, "FORBIDDEN", "Bạn không có quyền quản lý tài khoản.");
    const targetId = userMatch[1];
    if (userMatch[2] === "role") {
      const role = cleanText(body.role, 20);
      if (!["member", "staff", "editor", "admin"].includes(role) || (role === "admin" && user.role !== "owner")) return fail(403, "FORBIDDEN", "Vai trò yêu cầu owner hoặc không hợp lệ.");
      if (targetId === user.id && user.role === "owner") return fail(409, "OWNER_PROTECTED", "Không thể thay đổi vai trò của chính mình.");
      const updated = await env.DB.prepare("UPDATE users SET role=? WHERE id=? AND role!='owner' RETURNING id").bind(role, targetId).first();
      if (!updated) return fail(404, "NOT_FOUND", "Không tìm thấy tài khoản hoặc tài khoản owner được bảo vệ.");
      await env.DB.prepare("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id) VALUES (?,?, 'user.role','user',?)").bind(ID(), user.id, targetId).run();
      return json({ ok: true });
    }
    const status = cleanText(body.status, 20);
    if (!["active", "blocked"].includes(status)) return fail(422, "VALIDATION_ERROR", "Trạng thái không hợp lệ.");
    const updated = await env.DB.prepare("UPDATE users SET status=? WHERE id=? AND role!='owner' RETURNING id").bind(status, targetId).first();
    if (!updated) return fail(404, "NOT_FOUND", "Không tìm thấy tài khoản hoặc tài khoản owner được bảo vệ.");
    await env.DB.prepare("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id) VALUES (?,?, 'user.status','user',?)").bind(ID(), user.id, targetId).run();
    return json({ ok: true });
  }

  if (path === "/api/uploads" && method === "POST") {
    if (!user || !["admin", "owner", "editor"].includes(user.role)) return fail(user ? 403 : 401, "FORBIDDEN", "Bạn không có quyền tải ảnh lên.");
    if (!env.IMAGES) return fail(503, "STORAGE_NOT_CONFIGURED", "R2 chưa được cấu hình.");
    const type = request.headers.get("content-type") || "";
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return fail(415, "INVALID_FILE_TYPE", "Chỉ hỗ trợ ảnh JPEG, PNG, WebP hoặc GIF.");
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 5 * 1024 * 1024) return fail(413, "FILE_TOO_LARGE", "Ảnh tối đa 5 MB.");
    const file = await readBounded(request.body, 5 * 1024 * 1024);
    if (file === false) return fail(413, "FILE_TOO_LARGE", "Ảnh tối đa 5 MB.");
    if (!file || file.byteLength === 0) return fail(400, "INVALID_FILE_SIZE", "Ảnh phải có dung lượng từ 1 byte đến 5 MB.");
    const signature = new Uint8Array(file, 0, Math.min(file.byteLength, 12));
    const signatures = {
      "image/jpeg": signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff,
      "image/png": [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((n,i) => signature[i] === n),
      "image/gif": signature[0] === 0x47 && signature[1] === 0x49 && signature[2] === 0x46 && signature[3] === 0x38,
      "image/webp": signature[0] === 0x52 && signature[1] === 0x49 && signature[2] === 0x46 && signature[3] === 0x46 && signature[8] === 0x57 && signature[9] === 0x45 && signature[10] === 0x42 && signature[11] === 0x50
    };
    if (!signatures[type]) return fail(415, "INVALID_FILE_CONTENT", "Nội dung tệp không khớp định dạng ảnh đã chọn.");
    const key = `${new Date().toISOString().slice(0, 10)}/${ID()}`;
    const object = await env.IMAGES.put(key, file, { httpMetadata: { contentType: type } });
    const url = new URL(request.url); url.pathname = `/api/images/${key}`;
    await env.DB.prepare("INSERT INTO audit_logs (id,actor_id,action,target_type,target_id) VALUES (?,?, 'image.upload','r2_object',?)").bind(ID(), user.id, key).run();
    return json({ key, url: url.toString(), size: object.size }, 201);
  }
  if (path.startsWith("/api/images/") && method === "GET") {
    if (!env.IMAGES) return fail(503, "STORAGE_NOT_CONFIGURED", "R2 chưa được cấu hình.");
    const key = decodeURIComponent(path.slice("/api/images/".length));
    if (!key || key.includes("..")) return fail(400, "INVALID_KEY", "Object key không hợp lệ.");
    const object = await env.IMAGES.get(key);
    if (!object) return fail(404, "NOT_FOUND", "Không tìm thấy ảnh.");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("x-content-type-options", "nosniff");
    return new Response(object.body, { headers });
  }

  return fail(404, "NOT_FOUND", "Không tìm thấy API.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try { return await api(request, env); }
    catch (error) {
      console.error("API error", error instanceof Error ? error.message : "unknown");
      return fail(500, "INTERNAL_ERROR", "Đã có lỗi máy chủ. Vui lòng thử lại.");
    }
  }
};
