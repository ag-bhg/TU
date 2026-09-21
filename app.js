/* Buku Tamu Digital — logika aplikasi
   Struktur data Firestore SAMA dengan versi lama:
   akun_user/{uid}, akun_user/{uid}/tamu/{id}, qr_tokens/{kode},
   adm_sementara_akses/{uid}, log_adm_sementara/{id}, adm_utama/{uid} */
document.addEventListener('DOMContentLoaded', function(){

const firebaseConfig = {
  apiKey: "AIzaSyAmkwpGeqhRdMWrQPa_ahW_gJ27cQ4DZIo",
  authDomain: "buku-tamu-digital-4df8b.firebaseapp.com",
  projectId: "buku-tamu-digital-4df8b",
  storageBucket: "buku-tamu-digital-4df8b.firebasestorage.app",
  messagingSenderId: "308793150877",
  appId: "1:308793150877:web:f05f75dbe7b4619b9ab374"
};

if(firebaseConfig.apiKey === "GANTI_DENGAN_API_KEY"){
  document.getElementById('configWarning').innerHTML =
    '<div class="config-warning">⚠️ <strong>Firebase config belum diisi.</strong></div>';
}

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Cache offline: input tetap jalan walau koneksi putus-nyambung di lokasi acara
try{ db.enablePersistence({synchronizeTabs:true}).catch(()=>{}); }catch(e){}

const EMAIL_DOMAIN = "@tamu-undangan.local";

// ================= STATE =================
let currentUser = null;
let currentRole = null;      // 'adm_utama' | 'akun_user' | 'adm_sementara'
let currentUserData = null;
let admSession = null;
let timerInterval = null;
let onSnapshotUnsub = null;
let cooldownSampai = 0;       // jeda lokal hanya untuk blokir too-many-requests (ms epoch)

const app = document.getElementById('app');
const appHeader = document.getElementById('appHeader');
const whoAmI = document.getElementById('whoAmI');

document.getElementById('btnLogout').onclick = async () => {
  clearInterval(timerInterval);
  if(onSnapshotUnsub){ onSnapshotUnsub(); onSnapshotUnsub = null; }
  hentikanPengawasToken();
  // Keluar = hapus semua jejak sesi petugas di perangkat
  sessionStorage.removeItem('adm_sementara_token');
  sessionStorage.removeItem('adm_sementara_uid');
  sessionStorage.removeItem('adm_sementara_nama');
  try{
    localStorage.removeItem('adm_sementara_token');
    localStorage.removeItem('adm_sementara_uid');
    localStorage.removeItem('adm_sementara_nama');
  }catch(e){}
  admSession = null;
  lembarDilihatUid = null;
  await auth.signOut();
};

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
function randomToken(len=8){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s='';
  for(let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function showMsg(container, text, type='error', durasi=6000){
  const el = document.createElement('div');
  el.className = 'msg ' + type;
  el.textContent = text;
  container.prepend(el);
  setTimeout(()=>el.remove(), durasi);
}
function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  // Jaring pengaman: bila proses menggantung (jaringan mati, promise tak kunjung
  // selesai), overlay dilepas otomatis agar aplikasi tidak terkunci selamanya.
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
  // Klik di luar menu menutupnya. Handler pembuka menu memanggil stopPropagation(),
  // jadi ketukan yang MEMBUKA menu tidak pernah sampai ke sini — tanpa itu menu
  // akan terbuka lalu langsung tertutup oleh ketukan yang sama (tampak tidak respons).
  if(ctxMenuEl && !ctxMenuEl.contains(e.target)) tutupMenuKonteks();
});
window.addEventListener('scroll', tutupMenuKonteks, true);
function tampilkanMenuKonteks(x, y, item){
  tutupMenuKonteks();
  const m = document.createElement('div');
  m.className = 'ctx-menu';
  item.forEach((it, idx) => {
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
  // Jaga menu tetap di dalam layar
  const rect = m.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  m.style.left = Math.max(8, px) + 'px';
  m.style.top = Math.max(8, py) + 'px';
  ctxMenuEl = m;
}

// ===== DIALOG EDIT BARIS =====
function bukaDialogEdit({judul, fields, onSimpan}){
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
      nilai[k] = (k === 'rp') ? (parseInt(inp.value.replace(/[^0-9]/g,''),10)||0) : inp.value.trim();
    });
    dlg.remove();
    mulaiBusy('Menyimpan perubahan…');
    try{
      await onSimpan(nilai);
    }catch(e){
      showMsg(app, 'Gagal menyimpan: ' + (e.message||e));
    }finally{
      selesaiBusy();
    }
  };
}
function pesanErrorAuth(e){
  const code = e && e.code ? e.code : '';
  if(code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation')
    return 'Login anonim belum diaktifkan. Di Firebase Console > Authentication > Sign-in method, aktifkan penyedia "Anonymous".';
  if(code === 'auth/too-many-requests')
    return 'Firebase memblokir sementara perangkat ini karena terlalu banyak percobaan. Tunggu sekitar 1 jam atau coba lewat jaringan berbeda (ganti WiFi/kuota).';
  if(code === 'auth/network-request-failed')
    return 'Koneksi ke server login terblokir (biasanya Brave Shields). Matikan Shields untuk situs ini atau pakai Chrome.';
  if(code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-credential')
    return 'Username / email atau password salah.';
  return (e && e.message) ? e.message : 'Terjadi kesalahan.';
}

// ===== SESI PETUGAS TANPA LOGIN =====
// Sesi disimpan di sessionStorage dengan cadangan localStorage: apa pun yang
// terjadi (reload, browser dimatikan, koneksi putus), perangkat dengan login
// anonim yang masih hidup langsung kembali ke lembar input tanpa login ulang.
let qrSedangProses = false;   // pengaman render ulang listener saat proses QR berjalan
let lembarDilihatUid = null;  // diisi saat ADM Utama membuka lembar akun lain

function simpanSesiPetugas(token, uid, nama){
  sessionStorage.setItem('adm_sementara_token', token);
  sessionStorage.setItem('adm_sementara_uid', uid);
  if(nama) sessionStorage.setItem('adm_sementara_nama', nama);
  try{
    localStorage.setItem('adm_sementara_token', token);
    localStorage.setItem('adm_sementara_uid', uid);
    if(nama) localStorage.setItem('adm_sementara_nama', nama);
  }catch(e){}
}
function bersihkanUrlQr(){
  try{ window.history.replaceState(null, '', window.location.pathname); }catch(e){}
}

// Profil pemilik lembar dibuat OTOMATIS bila belum ada — QR tidak pernah
// menemui "akun belum terdaftar". Sudah ada? satu baca, tanpa perubahan.
let profilDijamin = {};
function ensureProfilPemilik(uid){
  if(!uid) return Promise.resolve();
  if(!profilDijamin[uid]){
    const ref = db.collection('akun_user').doc(uid);
    profilDijamin[uid] = ref.get().then(snap => {
      if(snap.exists) return;
      return ref.set({
        username: 'lembar-' + uid.slice(0,6),
        dibuat_tanggal: firebase.firestore.FieldValue.serverTimestamp(),
        kuota_total: 0,
        kuota_terpakai: 0,
        dibuat_oleh: 'qr-otomatis',
        dibuat_via: 'qr_scan'
      }, {merge:true}).catch(()=>{}); // profil best-effort; yang menentukan rules Firestore
    }).catch(()=>{});
  }
  return profilDijamin[uid];
}

// ================= ROUTING / INIT =================
auth.onAuthStateChanged(async (user) => {
  clearInterval(timerInterval);
  if(onSnapshotUnsub){ onSnapshotUnsub(); onSnapshotUnsub = null; }
  hentikanPengawasToken();

  // QR = tiket masuk: kondisi APA PUN langsung dibawakan ke lembar input,
  // tanpa satu pun langkah login manual.
  // - Perangkat tanpa sesi -> login anonim otomatis + sesi petugas dibuat
  // - Profil pemilik lembar belum ada? dibuat otomatis (ensureProfilPemilik)
  // - QR lama tanpa u= -> pemilik dibaca SEKALI dari DB, tetap tanpa verifikasi
  // - Akun utama yang membuka tautan QR -> lembar tamu pemilik langsung terbuka
  const params = new URLSearchParams(window.location.search);
  const aksesUrl = params.get('akses');
  if(aksesUrl){
    masukQrOtomatis(aksesUrl, params.get('u') || '', params.get('n') || '', user);
    return;
  }

  if(!user){
    currentUser = null; currentRole = null; currentUserData = null; admSession = null;
    appHeader.style.display = 'none';
    renderLogin();
    return;
  }
  currentUser = user;

  if(user.isAnonymous){
    // Sesi petugas dipulihkan dari penyimpanan perangkat — tanpa cek DB.
    // Reload, browser dimatikan, koneksi putus-nyambung: tetap langsung masuk.
    const savedToken = sessionStorage.getItem('adm_sementara_token') || localStorage.getItem('adm_sementara_token');
    const savedUid = sessionStorage.getItem('adm_sementara_uid') || localStorage.getItem('adm_sementara_uid');
    if(savedToken && savedUid){
      const savedNama = sessionStorage.getItem('adm_sementara_nama') || localStorage.getItem('adm_sementara_nama') || '';
      simpanSesiPetugas(savedToken, savedUid, savedNama);
      ensureProfilPemilik(savedUid); // best-effort, tidak menahan render
      // Pastikan dokumen akses sesi tetap ada juga saat pemulihan sesi
      // (bila rules menuntutnya untuk menulis tamu).
      try{
        await db.collection('adm_sementara_akses').doc(user.uid).set({
          terikat_ke_userId: savedUid,
          token_id: savedToken,
          expired_at: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 36*60*60*1000))
        });
      }catch(e){ console.warn('Catatan akses (restore) gagal:', e.code || e.message); }
      currentRole = 'adm_sementara';
      admSession = {tokenId: savedToken, terikat_ke_userId: savedUid, nama_petugas: savedNama};
      appHeader.style.display = 'flex';
      whoAmI.textContent = 'Petugas: ' + (admSession.nama_petugas||'-');
      renderInputSheet();
      return;
    }
    appHeader.style.display = 'none';
    renderLogin();
    return;
  }

  try{
    const admDoc = await db.collection('adm_utama').doc(user.uid).get();
    if(admDoc.exists){
      currentRole = 'adm_utama';
      currentUserData = admDoc.data();
      appHeader.style.display = 'flex';
      whoAmI.textContent = 'ADM Utama';
      renderAdmDashboard();
      return;
    }
    const userDoc = await db.collection('akun_user').doc(user.uid).get();
    if(userDoc.exists){
      currentRole = 'akun_user';
      currentUserData = userDoc.data();
      appHeader.style.display = 'flex';
      whoAmI.textContent = currentUserData.username;
      renderInputSheet();
      return;
    }
  }catch(e){
    console.warn('Cek role gagal:', e.message);
  }
  appHeader.style.display = 'none';
  renderLogin();
});

// ================= LOGIN UTAMA =================
function renderLogin(){
  app.innerHTML = `
    <div class="center">
      <div class="login-box">
        <div class="card" id="loginCard">
          <h2 style="justify-content:center;text-align:center;">Buku Tamu Digital</h2>
          <p class="muted" style="text-align:center;margin-top:0;">Masuk dengan <strong>kode akses QR</strong>, <strong>username</strong>, atau <strong>email ADM</strong> — cukup satu kolom ini.</p>
          <label>Kode / Username / Email</label>
          <input type="text" id="oneInput" autocomplete="username" autocapitalize="characters" style="text-transform:uppercase;">
          <label>Password <span class="muted" style="text-transform:none;">(kosongkan untuk kode akses QR)</span></label>
          <input type="password" id="onePassword" autocomplete="current-password">
          <button class="btn-primary" style="margin-top:14px;width:100%;padding:13px;" id="oneSubmit">Masuk</button>
          <div id="loginMsg"></div>
          <p class="footer-note">Petugas lapangan: cukup scan QR — halaman ini masuk otomatis.</p>
        </div>
      </div>
    </div>
  `;

  const inp = document.getElementById('oneInput');
  const pass = document.getElementById('onePassword');
  const btn = document.getElementById('oneSubmit');
  const msgArea = document.getElementById('loginMsg');

  function proses(){
    const v = inp.value.trim();
    const p = pass.value;
    if(!v) return showMsg(msgArea, 'Isi kode akses / username / email.');
    // Jeda lokal hanya untuk percobaan kode QR (tanpa password): sampai 20x gagal
    // tidak diblokir sama sekali; setelahnya hanya jeda singkat, bukan blokir.
    if(!p && Date.now() < cooldownSampai){
      const s = Math.ceil((cooldownSampai - Date.now())/1000);
      return showMsg(msgArea, 'Jeda sebentar — coba lagi dalam ' + s + ' detik.');
    }
    btn.disabled = true; btn.textContent = 'Memproses...';
    mulaiBusy('Memeriksa akun…');

    (async () => {
      try{
        const isEmail = v.includes('@');
        // (1) Kode QR: huruf-angka polos tanpa password -> akses petugas
        if(!isEmail && !p && /^[A-Z0-9]+$/.test(v)){
          await masukQrOtomatis(v, '', '', null, true); // baca pemilik sekali, langsung masuk
          return;
        }
        // (2) Username polos -> domain internal
        if(!isEmail){
          if(!p){ selesaiBusy(); return showMsg(msgArea, 'Username membutuhkan password.'); }
          await auth.signInWithEmailAndPassword(v.toLowerCase() + EMAIL_DOMAIN, p);
          selesaiBusy(); // sukses: listener auth akan menggambar ulang halaman
          return;
        }
        // (3) Email -> ADM Utama
        if(!p){ selesaiBusy(); return showMsg(msgArea, 'Email membutuhkan password.'); }
        await auth.signInWithEmailAndPassword(v.toLowerCase(), p);
        selesaiBusy(); // sukses: listener auth akan menggambar ulang halaman
      }catch(e){
        selesaiBusy();
        showMsg(msgArea, pesanErrorAuth(e), 'error', 15000);
        if(String(e && e.code) === 'auth/too-many-requests'){
          cooldownSampai = Date.now() + 5*60*1000;
        }
        btn.disabled = false; btn.textContent = 'Masuk';
      }
    })();
  }

  btn.onclick = proses;
  pass.addEventListener('keydown', e => { if(e.key === 'Enter') proses(); });
  inp.addEventListener('keydown', e => { if(e.key === 'Enter'){ if(inp.value.includes('@')) proses(); else pass.focus(); } });

  // TANPA auto-proses: kode QR diproses hanya oleh halaman khusus /Adms.
  // Dulu blok di sini mengeksekusi kode otomatis tiap render ulang -> satu
  // kegagalan berputar tanpa henti sampai Firebase memblokir perangkat.
}

// ===== MASUK QR OTOMATIS — TIDAK ADA LANGKAH LOGIN APA PUN =====
// Scan QR (?akses=KODE&u=UID) -> langsung lembar input. Di kondisi APA PUN:
// - Perangkat baru/tanpa sesi: login anonim otomatis (satu panggilan, syarat
//   security rules agar boleh menulis) + sesi petugas dibuat.
// - Sudah punya sesi anonim: dipakai ulang, tanpa login ulang.
// - Akun utama membuka tautan QR: langsung dibawa ke lembar tamu pemilik
//   (lembar baca-saja bagi ADM) — sesi utama TIDAK diganggu.
// - QR lama tanpa u= : pemilik dibaca SEKALI dari qr_tokens, tanpa verifikasi
//   status/kedaluwarsa/assigned_uid. QR dianggap tiket fisik yang sah.
// - Profil pemilik lembar belum ada -> dibuat otomatis (ensureProfilPemilik).
function masukQrOtomatis(token, uidPemilik, namaPetugas, userSaatIni, dariInputKode){
  if(qrSedangProses) return; // render ulang listener di tengah proses: abaikan
  qrSedangProses = true;
  const selesai = () => { qrSedangProses = false; selesaiBusy(); };
  mulaiBusy('Membuka lembar input…');
  (async () => {
    try{
      let pemilik = uidPemilik;
      let nama = namaPetugas;
      if(!pemilik){
        // QR lama tanpa u=: baca pemilik SEKALI dari DB. Itu satu-satunya
        // panggilan — tanpa cek status/kedaluwarsa/assigned_uid.
        const snap = await qrStore.doc(token).get();
        if(!snap.exists) throw new Error('Kode akses tidak ditemukan. Minta ADM Utama menampilkan ulang QR atau membuat yang baru.');
        const d = snap.data();
        pemilik = d.terikat_ke_userId;
        if(!nama) nama = d.nama_petugas || '';
      }
      if(!pemilik) throw new Error('QR ini tidak terhubung ke lembar tamu mana pun. Buat QR baru dari dashboard ADM Utama.');

      if(userSaatIni && !userSaatIni.isAnonymous){
        // Akun utama buka tautan QR -> tampilkan lembar tamu pemilik, sesi utama aman
        selesai();
        bersihkanUrlQr();
        currentUser = userSaatIni;
        lembarDilihatUid = pemilik;
        currentRole = 'akun_user';
        currentUserData = {username: nama ? ('Petugas: ' + nama) : 'Lembar Tamu'};
        appHeader.style.display = 'flex';
        whoAmI.textContent = currentUserData.username;
        renderInputSheet();
        return;
      }

      // Perangkat petugas: pastikan ada login anonim (otomatis, tanpa dialog)
      let anon = auth.currentUser;
      if(!anon || !anon.isAnonymous){
        const cred = await auth.signInAnonymously();
        anon = cred.user;
      }
      simpanSesiPetugas(token, pemilik, nama);
      await ensureProfilPemilik(pemilik); // buat profil bila belum ada (otomatis)
      // Tulis ulang dokumen akses sesi petugas — SYARAT umum security rules era
      // lama: petugas anonim hanya boleh menulis ke akun_user/{uid}/tamu bila
      // ada dokumen adm_sementara_akses/{uidAnonim} yang menunjuk pemilik.
      // Tanpa ini rules menolak SETIUP penyimpanan tamu (permission-denied).
      // Tanpa transaksi/verifikasi — satu set, kegagalan rules diabaikan.
      try{
        await db.collection('adm_sementara_akses').doc(anon.uid).set({
          terikat_ke_userId: pemilik,
          token_id: token,
          expired_at: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 36*60*60*1000))
        });
      }catch(e){
        console.warn('Catatan akses petugas gagal ditulis (rules):', e.code || e.message);
      }
      currentRole = 'adm_sementara';
      admSession = {tokenId: token, terikat_ke_userId: pemilik, nama_petugas: nama||''};
      bersihkanUrlQr();
      appHeader.style.display = 'flex';
      whoAmI.textContent = 'Petugas: ' + (nama||'-');
      // Render langsung: listener auth akan menggambar ulang lembar yang sama
      // begitu login anonim selesai — tidak ada layar/login yang terlihat.
      renderInputSheet();
    }catch(e){
      bersihkanUrlQr();
      selesai();
      app.innerHTML = '<div class="card"><p class="empty">' + esc((e && e.message) || 'Gagal membuka QR.') + '</p><p class="muted">' + esc(pesanErrorAuth(e)) + '</p><p class="muted"><a href="' + window.location.pathname + '">Kembali ke halaman utama</a></p></div>';
      return;
    }
    selesai();
  })();
}

// ================= LEMBAR INPUT + TABEL =================
function targetUserUid(){
  if(currentRole === 'adm_sementara') return admSession.terikat_ke_userId;
  return currentUser.uid;
}

function renderInputSheet(){
  // Bersihkan cache versi lama: versi lama menyimpan saran alamat + antrian
  // sinkron per token di localStorage — sisa lama membuat saran alamat
  // memuat data dari token/acara sebelumnya (bug "alamat masih pakai yang lama").
  try{
    const hapus = [];
    for(let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && (k.indexOf('tamu_alamat_cache_') === 0 || k.indexOf('tamu_pending_') === 0)) hapus.push(k);
    }
    hapus.forEach(k => localStorage.removeItem(k));
  }catch(e){}
  // Status TIDAK diinput petugas (ADM Sementara) — otomatis 'Belum';
  // hanya Akun User/ADM Utama yang memilih status saat menambah.
  const pilihStatus = currentRole !== 'adm_sementara';
  app.innerHTML = `
    <div class="card quick-card">
      <h2>Tambah Tamu <span class="sync-pill" id="syncPill"><span class="dot"></span><span id="syncText">menyiapkan…</span></span></h2>
      <div class="quick-line">
        <input type="text" id="qNama" placeholder="Nama tamu" autocomplete="off">
        <input type="text" id="qAlamat" placeholder="Alamat (opsional)" autocomplete="off" list="addrList">
        <input type="text" id="qRp" inputmode="numeric" placeholder="Rp" style="text-align:right;">
        ${pilihStatus ? `
        <select id="qStatus">
          <option value="belum">Belum</option>
          <option value="sudah">Sudah</option>
        </select>` : ''}
        <button class="btn-primary" id="qTambah">+ Tambah</button>
      </div>
      <datalist id="addrList"></datalist>
    </div>
    <div class="card">
      <h2>Daftar Tamu <span class="muted" id="jmlTamu"></span><button class="btn-outline btn-sm" id="btnEkspor" type="button">⬇ Export ke Excel</button></h2>
      <div class="sheet-wrap">
        <table class="sheet">
          <thead><tr><th class="tcol-no">No</th><th>Nama</th><th>Alamat</th><th style="text-align:right;">Rp</th><th class="tcol-status">Status</th><th class="tcol-aksi-hidden"></th></tr></thead>
          <tbody id="sheetBody"></tbody>
          <tfoot>
            <tr class="sheet-total">
              <td colspan="3">TOTAL SUMBANGAN</td>
              <td style="text-align:right;" id="totalRp">Rp 0</td>
              <td id="totalInfo" class="muted" style="font-weight:400;"></td>
              <td class="tcol-aksi-hidden"></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="footer-note">Ketuk baris untuk membuka menu: Edit / Hapus — seperti klik kanan di Windows.</p>
    </div>
  `;

  const btnEkspor = document.getElementById('btnEkspor');
  if(btnEkspor) btnEkspor.onclick = () => eksporCsv('daftar-tamu');
  pasangFormCepat();
  pasangLanggananTabel(targetUserUid());
  // TANPA pengawas token: sesi petugas tidak diusir oleh siapa pun —
  // alur satu langkah tidak mengisi assigned_uid, jadi pengawas justru
  // akan salah menganggap sesi dicuri. Sesi berakhir hanya via Keluar.
  pasangTimerSesi();
}

function pasangFormCepat(){
  const eNama = document.getElementById('qNama');
  const eAlamat = document.getElementById('qAlamat');
  const eRp = document.getElementById('qRp');
  const eStatus = document.getElementById('qStatus');
  const btn = document.getElementById('qTambah');

  eRp.addEventListener('input', () => {
    const digits = eRp.value.replace(/[^0-9]/g,'');
    eRp.value = digits ? 'Rp' + parseInt(digits,10).toLocaleString('id-ID') : '';
  });

  async function tambah(){
    if(btn.disabled) return;
    const nama = eNama.value.trim();
    if(!nama){ eNama.focus(); return; }
    btn.disabled = true; btn.textContent = 'Menyimpan…';
    const item = {
      nama,
      alamat: eAlamat.value.trim(),
      rp: parseInt(eRp.value.replace(/[^0-9]/g,''),10) || 0,
      status: eStatus ? eStatus.value : 'belum',
      permanen: currentRole === 'akun_user',
      dicatat_oleh: currentRole === 'adm_sementara' ? 'adm_sementara' : 'user',
      dicatat_pada: firebase.firestore.FieldValue.serverTimestamp()
    };
    // Kosongkan & fokus DULU — petugas langsung mengetik tamu berikutnya
    // tanpa menunggu jaringan; penulisan berjalan di belakang.
    eNama.value=''; eAlamat.value=''; eRp.value=''; if(eStatus) eStatus.value='belum';
    eNama.focus();

    try{
      await db.collection('akun_user').doc(targetUserUid()).collection('tamu').add(item);
      if(currentRole === 'akun_user'){
        db.collection('akun_user').doc(targetUserUid())
          .update({kuota_terpakai: firebase.firestore.FieldValue.increment(1)})
          .catch(()=>{});
      }
      if(currentRole === 'adm_sementara') tulisLog(item.nama);
    }catch(e){
      showMsg(app.querySelector('.quick-card'), 'Gagal menyimpan: ' + (e.message||e) + ' — cek koneksi lalu ulangi.', 'error', 10000);
    }finally{
      btn.disabled = false; btn.textContent = '+ Tambah';
    }
  }

  btn.onclick = tambah;
  [eNama, eAlamat, eRp, eStatus].filter(Boolean).forEach(el => {
    el.addEventListener('keydown', e => { if(e.key === 'Enter') tambah(); });
  });
  eNama.focus();
}

function tulisLog(namaTamu){
  db.collection('log_adm_sementara').add({
    token_id: admSession.tokenId,
    nama_petugas: admSession.nama_petugas || '-',
    terikat_ke_userId: admSession.terikat_ke_userId,
    aksi: 'tambah',
    nama_tamu: namaTamu,
    waktu: firebase.firestore.FieldValue.serverTimestamp(),
    ttl_hapus_pada: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 48*60*60*1000))
  }).catch(()=>{});
}

function pasangLanggananTabel(uid){
  // Sudah berlangganan lembar yang sama? Jangan putus-pasang ulang —
  // menghindari listener ganda saat listener auth menggambar ulang halaman.
  if(onSnapshotUnsub && uid === lembarDilihatUid) return;
  if(onSnapshotUnsub) onSnapshotUnsub();
  lembarDilihatUid = uid;
  onSnapshotUnsub = db.collection('akun_user').doc(uid).collection('tamu')
    .orderBy('dicatat_pada','desc')
    .onSnapshot({includeMetadataChanges: true}, (snap) => {
      renderTabel(snap);
      const hasPending = snap.docs.some(d => d.metadata.hasPendingWrites);
      const pill = document.getElementById('syncPill');
      const txt = document.getElementById('syncText');
      if(pill && txt){
        if(hasPending){ pill.className = 'sync-pill dirty'; txt.textContent = 'menyimpan…'; }
        else if(snap.metadata.fromCache){ pill.className = 'sync-pill dirty'; txt.textContent = 'offline — tersimpan lokal'; }
        else { pill.className = 'sync-pill online'; txt.textContent = 'tersimpan'; }
      }
    }, (err) => {
      const body = document.getElementById('sheetBody');
      if(body) body.innerHTML = '<tr><td colspan="6"><p class="empty">Gagal memuat tabel: ' + esc(err.message) + '</p></td></tr>';
    });
}

let addrSuggestions = [];
let dataTamuTerkini = []; // salinan data yang sedang tampil — sumber ekspor CSV
function renderTabel(snap){
  const body = document.getElementById('sheetBody');
  if(!body) return;
  let total = 0, sudah = 0, i = 0;
  addrSuggestions = [];
  dataTamuTerkini = [];
  let rows = '';
  snap.forEach(doc => {
    const t = doc.data();
    i++;
    total += Number(t.rp)||0;
    if(t.status === 'sudah') sudah++;
    if(t.alamat && addrSuggestions.length < 60) addrSuggestions.push(t.alamat);
    dataTamuTerkini.push({nama: t.nama, alamat: t.alamat||'', rp: Number(t.rp)||0, status: t.status==='sudah' ? 'sudah' : 'belum'});
    const pending = doc.metadata.hasPendingWrites ? ' baru' : '';
    // Sel tampil sebagai teks pola; klik di mana pun pada baris membuka menu
    rows += `
      <tr class="baris-tamu ${pending.trim()}" data-id="${doc.id}" data-nama="${esc(t.nama)}" data-alamat="${esc(t.alamat||'')}" data-rp="${Number(t.rp)||0}" data-status="${t.status==='sudah'?'sudah':'belum'}">
        <td class="tcol-no">${i}</td>
        <td>${esc(t.nama)}</td>
        <td>${esc(t.alamat||'')}</td>
        <td style="text-align:right;padding-right:8px;">${t.rp ? fmtRp(t.rp) : '—'}</td>
        <td class="tcol-status" style="text-align:center;"><span class="badge ${t.status==='sudah'?'aktif':'belum'}">${t.status==='sudah'?'Sudah':'Belum'}</span></td>
        <td class="tcol-aksi-hidden"></td>
      </tr>`;
  });
  body.innerHTML = rows || '<tr><td colspan="5"><p class="empty">Belum ada tamu. Ketik di form atas — tekan Enter untuk tambah cepat.</p></td></tr>';
  const dl = document.getElementById('addrList');
  if(dl) dl.innerHTML = addrSuggestions.map(a=>'<option value="'+esc(a)+'">').join('');
  const totalEl = document.getElementById('totalRp');
  const infoEl = document.getElementById('totalInfo');
  if(totalEl) totalEl.textContent = fmtRp(total);
  if(infoEl) infoEl.textContent = i + ' tamu • ' + sudah + ' sudah kembali';
  const jml = document.getElementById('jmlTamu');
  if(jml) jml.textContent = '(' + i + ')';

  // Klik/tap baris -> menu konteks (Edit / Hapus / Ganti status)
  body.querySelectorAll('tr.baris-tamu').forEach(tr => {
    tr.addEventListener('click', function(e){
      e.stopPropagation(); // jangan biarkan klik pembuka menutup menu yang baru dibuka
      const rect = this.getBoundingClientRect();
      tampilkanMenuKonteks(e.clientX || rect.left, e.clientY || rect.top, menuBarisTamu(this));
    });
  });
}

function menuBarisTamu(tr){
  const id = tr.dataset.id;
  const ref = db.collection('akun_user').doc(targetUserUid()).collection('tamu').doc(id);
  const item = [
    {label: 'Edit data…', aksi: () => bukaDialogEditBaris(tr, ref)},
    {label: tr.dataset.status === 'sudah' ? 'Tandai Belum kembali' : 'Tandai Sudah kembali',
     aksi: () => {
       mulaiBusy('Mengubah status…');
       ref.update({status: tr.dataset.status === 'sudah' ? 'belum' : 'sudah'})
         .catch(e => showMsg(app, 'Gagal mengubah status: ' + (e.message||e)))
         .finally(selesaiBusy);
     }},
    '-',
    {label: 'Hapus data', bahaya: true, aksi: () => {
       if(!confirm('Hapus data tamu "' + tr.dataset.nama + '"?')) return;
       mulaiBusy('Menghapus…');
       ref.delete()
         .catch(e => showMsg(app, 'Gagal menghapus: ' + (e.message||e)))
         .finally(selesaiBusy);
     }}
  ];
  return item;
}

function bukaDialogEditBaris(tr, ref){
  bukaDialogEdit({
    judul: 'Edit — ' + tr.dataset.nama,
    fields: [
      {key: 'nama', label: 'Nama', nilai: tr.dataset.nama},
      {key: 'alamat', label: 'Alamat', nilai: tr.dataset.alamat},
      {key: 'rp', label: 'Rp', nilai: tr.dataset.rp && Number(tr.dataset.rp) ? Number(tr.dataset.rp).toLocaleString('id-ID') : '', numerik: true}
    ],
    onSimpan: async (nilai) => {
      await ref.update(nilai);
    }
  });
}

// ================= EKSPOR CSV (Excel-compatible) =================
function eksporCsv(namaBerkas){
  if(!dataTamuTerkini.length){ alert('Belum ada data tamu untuk diekspor.'); return; }
  const kutip = (v) => '"' + String(v==null ? '' : v).replace(/"/g,'""') + '"';
  const baris = [['No','Nama','Alamat','Rp','Status'].map(kutip).join(';')];
  dataTamuTerkini.forEach((t, i) => {
    baris.push([i+1, t.nama, t.alamat, t.rp, t.status==='sudah' ? 'Sudah' : 'Belum'].map(kutip).join(';'));
  });
  const total = dataTamuTerkini.reduce((s, t) => s + t.rp, 0);
  baris.push(['', 'TOTAL', '', total, dataTamuTerkini.length + ' tamu'].map(kutip).join(';'));
  // BOM \uFEFF agar Excel membaca file sebagai UTF-8 (nama dengan karakter khusus aman)
  const blob = new Blob(['\uFEFF' + baris.join('\r\n')], {type: 'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (namaBerkas || 'daftar-tamu') + '-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ===== LOGIN PETUGAS VIA KODE MANUAL: baca pemilik lembar SEKALI, langsung masuk.
// Tanpa klaim token, tanpa cek status/kedaluwarsa — satu panggilan baca lalu masuk.
const qrStore = db.collection('qr_tokens');

// Tautan QR SELALU menunjuk halaman petugas /Adms — bukan halaman utama. Dibangun
// dari window.location.origin + dasar repo, jadi tetap benar bila situs pindah
// (mis. custom domain) tanpa perlu mengubah kode.
function urlTautanQr(tokenId, uidPemilik, namaPetugas){
  const dasar = (window.location.origin + window.location.pathname).replace(/\/[^\/]*\.html?$/, '').replace(/\/$/, '');
  let t = dasar + '/Adms/?akses=' + encodeURIComponent(tokenId);
  if(uidPemilik) t += '&u=' + encodeURIComponent(uidPemilik);
  if(namaPetugas) t += '&n=' + encodeURIComponent(namaPetugas);
  return t;
}

function hentikanPengawasToken(){
  // Sisa kompatibilitas — pengawas sudah tidak dipakai pada alur satu langkah.
}

function pasangTimerSesi(){
  clearInterval(timerInterval);
  // Hanya sesi yang memang punya batas waktu (QR lama dari klaim era lama)
  // yang memasang timer; sesi satu-langkah tanpa expired_at = tanpa batas.
  if(currentRole !== 'adm_sementara' || !admSession || !admSession.expired_at) return;
  const expiredAt = admSession.expired_at.toDate();
  timerInterval = setInterval(() => {
    const who = document.getElementById('whoAmI');
    if(!who){ clearInterval(timerInterval); return; }
    const diff = expiredAt - new Date();
    if(diff <= 0){
      clearInterval(timerInterval);
      who.textContent = 'Sesi berakhir — keluar…';
      setTimeout(()=>{ auth.signOut(); }, 1200);
      return;
    }
    const h = Math.floor(diff/3600000), m = Math.floor((diff%3600000)/60000);
    who.textContent = 'Petugas: ' + (admSession.nama_petugas||'-') + ' • sisa ' + h + 'j ' + m + 'm';
  }, 30000);
}

// ================= DASHBOARD ADM UTAMA =================
async function renderAdmDashboard(){
  bersihkanLogKedaluwarsa();
  app.innerHTML = '<div class="card"><p class="empty">Memuat dasbor…</p></div>';

  app.innerHTML = `
    <div class="card">
      <h2>Buat Akun Baru</h2>
      <div class="row">
        <input type="text" id="auUsername" placeholder="username (mis. keluarga-budi)">
        <input type="text" id="auPassword" placeholder="password (min. 6)">
      </div>
      <button class="btn-primary" id="auSubmit" style="margin-top:10px;">Buat Akun</button>
      <div id="auMsg"></div>
    </div>
    <div class="card">
      <h2>Daftar Akun <span class="muted" id="auCount"></span></h2>
      <div class="sheet-wrap">
        <table class="sheet" style="min-width:480px;">
          <thead><tr><th class="tcol-no">No</th><th>Akun</th><th>Kuota</th><th class="tcol-aksi">Aksi</th></tr></thead>
          <tbody id="auBody"><tr><td colspan="4"><p class="empty">Memuat…</p></td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h2>Aktivitas Petugas (48 jam terakhir)</h2>
      <div id="logList"><p class="empty">Memuat…</p></div>
    </div>
  `;

  async function buatAkun(){
    const uEl = document.getElementById('auUsername');
    const pEl = document.getElementById('auPassword');
    const btn = document.getElementById('auSubmit');
    const username = uEl.value.trim().toLowerCase().replace(/\s+/g,'-');
    const password = pEl.value;
    if(!username || password.length < 6) return showMsg(document.getElementById('auMsg'), 'Username wajib diisi & password minimal 6 karakter.');
    btn.disabled = true;
    mulaiBusy('Membuat akun…');
    try{
      const secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary-' + Date.now());
      const secondaryAuth = secondaryApp.auth();
      const cred = await secondaryAuth.createUserWithEmailAndPassword(username + EMAIL_DOMAIN, password);
      await db.collection('akun_user').doc(cred.user.uid).set({
        username,
        dibuat_tanggal: firebase.firestore.FieldValue.serverTimestamp(),
        kuota_total: 0, kuota_terpakai: 0,
        dibuat_oleh: currentUser.uid
      });
      await secondaryAuth.signOut();
      await secondaryApp.delete();
      uEl.value=''; pEl.value='';
      showMsg(document.getElementById('auMsg'), 'Akun "'+username+'" dibuat.', 'ok');
      muatDaftarAkun();
    }catch(e){
      showMsg(document.getElementById('auMsg'), 'Gagal membuat akun: ' + (e.message||e));
    }finally{
      selesaiBusy();
      btn.disabled = false;
    }
  }
  document.getElementById('auSubmit').onclick = buatAkun;

  muatDaftarAkun();
  muatLog();
}

async function muatDaftarAkun(){
  const body = document.getElementById('auBody');
  let snap;
  try{
    snap = await db.collection('akun_user').orderBy('dibuat_tanggal','desc').get();
  }catch(e){
    body.innerHTML = '<tr><td colspan="4"><p class="empty">Gagal memuat: ' + esc(e.message||e) + '</p></td></tr>';
    return;
  }
  const count = document.getElementById('auCount');
  if(count) count.textContent = '(' + snap.size + ' / 300)';
  if(snap.empty){ body.innerHTML = '<tr><td colspan="4"><p class="empty">Belum ada akun.</p></td></tr>'; return; }
  let rows = ''; let i = 0;
  snap.forEach(doc => {
    const d = doc.data(); i++;
    rows += `
      <tr class="baris-akun" data-id="${doc.id}" data-username="${esc(d.username)}" data-kuota="${d.kuota_total||0}">
        <td class="tcol-no">${i}</td>
        <td>${esc(d.username)}<div class="muted" style="padding:2px 0 0;">${fmtWaktu(d.dibuat_tanggal)}</div></td>
        <td style="text-align:right;padding-right:8px;">${d.kuota_terpakai||0} / ${d.kuota_total||0}</td>
        <td class="tcol-aksi" style="padding-top:8px;"> Kelola &rsaquo; </td>
      </tr>`;
  });
  body.innerHTML = rows;

  body.querySelectorAll('tr.baris-akun').forEach(tr => {
    tr.addEventListener('click', function(e){
      e.stopPropagation(); // jangan biarkan klik pembuka menutup menu yang baru dibuka
      const rect = this.getBoundingClientRect();
      tampilkanMenuKonteks(e.clientX || rect.left, e.clientY || rect.top, [
        {label: 'Buka lembar tamu…', aksi: () => bukaLembarAkun(this.dataset.id)},
        {label: 'Tambah 500 kuota', aksi: () => {
          mulaiBusy('Menambah kuota…');
          db.collection('akun_user').doc(this.dataset.id)
            .update({kuota_total: firebase.firestore.FieldValue.increment(500)})
            .catch(err => showMsg(app, 'Gagal: ' + (err.message||err)))
            .finally(selesaiBusy);
        }},
        '-',
        {label: 'Edit username / kuota…', aksi: () => {
          const id = this.dataset.id;
          bukaDialogEdit({
            judul: 'Edit akun — ' + this.dataset.username,
            fields: [
              {key: 'username', label: 'Username', nilai: this.dataset.username},
              {key: 'kuota_total', label: 'Kuota total', nilai: this.dataset.kuota, numerik: true}
            ],
            onSimpan: async (nilai) => {
              await db.collection('akun_user').doc(id).update({
                username: nilai.username.toLowerCase().replace(/\s+/g,'-'),
                kuota_total: nilai.kuota_total
              });
              muatDaftarAkun();
            }
          });
        }}
      ]);
    });
  });
}

async function bukaLembarAkun(userId){
  let d;
  try{
    const doc = await db.collection('akun_user').doc(userId).get();
    if(!doc.exists) throw new Error('Data akun tidak ditemukan.');
    d = doc.data();
  }catch(e){
    app.innerHTML = '<div class="card"><p class="empty">Gagal membuka lembar akun: ' + esc(e.message||e) + '</p><button class="btn-outline btn-sm" id="kembaliBtn">&larr; Kembali</button></div>';
    const kb = document.getElementById('kembaliBtn');
    if(kb) kb.onclick = () => renderAdmDashboard();
    return;
  }

  app.innerHTML = `
    <button class="btn-outline btn-sm" id="backBtn">&larr; Kembali ke daftar akun</button>
    <div class="card" style="margin-top:10px;">
      <h2>${esc(d.username)} <span class="muted">Kuota: ${d.kuota_terpakai||0}/${d.kuota_total||0}</span></h2>
      <div class="row">
        <button class="btn-secondary btn-sm" id="genQrBtn">+ QR Petugas</button>
        <button class="btn-outline btn-sm" id="addKuotaBtn">+500 Kuota</button>
      </div>
      <div id="detailMsg"></div>
    </div>
    <div class="card" id="qrArea" style="display:none;"></div>
    <div class="card">
      <h2>Lembar Tamu <button class="btn-outline btn-sm" id="btnEkspor" type="button">⬇ Export ke Excel</button></h2>
      <div class="sheet-wrap">
        <table class="sheet">
          <thead><tr><th class="tcol-no">No</th><th>Nama</th><th>Alamat</th><th style="text-align:right;">Rp</th><th class="tcol-status">Status</th><th class="tcol-aksi-hidden"></th></tr></thead>
          <tbody id="sheetBody"><tr><td colspan="6"><p class="empty">Memuat…</p></td></tr></tbody>
          <tfoot><tr class="sheet-total"><td colspan="3">TOTAL</td><td style="text-align:right;" id="totalRp">Rp 0</td><td id="totalInfo" class="muted" style="font-weight:400;"></td><td class="tcol-aksi-hidden"></td></tr></tfoot>
        </table>
      </div>
    </div>
    <div class="card">
      <h2>Riwayat QR Petugas</h2>
      <div id="tokenList"><p class="empty">Memuat…</p></div>
    </div>
  `;

  document.getElementById('backBtn').onclick = renderAdmDashboard;
  const btnEksporAkun = document.getElementById('btnEkspor');
  if(btnEksporAkun) btnEksporAkun.onclick = () => eksporCsv('tamu-' + d.username);
  document.getElementById('genQrBtn').onclick = async () => {
    // buatQrToken sudah mengelola busy sendiri (try/catch/finally di dalamnya)
    await buatQrToken(userId, d.username);
  };
  document.getElementById('addKuotaBtn').onclick = async () => {
    mulaiBusy('Menambah kuota…');
    try{
      await db.collection('akun_user').doc(userId).update({kuota_total: firebase.firestore.FieldValue.increment(500)});
      showMsg(document.getElementById('detailMsg'), 'Kuota +500.', 'ok');
    }catch(e){ showMsg(document.getElementById('detailMsg'), 'Gagal: '+(e.message||e)); }
    finally{ selesaiBusy(); }
  };

  if(onSnapshotUnsub) onSnapshotUnsub();
  onSnapshotUnsub = db.collection('akun_user').doc(userId).collection('tamu')
    .orderBy('dicatat_pada','desc')
    .onSnapshot(snap => {
      renderTabel(snap);
    }, err => {
      const body = document.getElementById('sheetBody');
      if(body) body.innerHTML = '<tr><td colspan="6"><p class="empty">Gagal memuat: ' + esc(err.message) + '</p></td></tr>';
    });

  muatTokenList(userId);
}

async function buatQrToken(userId, username){
  // prompt() sinkron — overlay dibuka SETELAHnya, bukan sebelum, agar layar
  // tidak terkunci sambil dialog pertanyaan masih tampil.
  const namaPetugas = prompt('Nama petugas (untuk catatan):');
  if(namaPetugas === null || !namaPetugas.trim()) return;
  mulaiBusy('Membuat QR petugas…');
  try{
    const tokenId = randomToken(8);
    const expiredAt = new Date(Date.now() + 36*60*60*1000);
    await db.collection('qr_tokens').doc(tokenId).set({
      terikat_ke_userId: userId,
      nama_petugas: namaPetugas.trim(),
      dibuat_at: firebase.firestore.FieldValue.serverTimestamp(),
      expired_at: firebase.firestore.Timestamp.fromDate(expiredAt),
      assigned_uid: null,
      status: 'aktif',
      settled: false,
      dibuat_oleh: currentUser.uid
    });

    await muatLibraryQrCode();
    const qrArea = document.getElementById('qrArea');
    qrArea.style.display = 'block';
    const linkUrl = urlTautanQr(tokenId, userId, namaPetugas.trim());
    qrArea.innerHTML = `
      <h2>QR Petugas — ${esc(namaPetugas)}</h2>
      <div class="qr-box">
        <div id="qrcanvas"></div>
        <div class="token-code">${tokenId}</div>
        <p class="muted">Untuk akun "${esc(username)}" • berlaku sampai ${fmtWaktu(firebase.firestore.Timestamp.fromDate(expiredAt))}</p>
        <p class="muted" style="word-break:break-all;"><code>${linkUrl}</code></p>
      </div>
    `;
    new QRCode(document.getElementById('qrcanvas'), {text: linkUrl, width: 200, height: 200});
    muatTokenList(userId);
  }catch(e){
    const el = document.getElementById('detailMsg');
    if(el) showMsg(el, 'Gagal membuat QR: ' + (e.message||e));
  }finally{
    selesaiBusy(); // selalu dilepas — sukses, gagal, maupun dibatalkan
  }
}

async function muatTokenList(userId){
  const el = document.getElementById('tokenList');
  let snap;
  try{
    snap = await db.collection('qr_tokens')
      .where('terikat_ke_userId','==',userId)
      .orderBy('dibuat_at','desc').limit(20).get();
  }catch(e){
    el.innerHTML = '<p class="empty">Gagal memuat daftar QR: ' + esc(e.message||e) + '</p><p class="muted">Bila menyebut "requires an index", buka tautan index di Console browser (F12) sekali saja.</p>';
    return;
  }
  if(snap.empty){ el.innerHTML = '<p class="empty">Belum ada QR petugas.</p>'; return; }
  let rows = '';
  snap.forEach(doc => {
    const d = doc.data();
    if(d.status === 'dihapus') return; // soft-deleted: disembunyikan dari daftar
    const expired = d.expired_at.toDate() < new Date();
    const badge = d.status === 'nonaktif'
      ? '<span class="badge expired">Nonaktif</span>'
      : (expired ? '<span class="badge expired">Kedaluwarsa</span>' : '<span class="badge aktif">Berlaku</span>');
    rows += '<tr class="baris-qr" data-id="' + doc.id + '" data-nama="' + esc(d.nama_petugas||'') + '"><td><strong>' + esc(d.nama_petugas||'(tanpa nama)') + '</strong><br><span class="token-code" style="font-size:11px;">' + doc.id + '</span></td><td>' + fmtWaktu(d.expired_at) + '</td><td>' + badge + '</td></tr>';
  });
  if(!rows){ el.innerHTML = '<p class="empty">Belum ada QR petugas.</p>'; return; }
  el.innerHTML = '<div class="sheet-wrap"><table class="sheet" style="min-width:420px;"><thead><tr><th>Petugas</th><th>Berlaku s/d</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>';

  // Ketuk baris QR -> menu: Tampilkan ulang / Perpanjang & aktifkan / Hapus
  // (semua QR memakai tautan SATU LANGKAH: ?akses=..&u=..&n=..)
  el.querySelectorAll('tr.baris-qr').forEach(tr => {
    tr.addEventListener('click', function(e){
      e.stopPropagation();
      const rect = this.getBoundingClientRect();
      tampilkanMenuKonteks(e.clientX || rect.left, e.clientY || rect.top, menuQrToken(this.dataset.id, this.dataset.nama, userId));
    });
  });
}

function menuQrToken(tokenId, namaPetugas, userIdPemilik){
  const ref = db.collection('qr_tokens').doc(tokenId);
  return [
    {label: 'Tampilkan QR…', aksi: () => tampilkanQrUlang(tokenId, namaPetugas, userIdPemilik)},
    {label: 'Perpanjang 36 jam & aktifkan', aksi: () => {
      mulaiBusy('Memperpanjang QR…');
      ref.update({
        status: 'aktif',
        expired_at: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 36*60*60*1000))
      }).then(() => showMsg(app, 'QR "' + (namaPetugas||'(tanpa nama)') + '" diperpanjang & aktif.', 'ok'))
        .catch(e => showMsg(app, 'Gagal: ' + (e.message||e)))
        .finally(selesaiBusy);
    }},
    '-',
    {label: 'Hapus QR', bahaya: true, aksi: () => {
      if(!confirm('Hapus QR petugas "' + (namaPetugas||'(tanpa nama)') + '"? Sesi petugas yang memakainya akan berakhir.')) return;
      mulaiBusy('Menghapus QR…');
      ref.delete()
        .then(() => {
          // Hapus hard berhasil (rules mengizinkan delete)
          showMsg(app, 'QR dihapus.', 'ok');
          muatTokenList(userIdPemilik);
        })
        .catch(async (e) => {
          // Rules umumnya TIDAK mengizinkan delete oleh siapa pun — fallback:
          // soft-delete (ditandai 'dihapus') yang pasti diizinkan oleh update.
          console.warn('Hapus hard ditolak, pakai soft-delete:', e.code || e.message);
          try{
            // Satu update saja — jenis operasi yang sama dengan "Perpanjang",
            // yang terbukti diizinkan rules. Penulisan log dihindari agar
            // kegagalan log tidak menggagalkan penandaan hapus.
            await ref.update({
              status: 'dihapus',
              expired_at: firebase.firestore.Timestamp.fromDate(new Date(0)),
              nama_petugas: '(dihapus) ' + (namaPetugas||'')
            });
            showMsg(app, 'QR ditandai dihapus & disembunyikan dari daftar.', 'ok');
          }catch(e2){
            showMsg(app, 'Gagal menghapus QR: ' + (e2.message||e2));
          }
        })
        .finally(selesaiBusy);
    }}
  ];
}

async function tampilkanQrUlang(tokenId, namaPetugas, userIdPemilik){
  mulaiBusy('Menyiapkan QR…');
  try{
    await muatLibraryQrCode();
    const qrArea = document.getElementById('qrArea');
    if(!qrArea) return;
    qrArea.style.display = 'block';
    const linkUrl = urlTautanQr(tokenId, userIdPemilik, namaPetugas);
    qrArea.innerHTML = `
      <h2>QR Petugas — ${esc(namaPetugas||'(tanpa nama)')}</h2>
      <div class="qr-box">
        <div id="qrcanvas"></div>
        <div class="token-code">${tokenId}</div>
        <p class="muted" style="word-break:break-all;"><code>${linkUrl}</code></p>
      </div>`;
    new QRCode(document.getElementById('qrcanvas'), {text: linkUrl, width: 200, height: 200});
    qrArea.scrollIntoView({behavior:'smooth', block:'start'});
  }catch(e){
    showMsg(app, 'Gagal menampilkan QR: ' + (e.message||e));
  }finally{
    selesaiBusy();
  }
}

async function bersihkanLogKedaluwarsa(){
  try{
    const now = firebase.firestore.Timestamp.now();
    const snap = await db.collection('log_adm_sementara')
      .where('ttl_hapus_pada','<=', now).limit(200).get();
    if(snap.empty) return;
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }catch(e){ console.warn('Bersihkan log gagal:', e.message); }
}

async function muatLog(){
  const el = document.getElementById('logList');
  let snap;
  try{
    snap = await db.collection('log_adm_sementara').orderBy('waktu','desc').limit(30).get();
  }catch(e){
    el.innerHTML = '<p class="empty">Gagal memuat log: ' + esc(e.message||e) + '</p>';
    return;
  }
  if(snap.empty){ el.innerHTML = '<p class="empty">Belum ada aktivitas.</p>'; return; }
  let rows = ''; let no = 0;
  snap.forEach(doc => {
    const d = doc.data(); no++;
    rows += '<tr><td class="tcol-no">' + no + '</td><td>' + fmtWaktu(d.waktu) + '</td><td><strong>' + esc(d.nama_petugas||'-') + '</strong></td><td>' + esc(d.aksi||'tambah') + ' — ' + esc(d.nama_tamu||'') + '</td></tr>';
  });
  el.innerHTML = '<div class="sheet-wrap"><table class="sheet" style="min-width:420px;">          <thead><tr><th class="tcol-no">No</th><th>Waktu</th><th>Petugas</th><th>Aksi</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

let qrCodeLibPromise = null;
function muatLibraryQrCode(){
  if(window.QRCode) return Promise.resolve();
  if(!qrCodeLibPromise){
    qrCodeLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Gagal memuat library QR Code.'));
      document.head.appendChild(s);
    });
  }
  return qrCodeLibPromise;
}

});
