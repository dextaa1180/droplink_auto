# Tuna Droplink Telegram Bot

Bot Telegram untuk auto-shortener link lewat API Droplink.co.

## Fitur

- Menu tombol Telegram: `Shorten Link`, `TeraBox Pro`, `Dashboard TeraBox`, dan `Bantuan`.
- Auto deteksi URL dari pesan teks dan caption.
- Command `/short <url>` untuk shorten manual.
- Alias custom: `/short https://example.com nama-alias` atau `/short https://example.com alias=nama-alias`.
- Mode `/terabox_pro <url>` untuk fitur TeraBox Pro lewat API provider seperti xAPIverse.
- Dashboard session TeraBox pribadi: login QR, cek status, dan putus session melalui Puppeteer lokal atau endpoint resmi/authorized.
- Bisa dibatasi hanya user/chat tertentu lewat `ALLOWED_USER_IDS` dan `ALLOWED_CHAT_IDS`.
- Long polling, jadi tidak perlu webhook.

## Setup

1. Buat bot di Telegram lewat `@BotFather`, lalu ambil token bot.
2. Ambil API key Droplink di dashboard Droplink: `Tools` -> `API`.
3. Salin konfigurasi:

```powershell
Copy-Item .env.example .env
```

4. Isi `.env`:

```env
TELEGRAM_BOT_TOKEN=token_bot_telegram
DROPLINK_API_KEY=api_key_droplink
```

5. Jalankan bot:

```powershell
npm start
```

## Konfigurasi

`TELEGRAM_BOT_TOKEN` wajib. Token dari `@BotFather`.

`DROPLINK_API_KEY` wajib. API key akun Droplink.

`DROPLINK_BASE_URL` opsional. Default `https://droplink.co`.

`ALLOWED_USER_IDS` opsional. Kosong berarti semua user boleh pakai. Isi beberapa ID dengan koma, contoh:

```env
ALLOWED_USER_IDS=123456789,987654321
```

`ALLOWED_CHAT_IDS` opsional. Berguna untuk grup/channel tertentu. Isi beberapa ID dengan koma.

`MAX_URLS_PER_MESSAGE` opsional. Default `5`.

`REQUEST_TIMEOUT_MS` opsional. Default `15000`.

`TERABOX_RESHARE_API_URL` opsional. Endpoint API untuk fitur TeraBox Pro. Untuk xAPIverse TeraBox Pro, isi:

```env
TERABOX_RESHARE_API_URL=https://xapiverse.com/api/terabox-pro
TERABOX_RESHARE_API_KEY=api_key_xapiverse_kamu
TERABOX_RESHARE_API_KEY_HEADER=xAPIverse-Key
```

Bot akan mengirim request:

```http
POST TERABOX_RESHARE_API_URL
Content-Type: application/json
xAPIverse-Key: TERABOX_RESHARE_API_KEY

{"url":"https://1024terabox.com/s/xxxxx"}
```

Response xAPIverse yang didukung:

```json
{
  "status": "success",
  "total_files": 1,
  "list": [
    {
      "name": "video_example.mp4",
      "size_formatted": "41.16 MB",
      "normal_dlink": "https://api.iteraplay.com/download?token=...",
      "zip_dlink": "https://api.iteraplay.com/download?token=...",
      "fast_stream_url": {
        "720p": "https://api.iteraplay.com/fast_stream?token=..."
      }
    }
  ]
}
```

Bot juga masih mendukung response lama berbentuk `shareUrl` jika nanti kamu memakai endpoint lain yang benar-benar membuat link share baru.

`TERABOX_RESHARE_API_KEY` opsional. Untuk xAPIverse, isi API key dari dashboard xAPIverse.

`TERABOX_RESHARE_API_KEY_HEADER` opsional. Default `xAPIverse-Key`.

`TERABOX_RESHARE_REQUIRE_SESSION` opsional. Isi `true` jika endpoint re-share wajib memakai session yang sudah terhubung dari dashboard.

`TERABOX_DASHBOARD_USER_IDS` opsional. Batasi dashboard session TeraBox untuk user tertentu. Kosong berarti mengikuti `ALLOWED_USER_IDS`; kalau keduanya kosong, semua user yang chat private ke bot bisa membuka dashboard.

`TERABOX_SESSION_START_API_URL` opsional. Endpoint resmi/authorized untuk membuat session login QR. Bot mengirim:

```http
POST TERABOX_SESSION_START_API_URL
Content-Type: application/json

{
  "action": "start",
  "telegramUserId": "123456789",
  "telegramChatId": "123456789",
  "username": "username",
  "firstName": "Nama",
  "lastName": ""
}
```

Response yang didukung:

```json
{
  "status": "pending",
  "sessionId": "safe-session-id",
  "qrImageUrl": "https://domain-api-kamu/qr/session.png",
  "loginUrl": "https://domain-login-resmi/authorize",
  "expiresAt": "2026-05-11T12:00:00Z"
}
```

`TERABOX_SESSION_STATUS_API_URL` opsional. Endpoint cek status session. Bot mengirim `sessionId`, `telegramUserId`, dan `telegramChatId`.

Response yang didukung:

```json
{
  "status": "connected",
  "sessionId": "safe-session-id",
  "accountName": "Nama Akun",
  "accountEmail": "user@example.com",
  "expiresAt": "2026-06-11T12:00:00Z"
}
```

`TERABOX_SESSION_DISCONNECT_API_URL` opsional. Endpoint untuk mencabut session. Jika kosong, bot hanya menghapus metadata session lokal.

`TERABOX_SESSION_API_KEY` opsional. Jika diisi, bot mengirim header `Authorization: Bearer ...` dan `x-api-key` ke endpoint session.

`TERABOX_LOGIN_PUPPETEER_ENABLED` opsional. Default `true`. Jika `TERABOX_SESSION_START_API_URL` kosong, tombol `Login TeraBox` memakai browser Puppeteer lokal untuk membuka halaman login, mengambil screenshot QR, dan menyimpan session setelah QR berhasil discan.

`TERABOX_LOGIN_URL` opsional. URL halaman login QR TeraBox. Default sudah diisi di `.env.example`.

`TERABOX_LOGIN_TIMEOUT_MS` opsional. Default `180000` atau 3 menit.

`TERABOX_LOGIN_HEADLESS` opsional. Default `true`. Isi `false` saat debugging di komputer desktop kalau ingin melihat browsernya.

`PUPPETEER_EXECUTABLE_PATH` opsional. Isi path Chrome/Chromium custom kalau Puppeteer bawaan tidak bisa dipakai di server.

`DATA_DIR` opsional. Default `data`. Bot menyimpan metadata session lokal di `data/terabox-sessions.json`; file ini diabaikan Git.

## Cara Pakai

Mulai dengan menu tombol:

```text
/start
/menu
```

Kirim link langsung ke bot:

```text
https://example.com/artikel-panjang
```

Atau pakai command:

```text
/short https://example.com/artikel-panjang
/short https://example.com/artikel-panjang my-alias
/short https://example.com/artikel-panjang alias=my-alias
```

Untuk TeraBox:

```text
/terabox_pro https://1024terabox.com/s/xxxxx
/terabox https://1024terabox.com/s/xxxxx
/terabox_dashboard
/terabox_login
/terabox_connect
/terabox_status
/terabox_logout
```

Atau klik tombol `TeraBox Pro`, lalu kirim link TeraBox.

Untuk dashboard session pribadi, klik `Dashboard TeraBox`, lalu pilih `Login TeraBox`. Jika `TERABOX_SESSION_START_API_URL` diisi, bot memakai endpoint itu. Jika kosong, bot membuka login TeraBox via Puppeteer, mengirim QR ke chat private, lalu menyimpan session setelah QR discan.

Bot akan membalas dengan link pendek dari Droplink.

Untuk grup, matikan `Privacy Mode` bot lewat `@BotFather` jika ingin bot membaca semua pesan berisi link.

## Update di VPS

Jika bot sudah berjalan dengan PM2:

```bash
cd /root/droplink_auto
git pull
pm2 restart droplink-auto
pm2 save
```

## Catatan Keamanan

Simpan API key hanya di `.env`. Jangan kirim API key ke chat Telegram atau commit file `.env`.

Untuk login via Puppeteer, bot menyimpan cookie session `ndus` sebagai `sessionId` lokal. Batasi dashboard dengan `TERABOX_DASHBOARD_USER_IDS` dan jangan commit isi folder `data`.

Fitur `TeraBox Pro` dengan xAPIverse menghasilkan metadata, download link, dan stream link. Itu bukan endpoint resmi untuk memindahkan file ke akun TeraBox kamu atau membuat share link baru dari akun kamu.

Dashboard session hanya kerangka integrasi ke API resmi/authorized milikmu. Gunakan hanya untuk file yang kamu miliki atau punya izin untuk salin dan share ulang.
