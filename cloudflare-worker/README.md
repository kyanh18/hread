# Hướng dẫn tạo Cloudflare Worker cho Kho Truyện (Hoàn toàn Miễn phí)

Worker này đóng vai trò là "cầu nối" (Proxy) giúp app của bạn:
1. Vượt qua lỗi chặn CORS của trình duyệt trên điện thoại.
2. Tự động gắn `Referer: https://hitomi.la/` để tải ảnh chất lượng gốc.
3. Không bị ảnh hưởng bởi việc các nhà mạng Việt Nam chặn DNS của Hitomi.

---

## 🚀 Các bước cài đặt (Mất 2 phút):

1. **Đăng ký / Đăng nhập Cloudflare:**
   - Truy cập: [https://dash.cloudflare.com/](https://dash.cloudflare.com/) (miễn phí 100%, không cần thẻ ngân hàng).

2. **Tạo Worker:**
   - Ở thanh menu bên trái, chọn **Workers & Pages** > Bấm nút **Create application** (hoặc **Create Worker**).
   - Đặt tên cho Worker (ví dụ: `my-hitomi-proxy`).
   - Bấm **Deploy**.

3. **Dán mã nguồn:**
   - Sau khi Deploy, bấm vào nút **Edit code**.
   - Xoá hết mã mẫu mặc định, mở file `worker.js` trong thư mục này và **Copy toàn bộ nội dung dán vào**.
   - Bấm nút **Deploy** ở góc trên bên phải.

4. **Lấy đường link Worker:**
   - Đường link của bạn sẽ có dạng: `https://my-hitomi-proxy.<tên-bạn>.workers.dev`
   - Mở app **Kho Truyện** trên điện thoại > Bấm nút **🌐 Tải online (Hitomi)** > Bấm vào biểu tượng bánh răng ⚙️ (Cài đặt) > Dán đường link Worker của bạn vào là xong!
