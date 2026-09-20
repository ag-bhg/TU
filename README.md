# Buku Tamu Digital

Aplikasi pencatatan tamu undangan + sumbangan, jalan di GitHub Pages + Firebase.

Versi ini dirancang untuk kecepatan di HP:
- **Login 1 pintu** — kode akses QR, username, atau email ADM, semua lewat satu kolom.
- **Input cepat** — ketik nama → alamat → nominal → Enter, langsung simpan & siap ketik tamu berikutnya.
- **Tabel ala Excel** — ketuk sel langsung edit, tersimpan otomatis (realtime), ada total sumbangan.
- **Tahan offline** — cache Firestore membuat input tetap jalan walau koneksi putus-nyambung.

File:
- `index.html` — kerangka halaman
- `style.css` — tampilan
- `app.js` — logika aplikasi
- `index-versi-lama.html` — arsip versi satu-file sebelumnya

Login: situs ini memakai Firebase Auth (email/password + anonim). Scan QR membuka
halaman dengan `?akses=KODE` dan masuk otomatis sebagai petugas (sesi 36 jam).
