🎵 Project Status: Self-Hosted Music Player
Lần cập nhật cuối: 2026-10-06
Trạng thái tổng thể: MVP thư viện/player và quản lý nhạc local đã hoạt động; LAN launcher/config đã sẵn sàng, Authentication và hardening trước khi mở truy cập từ xa còn pending.

1. 📊 Tổng Quan Tiến Độ (Executive Summary)
Mục tiêu dự án: Xây dựng ứng dụng nghe nhạc cá nhân self-hosted với backend API + frontend player, hỗ trợ stream nhạc Lossless/Hi-Res (FLAC, ALAC, WAV) mượt mà trên trình duyệt/iPhone, bảo mật bằng tài khoản cá nhân và tích hợp các tính năng quản lý thư viện chuyên nghiệp.

Tiến độ tổng thể: Khoảng 85% hoàn thành (ước lượng theo checklist; các tính năng thư viện/UI chính đã xong, Auth và triển khai production còn thiếu).

Thành tựu chính đã đạt được:

Backend quét kho nhạc trong backend/storage/uploads, đọc metadata kỹ thuật và trả về JSON thực tế.

Streaming engine direct stream hỗ trợ Range/206 theo chunk; ALAC M4A được FFmpeg chuyển mã FLAC on-the-fly để phát trên Chromium.

Frontend có sidebar 5 tab, Request Song modal, playlist/favorite controls, queue và player responsive.

Collab artist được map vào từng nghệ sĩ; requests, playlists, favorites lưu local bằng JSON.

2. 📝 Checklist Trạng Thái Chi Tiết (Detailed Checklist)
📂 Cấu Trúc & Kiến Trúc Dự Án
[x] Tách biệt thư mục frontend/ và backend/

[x] Cấu hình biến môi trường (.env.example)

[x] File docker-compose.yml tổng

[x] Lưu trữ dữ liệu Local JSON (backend/storage/data/requests.json, playlists.json, favorites.json)

🔐 Bảo Mật & Xác Thực (Authentication & Security)
[ ] API Đăng nhập / Đăng xuất (POST /api/auth/login, POST /api/auth/logout)

[ ] Bảo mật bằng JWT (JSON Web Token) hoặc Session Cookie

[ ] Giao diện màn hình Đăng nhập (Login Modal / Page)

[ ] Phân quyền người dùng (Admin vs Guest Request)

⚙️ Backend & API Service
[x] Khởi tạo Server & Cấu hình CORS

[~] Scanner đọc Title/Artist/Album và thông số kỹ thuật qua Mutagen; cover hiện chỉ tìm sidecar JPG/JPEG/PNG, chưa trích embedded art

[x] Thuật toán tách Artist Collab (`,`, `&`, `ft.`, `feat.`, `x`, `/`, `VS.`) và đưa track vào tất cả artist liên quan

[x] Streaming Engine (Hỗ trợ HTTP 206 Range Headers để tua nhạc)

[x] Tối ưu hóa Stream bằng Buffer (Không ngốn RAM)

[x] APIs requests/artists/playlists/favorites; endpoint quality và cover cũng có

[~] Albums được nhóm từ song/album tags ở Frontend; chưa có endpoint riêng `/api/albums`

[x] FFmpeg binary từ PATH hoặc imageio-ffmpeg; thiếu binary sẽ log cảnh báo và trả 503

🎨 Frontend & User Interface
[x] Giao diện Web Player chính (Layout, Player Bar)

[x] Nút điều khiển (Play, Pause, Next, Prev, Seekbar, Volume)

[x] Nút "Request Song" & Modal biểu mẫu yêu cầu bài hát (đã bỏ Add/Drop music)

[x] Tái cấu trúc Sidebar Navigation Tabs:

[x] Tab Library (Sắp xếp bài hát A-Z)

[x] Tab Artists (Album + Bài hát của nghệ sĩ, hỗ trợ collab)

[x] Tab Albums (Grid Album + bài hát bên trong)

[x] Tab Playlists (Tạo, xóa, thêm/xóa track, kéo-thả sắp xếp)

[x] Tab Favorites (Track, Album, Playlist, Artist)

[x] Hệ thống Quản lý Hàng chờ Phát (Play Queue System):

[x] Nút "Ẩn bài khỏi lượt phát hiện tại" (chỉ xóa khỏi currentQueue)

[x] Nút "Trộn bài" (Shuffle) & "Phát ngẫu nhiên" (Random)

🚀 Triển Khai & Mạng (Deployment)
[~] Backend có Dockerfile; Frontend hiện được serve bằng Python HTTP server trong docker-compose, chưa có Dockerfile riêng

[~] Chưa xác nhận kết nối từ thiết bị LAN/iPhone thật hoặc Windows Firewall trên mạng của người dùng

[ ] Cấu hình Cloudflare Tunnel / Reverse Proxy / Tailscale VPN cho kết nối từ xa

3. ⚠️ Các Lỗi / Rủi Ro Kỹ Thuật Đã Phát Hiện (Known Issues & Tech Debts)

Chưa có Authentication/Authorization: requests, playlists, favorites và thư viện hiện không yêu cầu đăng nhập. Không mở backend ra Internet/Cloudflare Tunnel trước khi có xác thực, phân quyền và giới hạn request.

ALAC on-the-fly FLAC không hỗ trợ seek: output transcoded là stream không biết trước Content-Length nên nhánh ALAC trả 200 và không hỗ trợ Range; FLAC/MP3/WAV direct stream vẫn hỗ trợ 206.

Metadata/cover chưa đầy đủ: Mutagen đọc title/artist/album và thông số kỹ thuật, nhưng chưa trích ảnh embedded; cover hiện chỉ hỗ trợ sidecar JPG/JPEG/PNG. Duration trong danh sách scan vẫn là 0 và được lấy từ HTMLAudio khi phát.

Chưa có endpoint riêng `/api/albums`: album được gom từ trường album của `/api/songs` ở Frontend.

JSON persistence phù hợp cho self-hosted single instance; chưa có backup/restore, audit log hoặc đồng bộ khóa giữa nhiều process/container.

LAN URL cần dùng `http://<IPv4-LAN>:8080` (hoặc localhost/127.0.0.1 trên host). `0.0.0.0` chỉ là địa chỉ bind để lắng nghe trên mọi interface, không phải địa chỉ hợp lệ để mở trong trình duyệt; truy cập `http://0.0.0.0:8080` sẽ báo `ERR_ADDRESS_INVALID`.

4. 🎯 Kế Hoạch Hành Động Tiếp Theo (Next Action Items)
[Ưu tiên 1] Thêm Authentication/Authorization (session hoặc JWT), phân quyền Admin/Guest và bảo vệ Request API trước khi mở truy cập từ xa.

[Ưu tiên 2] Hardening API: validate/rate-limit requests, cấu hình CORS theo origin tin cậy, backup/restore JSON và xử lý chạy nhiều worker.

[Ưu tiên 3] Hoàn thiện metadata: duration trong scan, embedded album art và endpoint `GET /api/albums`.

[Ưu tiên 4] Thêm Dockerfile Frontend riêng và kiểm thử Docker Compose end-to-end.

[Ưu tiên 5] Chỉ sau khi hoàn thành Auth + hardening mới cấu hình Cloudflare Tunnel / Tailscale để nghe nhạc từ xa.

[Ưu tiên 6] Chạy lại unittest suite trong terminal CI ổn định; browser/API smoke test đã kiểm tra các luồng request, playlist, favorites, artist collab và playback.

[LAN test tiếp theo] Chạy `local_network_run.bat`, dùng đúng IPv4 LAN mà script in ra trên iPhone/máy khác cùng Wi-Fi; nếu không kết nối được, kiểm tra profile Private và inbound TCP ports 5000/8080 trong Windows Defender Firewall.