# Buku Tamu Digital

Struktur diubah dari `index.html` + `Adms/index.html` menjadi 4 halaman terpisah, semua di folder root:

```
login.html    → satu pintu masuk (kode QR / username / email ADM Utama)
admin.html    → ADM Utama: kelola akun, kuota, buat QR petugas, lihat semua lembar, log aktivitas
admins.html   → ADM Sementara (petugas lapangan): input tamu cepat via QR, kelola data yang ia input sendiri
user.html     → Pemilik akun: melihat HASIL daftar tamu lengkap secara real-time
                (termasuk yang dikerjakan ADM Sementara), edit/status/ekspor
js/
  common.js   → kode bersama: Firebase init, util, penjaga peran, dialog, menu konteks
  login.js    → logika login.html
  admin.js    → logika admin.html
  admins.js   → logika admins.html
  user.js     → logika user.html
style.css     → gaya bersama (tidak berubah)
```

## Alur

- **login.html** membaca satu kolom: kode QR 8 karakter → diteruskan ke `admins.html`;
  username+password → masuk sebagai pemilik akun (`user.html`); email+password → ADM Utama (`admin.html`).
- Tautan QR yang dibuat ADM Utama selalu mengarah ke `admins.html?akses=...`.
- Data Firestore **tidak berubah** dari versi sebelumnya (`akun_user`, `akun_user/{uid}/tamu`, `qr_tokens`,
  `adm_sementara_akses`, `log_adm_sementara`, `adm_utama`), jadi tidak perlu migrasi data.
- `index-versi-lama.html` disertakan sebagai arsip/referensi versi sebelum sistem dipisah 4 halaman; tidak
  dipakai oleh halaman lain dan aman dihapus.

## Unggah ke GitHub Pages

Unggah seluruh isi folder ini (login.html, admin.html, admins.html, user.html, js/, style.css) ke root
repository, lalu aktifkan GitHub Pages seperti biasa.
