/* Buku Tamu Digital — kode bersama semua halaman
   (login.html, admin.html, admins.html, user.html).
   Dimuat SETELAH SDK Firebase; menyediakan objek global `BT`.

   Struktur data Firestore SAMA dengan versi sebelumnya:
   akun_user/{uid}, akun_user/{uid}/tamu/{id}, qr_tokens/{kode},
   adm_sementara_akses/{uid}, log_adm_sementara/{id}, adm_utama/{uid} */
(function(){
'use strict';

const firebaseConfig = {
  apiKey: "AIzaSyAmkwpGeqhRdMWrQPa_ahW_gJ27cQ4DZIo",
  authDomain: "buku-tamu-digital-4df8b.firebaseapp.com",
  projectId: "buku-tamu-digital-4df8b",
  storageBucket: "buku-tamu-digital-4df8b.firebasestorage.app",
  messagingSenderId: "308793150877",
  appId: "1:308793150877:web:f05f75dbe7b4619b9ab374"
};

if(!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Cache offline: input tetap jalan walau koneksi putus-nyambung di lokasi acara
try{ db.enablePersistence({synchronizeTabs:true}).catch(()=>{}); }catch(e){}

const EMAIL_DOMAIN = '@tamu-undangan.local';

// Peta halaman. Semua file ada di folder yang sama.
const HALAMAN = {
  login: 'login.html',
  admin: 'admin.html',     // ADM Utama
  petugas: 'admins.html',  // ADM Sementara: input & pengelolaan data
  user: 'user.html'        // pemilik akun: melihat hasil daftar tamu
};
function halamanRole(role){
  if(role === 'adm_utama') return HALAMAN.admin;
  if(role === 'akun_user') return HALAMAN.user;
  return HALAMAN.login;
}

window.addEventListener('error', (e) => { console.error('Error:', e.message); });
window.addEventListener('unhandledrejection', (e) => { console.error('Promise error:', e.reason); });

// ================= UTIL =================
function fmtRp(n){
  n = Number(n||0);
  return "Rp " + n.toLocaleString('id-ID');
}
function fmtWaktu(ts){
  if(!ts) return '-';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('id-ID', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function randomToken(len){
  len = len || 8;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for(let i = 0; i < len; i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showMsg(container, text, type, durasi){
  const el = document.createElement('div');
  el.className = 'msg ' + (type || 'error');
  el.textContent = text;
  container.prepend(el);
  setTimeout(() => el.remove(), durasi || 6000);
}
function pesanError(e){
  const code = e && e.code ? e.code : '';
  if(code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation')
    return 'Login anonim belum diaktifkan. Di Firebase Console > Authentication > Sign-in method, aktifkan penyedia "Anonymous".';
  if(code === 'auth/too-many-requests')
    return 'Firebase memblokir sementara perangkat ini karena terlalu banyak percobaan. Tunggu beberapa menit (bisa sampai 1 jam) atau coba lewat jaringan berbeda.';
  if(code === 'auth/network-request-failed')
    return 'Koneksi ke server login terblokir (biasanya Brave Shields). Matikan Shields untuk situs ini atau pakai Chrome.';
  if(code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-credential')
    return 'Username / email atau password salah.';
  if(code === 'permission-denied')
    return 'Akses ditolak database (security rules). Minta ADM Utama memeriksa rules Firestore.';
  return (e && e.message) ? e.message : 'Terjadi kesalahan.';
}

// ===== INDIKATOR LOADING: blokir seluruh sentuhan saat proses berjalan =====
let busyFailsafeTimer = null;
function mulaiBusy(teks){
  let ov = document.getElementById('busyOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'busyOverlay';
    ov.className = 'busy-overlay';
    ov.innerHTML = '<div class="busy-box"><div class="busy-spinner"></div><div class="busy-text"></div></div>';
    document.body.appendChild(ov);
  }
  ov.querySelector('.busy-text').textContent = teks || 'Memproses…';
  ov.hidden = false;
  document.body.classList.add('busy');
  // Jaring pengaman: bila proses menggantung, overlay dilepas otomatis.
  clearTimeout(busyFailsafeTimer);
  busyFailsafeTimer = setTimeout(() => {
    console.warn('Overlay loading melebihi 45 detik — dilepas otomatis.');
    selesaiBusy();
  }, 45000);
}
function selesaiBusy(){
  clearTimeout(busyFailsafeTimer);
  const ov = document.getElementById('busyOverlay');
  if(ov) ov.hidden = true;
  document.body.classList.remove('busy');
}

// ===== MENU KONTEKS ala klik-kanan Windows (teks saja) =====
let ctxMenuEl = null;
function tutupMenuKonteks(){
  if(ctxMenuEl){ ctxMenuEl.remove(); ctxMenuEl = null; }
}
document.addEventListener('click', (e) => {
  // Handler pembuka menu memanggil stopPropagation(), jadi ketukan yang
  // MEMBUKA menu tidak sampai ke sini (kalau sampai, menu langsung menutup).
  if(ctxMenuEl && !ctxMenuEl.contains(e.target)) tutupMenuKonteks();
});
window.addEventListener('scroll', tutupMenuKonteks, true);
function tampilkanMenuKonteks(x, y, item){
  tutupMenuKonteks();
  const m = document.createElement('div');
  m.className = 'ctx-menu';
  item.forEach((it) => {
    if(it === '-'){
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      m.appendChild(sep);
      return;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.bahaya ? ' bahaya' : '');
    b.textContent = it.label;
    b.onclick = (ev) => { ev.stopPropagation(); tutupMenuKonteks(); it.aksi(); };
    m.appendChild(b);
  });
  document.body.appendChild(m);
  const rect = m.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  m.style.left = Math.max(8, px) + 'px';
  m.style.top = Math.max(8, py) + 'px';
  ctxMenuEl = m;
}

// ===== DIALOG EDIT =====
// onSimpan(nilai) dijalankan setelah dialog ditutup; error-nya ditampilkan lewat wadahPesan.
function bukaDialogEdit(opsi){
  const judul = opsi.judul, fields = opsi.fields, onSimpan = opsi.onSimpan;
  const wadahPesan = opsi.wadahPesan || document.getElementById('app') || document.body;
  const dlg = document.createElement('div');
  dlg.className = 'edit-dialog';
  const formHtml = fields.map(f => `
    <label>${f.label}</label>
    <input type="text" data-ef="${f.key}" value="${esc(f.nilai)}" ${f.numerik?'inputmode="numeric" style="text-align:right;"':''}>
  `).join('');
  dlg.innerHTML = `
    <div class="edit-box">
      <h3>${esc(judul)}</h3>
      ${formHtml}
      <div class="edit-actions">
        <button class="btn-outline" data-batal>Batal</button>
        <button class="btn-primary" data-simpan>Simpan</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  const inputs = dlg.querySelectorAll('input[data-ef]');
  if(inputs[0]) inputs[0].focus();
  dlg.querySelector('[data-batal]').onclick = () => dlg.remove();
  dlg.addEventListener('keydown', e => { if(e.key === 'Escape') dlg.remove(); });
  dlg.querySelector('[data-simpan]').onclick = async () => {
    const nilai = {};
    inputs.forEach(inp => {
      const k = inp.dataset.ef;
      const angka = (k === 'rp' || k === 'kuota_total');
      nilai[k] = angka ? (parseInt(inp.value.replace(/[^0-9]/g,''),10)||0) : inp.value.trim();
    });
    dlg.remove();
    mulaiBusy('Menyimpan perubahan…');
    try{
      await onSimpan(nilai);
    }catch(e){
      showMsg(wadahPesan, 'Gagal menyimpan: ' + (e.message||e));
    }finally{
      selesaiBusy();
    }
  };
}

// ===== UNDUH CSV (kompatibel Excel) =====
// baris: array of array. Pemisah titik-koma + BOM UTF-8 agar Excel Indonesia membukanya rapi.
function unduhCsv(namaBerkas, baris){
  const kutip = (v) => '"' + String(v==null ? '' : v).replace(/"/g,'""') + '"';
  const isi = baris.map(r => r.map(kutip).join(';')).join('\r\n');
  const blob = new Blob(['\uFEFF' + isi], {type: 'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = namaBerkas + '-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ================= PERAN & PENJAGA HALAMAN =================
// Kembalikan {role, data, error}. role: 'adm_utama' | 'akun_user' | null.
async function cekRole(user){
  try{
    const adm = await db.collection('adm_utama').doc(user.uid).get();
    if(adm.exists) return {role: 'adm_utama', data: adm.data(), error: null};
    const usr = await db.collection('akun_user').doc(user.uid).get();
    if(usr.exists) return {role: 'akun_user', data: usr.data(), error: null};
    return {role: null, data: null, error: null};
  }catch(e){
    console.warn('Cek role gagal:', e.message);
    return {role: null, data: null, error: e};
  }
}

// Dipasang di admin.html & user.html. Bukan login / bukan peran yang cocok -> dialihkan.
function jagaHalaman(peranDiizinkan, onSiap){
  let siapUid = null;
  auth.onAuthStateChanged(async (user) => {
    if(!user || user.isAnonymous){ window.location.replace(HALAMAN.login); return; }
    if(siapUid === user.uid) return;
    const r = await cekRole(user);
    if(!r.role){ window.location.replace(HALAMAN.login); return; }
    if(peranDiizinkan.indexOf(r.role) === -1){ window.location.replace(halamanRole(r.role)); return; }
    siapUid = user.uid;
    onSiap(user, r.role, r.data);
  });
}

async function keluar(sebelum){
  try{ if(sebelum) await sebelum(); }catch(e){}
  try{ await auth.signOut(); }catch(e){}
  window.location.replace(HALAMAN.login);
}

// ================= SESI PETUGAS (ADM Sementara) =================
// Disimpan di sessionStorage + cadangan localStorage. Dipakai login.html & admins.html.
const SESI_KEY = {token: 'adm_sementara_token', uid: 'adm_sementara_uid', nama: 'adm_sementara_nama'};
function bacaSesiPetugas(){
  function ambil(k){
    let v = null;
    try{ v = sessionStorage.getItem(k); }catch(e){}
    if(!v){ try{ v = localStorage.getItem(k); }catch(e){} }
    return v;
  }
  const token = ambil(SESI_KEY.token), uid = ambil(SESI_KEY.uid);
  if(!token || !uid) return null;
  return {tokenId: token, uid: uid, nama: ambil(SESI_KEY.nama) || ''};
}
function simpanSesiPetugas(tokenId, uid, nama){
  sessionStorage.setItem(SESI_KEY.token, tokenId);
  sessionStorage.setItem(SESI_KEY.uid, uid);
  if(nama) sessionStorage.setItem(SESI_KEY.nama, nama);
  try{
    localStorage.setItem(SESI_KEY.token, tokenId);
    localStorage.setItem(SESI_KEY.uid, uid);
    if(nama) localStorage.setItem(SESI_KEY.nama, nama);
  }catch(e){}
}
function kunciLokalPetugas(tokenId){ return 'adm_sementara_lokal_' + tokenId; }
function hapusSesiPetugas(tokenIdUntukData){
  sessionStorage.removeItem(SESI_KEY.token);
  sessionStorage.removeItem(SESI_KEY.uid);
  sessionStorage.removeItem(SESI_KEY.nama);
  try{
    localStorage.removeItem(SESI_KEY.token);
    localStorage.removeItem(SESI_KEY.uid);
    localStorage.removeItem(SESI_KEY.nama);
    if(tokenIdUntukData) localStorage.removeItem(kunciLokalPetugas(tokenIdUntukData));
  }catch(e){}
}
function muatEntriesLokalPetugas(tokenId){
  try{
    const raw = localStorage.getItem(kunciLokalPetugas(tokenId));
    return raw ? JSON.parse(raw) : [];
  }catch(e){ return []; }
}
function simpanEntriesLokalPetugas(tokenId, entries){
  try{ localStorage.setItem(kunciLokalPetugas(tokenId), JSON.stringify(entries)); }catch(e){}
}

window.BT = {
  firebaseConfig, auth, db, EMAIL_DOMAIN, HALAMAN, halamanRole,
  fmtRp, fmtWaktu, randomToken, esc, showMsg, pesanError,
  mulaiBusy, selesaiBusy, tampilkanMenuKonteks, tutupMenuKonteks,
  bukaDialogEdit, unduhCsv,
  cekRole, jagaHalaman, keluar,
  SESI_KEY, bacaSesiPetugas, simpanSesiPetugas, hapusSesiPetugas,
  muatEntriesLokalPetugas, simpanEntriesLokalPetugas
};

})();
