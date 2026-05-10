# Tuna Droplink Telegram Bot

Bot Telegram untuk auto-shortener link lewat API Droplink.co.

## Fitur

- Auto deteksi URL dari pesan teks dan caption.
- Command `/short <url>` untuk shorten manual.
- Alias custom: `/short https://example.com nama-alias` atau `/short https://example.com alias=nama-alias`.
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

## Cara Pakai

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

Bot akan membalas dengan link pendek dari Droplink.

Untuk grup, matikan `Privacy Mode` bot lewat `@BotFather` jika ingin bot membaca semua pesan berisi link.

## Catatan Keamanan

Simpan API key hanya di `.env`. Jangan kirim API key ke chat Telegram atau commit file `.env`.
