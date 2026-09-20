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

const app = document.getElementById('app');
const appHeader = document.getElementById('appHeader');
const whoAmI = document.getElementById('whoAmI');

document.getElementById('btnLogout').onclick = async () => {
  clearInterval(timerInterval);
  if(onSnapshotUnsub){ onSnapshotUnsub(); onSnapshotUnsub = null; }
  sessionStorage.removeItem('adm_sementara_token');
  admSession = null;
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

// ================= ROUTING / INIT =================
auth.onAuthStateChanged(async (user) => {
  clearInterval(timerInterval);
  if(onSnapshotUnsub){ onSnapshotUnsub(); onSnapshotUnsub = null; }

  const akses = new URLSearchParams(window.location.search).get('akses') || '';

  if(akses && user && !user.isAnonymous){
    await auth.signOut();
    return;
  }
  if(akses && user && user.isAnonymous && sessionStorage.getItem('adm_sementara_token') !== akses){
    sessionStorage.removeItem('adm_sementara_token');
    await auth.signOut();
    return;
  }

  if(!user){
    currentUser = null; currentRole = null; currentUserData = null; admSession = null;
    appHeader.style.display = 'none';
    renderLogin(akses);
    return;
  }
  currentUser = user;

  if(user.isAnonymous){
    const savedToken = sessionStorage.getItem('adm_sementara_token');
    if(savedToken){
      try{
        const tokenDoc = await db.collection('qr_tokens').doc(savedToken).get();
        if(tokenDoc.exists && tokenDoc.data().assigned_uid === user.uid){
          const data = tokenDoc.data();
          if(data.status === 'aktif' && data.expired_at.toDate() > new Date()){
            currentRole = 'adm_sementara';
            admSession = {tokenId: savedToken, ...data};
            appHeader.style.display = 'flex';
            whoAmI.textContent = 'Petugas: ' + (data.nama_petugas||'-');
            renderInputSheet();
            return;
          }
        }
      }catch(e){ console.warn('Cek sesi QR gagal:', e.message); }
    }
    appHeader.style.display = 'none';
    renderLogin(akses);
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
  renderLogin(akses);
});

// ================= LOGIN 1 PINTU =================
function renderLogin(kodeQr){
  clearInterval(timerInterval);
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
    btn.disabled = true; btn.textContent = 'Memproses...';

    (async () => {
      try{
        const isEmail = v.includes('@');
        // (1) Kode QR: huruf-angka polos tanpa password -> akses petugas
        if(!isEmail && !p && /^[A-Z0-9]+$/.test(v)){
          await masukDenganKode(v);
          return;
        }
        // (2) Username polos -> domain internal
        if(!isEmail){
          if(!p) return showMsg(msgArea, 'Username membutuhkan password.');
          await auth.signInWithEmailAndPassword(v.toLowerCase() + EMAIL_DOMAIN, p);
          return;
        }
        // (3) Email -> ADM Utama
        if(!p) return showMsg(msgArea, 'Email membutuhkan password.');
        await auth.signInWithEmailAndPassword(v.toLowerCase(), p);
      }catch(e){
        showMsg(msgArea, pesanErrorAuth(e), 'error', 15000);
        btn.disabled = false; btn.textContent = 'Masuk';
      }
    })();
  }

  btn.onclick = proses;
  pass.addEventListener('keydown', e => { if(e.key === 'Enter') proses(); });
  inp.addEventListener('keydown', e => { if(e.key === 'Enter'){ if(inp.value.includes('@')) proses(); else pass.focus(); } });

  if(kodeQr){
    inp.value = kodeQr.toUpperCase();
    setTimeout(proses, 0);
  }
}

async function masukDenganKode(token){
  let anonUser = auth.currentUser;
  if(!anonUser || !anonUser.isAnonymous){
    const cred = await auth.signInAnonymously();
    anonUser = cred.user;
  }
  // Catat kode SEGERA sebelum pembacaan — mencegah race dengan listener auth
  sessionStorage.setItem('adm_sementara_token', token);
  const tokenRef = db.collection('qr_tokens').doc(token);
  const snap = await tokenRef.get();
  if(!snap.exists){
    sessionStorage.removeItem('adm_sementara_token');
    throw new Error('Kode akses tidak ditemukan. Periksa penulisan kode (8 karakter).');
  }
  const data = snap.data();
  if(data.status !== 'aktif' || data.expired_at.toDate() < new Date()){
    sessionStorage.removeItem('adm_sementara_token');
    throw new Error('Kode akses kedaluwarsa atau dinonaktifkan. Minta ADM Utama membuat QR baru.');
  }
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(tokenRef);
    const d = fresh.data();
    tx.update(tokenRef, {assigned_uid: anonUser.uid});
    tx.set(db.collection('adm_sementara_akses').doc(anonUser.uid), {
      terikat_ke_userId: d.terikat_ke_userId,
      token_id: token,
      expired_at: d.expired_at
    });
  });
  history.replaceState(null, '', window.location.pathname);
  currentRole = 'adm_sementara';
  admSession = {tokenId: token, ...data, assigned_uid: anonUser.uid};
  appHeader.style.display = 'flex';
  whoAmI.textContent = 'Petugas: ' + (data.nama_petugas||'-');
  renderInputSheet();
}

// ================= LEMBAR INPUT + TABEL =================
function targetUserUid(){
  if(currentRole === 'adm_sementara') return admSession.terikat_ke_userId;
  return currentUser.uid;
}

function renderInputSheet(){
  app.innerHTML = `
    <div class="card quick-card">
      <h2>Tambah Tamu <span class="sync-pill" id="syncPill"><span class="dot"></span><span id="syncText">menyiapkan…</span></span></h2>
      <div class="quick-line">
        <input type="text" id="qNama" placeholder="Nama tamu" autocomplete="off">
        <input type="text" id="qAlamat" placeholder="Alamat (opsional)" autocomplete="off" list="addrList">
        <input type="text" id="qRp" inputmode="numeric" placeholder="Rp0" style="text-align:right;">
        <select id="qStatus">
          <option value="belum">Belum</option>
          <option value="sudah">Sudah</option>
        </select>
        <button class="btn-primary" id="qTambah">+ Tambah</button>
      </div>
      <datalist id="addrList"></datalist>
    </div>
    <div class="card">
      <h2>Daftar Tamu <span class="muted" id="jmlTamu"></span></h2>
      <div class="sheet-wrap">
        <table class="sheet">
          <thead><tr><th class="tcol-no">No</th><th>Nama</th><th>Alamat</th><th style="text-align:right;">Sumbangan</th><th class="tcol-status">Status</th><th class="tcol-aksi">Aksi</th></tr></thead>
          <tbody id="sheetBody"></tbody>
          <tfoot>
            <tr class="sheet-total">
              <td colspan="3">TOTAL SUMBANGAN</td>
              <td style="text-align:right;" id="totalRp">Rp 0</td>
              <td colspan="2" id="totalInfo" class="muted" style="font-weight:400;"></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="footer-note">Ketuk sel untuk mengubah isinya — tersimpan otomatis. Ketuk kolom Status untuk ganti Belum/Sudah.</p>
    </div>
  `;

  pasangFormCepat();
  pasangLanggananTabel(targetUserUid());
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
    const nama = eNama.value.trim();
    if(!nama){ eNama.focus(); return; }
    const item = {
      nama,
      alamat: eAlamat.value.trim(),
      rp: parseInt(eRp.value.replace(/[^0-9]/g,''),10) || 0,
      status: eStatus.value,
      permanen: currentRole === 'akun_user',
      dicatat_oleh: currentRole === 'adm_sementara' ? 'adm_sementara' : 'user',
      dicatat_pada: firebase.firestore.FieldValue.serverTimestamp()
    };
    // Kosongkan & fokus DULU — petugas langsung mengetik tamu berikutnya
    // tanpa menunggu jaringan; penulisan berjalan di belakang.
    eNama.value=''; eAlamat.value=''; eRp.value=''; eStatus.value='belum';
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
    }
  }

  btn.onclick = tambah;
  [eNama, eAlamat, eRp, eStatus].forEach(el => {
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
  if(onSnapshotUnsub) onSnapshotUnsub();
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
function renderTabel(snap){
  const body = document.getElementById('sheetBody');
  if(!body) return;
  let total = 0, sudah = 0, i = 0;
  addrSuggestions = [];
  let rows = '';
  snap.forEach(doc => {
    const t = doc.data();
    i++;
    total += Number(t.rp)||0;
    if(t.status === 'sudah') sudah++;
    if(t.alamat && addrSuggestions.length < 60) addrSuggestions.push(t.alamat);
    const pending = doc.metadata.hasPendingWrites ? ' baru' : '';
    rows += `
      <tr class="${pending.trim()}" data-id="${doc.id}">
        <td class="tcol-no">${i}</td>
        <td><input data-f="nama" value="${esc(t.nama)}"></td>
        <td><input data-f="alamat" value="${esc(t.alamat||'')}" list="addrList"></td>
        <td><input data-f="rp" inputmode="numeric" value="${esc(t.rp?Number(t.rp).toLocaleString('id-ID'):'')}" style="text-align:right;"></td>
        <td class="tcol-status" data-status="${t.status==='sudah'?'sudah':'belum'}" style="text-align:center;cursor:pointer;"><span class="badge ${t.status==='sudah'?'aktif':'belum'}">${t.status==='sudah'?'Sudah':'Belum'}</span></td>
        <td class="tcol-aksi"><button title="Hapus baris" data-del="${doc.id}">🗑️</button></td>
      </tr>`;
  });
  body.innerHTML = rows || '<tr><td colspan="6"><p class="empty">Belum ada tamu. Ketik di form atas — tekan Enter untuk tambah cepat.</p></td></tr>';
  const dl = document.getElementById('addrList');
  if(dl) dl.innerHTML = addrSuggestions.map(a=>'<option value="'+esc(a)+'">').join('');
  const totalEl = document.getElementById('totalRp');
  const infoEl = document.getElementById('totalInfo');
  if(totalEl) totalEl.textContent = fmtRp(total);
  if(infoEl) infoEl.textContent = i + ' tamu • ' + sudah + ' sudah kembali';
  const jml = document.getElementById('jmlTamu');
  if(jml) jml.textContent = '(' + i + ')';

  body.querySelectorAll('input[data-f]').forEach(inp => {
    inp.addEventListener('focus', function(){ this.dataset.asli = this.value; });
    inp.addEventListener('keydown', function(e){ if(e.key === 'Enter') this.blur(); });
    inp.addEventListener('blur', function(){ simpanSel(this); });
  });
  body.querySelectorAll('td.tcol-status').forEach(td => {
    td.addEventListener('click', function(){
      const baru = this.dataset.status === 'sudah' ? 'belum' : 'sudah';
      const id = this.closest('tr').dataset.id;
      db.collection('akun_user').doc(targetUserUid()).collection('tamu').doc(id)
        .update({status: baru})
        .catch(e => showMsg(app, 'Gagal mengubah status: ' + (e.message||e)));
    });
  });
  body.querySelectorAll('button[data-del]').forEach(b => {
    b.addEventListener('click', function(){
      const id = this.dataset.del;
      db.collection('akun_user').doc(targetUserUid()).collection('tamu').doc(id)
        .delete()
        .catch(e => showMsg(app, 'Gagal menghapus: ' + (e.message||e)));
    });
  });
}

async function simpanSel(inp){
  const id = inp.closest('tr').dataset.id;
  const f = inp.dataset.f;
  const asli = inp.dataset.asli || '';
  let val = inp.value;
  if(f === 'rp') val = parseInt(String(val).replace(/[^0-9]/g,''),10) || 0;
  else val = val.trim();
  if(String(val) === String(asli)) return;
  try{
    await db.collection('akun_user').doc(targetUserUid()).collection('tamu').doc(id)
      .update({[f]: val});
    if(f === 'rp') inp.value = val ? Number(val).toLocaleString('id-ID') : '';
  }catch(e){
    inp.value = asli;
    showMsg(app, 'Gagal menyimpan: ' + (e.message||e));
  }
}

function pasangTimerSesi(){
  clearInterval(timerInterval);
  if(currentRole !== 'adm_sementara' || !admSession) return;
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

  document.getElementById('auSubmit').onclick = async () => {
    const uEl = document.getElementById('auUsername');
    const pEl = document.getElementById('auPassword');
    const username = uEl.value.trim().toLowerCase().replace(/\s+/g,'-');
    const password = pEl.value;
    if(!username || password.length < 6) return showMsg(document.getElementById('auMsg'), 'Username wajib diisi & password minimal 6 karakter.');
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
    }
  };

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
      <tr data-id="${doc.id}">
        <td class="tcol-no">${i}</td>
        <td><input data-f="username" value="${esc(d.username)}"><div class="muted" style="padding:0 6px 4px;">${fmtWaktu(d.dibuat_tanggal)}</div></td>
        <td><input data-f="kuota_total" inputmode="numeric" value="${d.kuota_total||0}" style="text-align:right;"></td>
        <td class="tcol-aksi"><button title="Buka lembar tamu akun ini" data-buka="${doc.id}">📄</button></td>
      </tr>`;
  });
  body.innerHTML = rows;

  body.querySelectorAll('input[data-f]').forEach(inp => {
    inp.addEventListener('focus', function(){ this.dataset.asli = this.value; });
    inp.addEventListener('keydown', function(e){ if(e.key==='Enter') this.blur(); });
    inp.addEventListener('blur', async function(){
      const id = this.closest('tr').dataset.id;
      const f = this.dataset.f;
      let val = f === 'kuota_total' ? (parseInt(this.value.replace(/[^0-9]/g,''),10)||0) : this.value.trim().toLowerCase().replace(/\s+/g,'-');
      if(String(val) === String(this.dataset.asli)) return;
      try{
        await db.collection('akun_user').doc(id).update({[f]: val});
        this.dataset.asli = this.value;
      }catch(e){ this.value = this.dataset.asli; showMsg(app, 'Gagal menyimpan: '+(e.message||e)); }
    });
  });
  body.querySelectorAll('button[data-buka]').forEach(b => {
    b.addEventListener('click', () => bukaLembarAkun(b.dataset.buka));
  });
}

async function bukaLembarAkun(userId){
  const doc = await db.collection('akun_user').doc(userId).get();
  const d = doc.data();

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
      <h2>Lembar Tamu</h2>
      <div class="sheet-wrap">
        <table class="sheet">
          <thead><tr><th class="tcol-no">No</th><th>Nama</th><th>Alamat</th><th style="text-align:right;">Sumbangan</th><th class="tcol-status">Status</th><th class="tcol-aksi">Aksi</th></tr></thead>
          <tbody id="sheetBody"><tr><td colspan="6"><p class="empty">Memuat…</p></td></tr></tbody>
          <tfoot><tr class="sheet-total"><td colspan="3">TOTAL</td><td style="text-align:right;" id="totalRp">Rp 0</td><td colspan="2" id="totalInfo" class="muted" style="font-weight:400;"></td></tr></tfoot>
        </table>
      </div>
    </div>
    <div class="card">
      <h2>Riwayat QR Petugas</h2>
      <div id="tokenList"><p class="empty">Memuat…</p></div>
    </div>
  `;

  document.getElementById('backBtn').onclick = renderAdmDashboard;
  document.getElementById('genQrBtn').onclick = () => buatQrToken(userId, d.username);
  document.getElementById('addKuotaBtn').onclick = async () => {
    try{
      await db.collection('akun_user').doc(userId).update({kuota_total: firebase.firestore.FieldValue.increment(500)});
      showMsg(document.getElementById('detailMsg'), 'Kuota +500.', 'ok');
    }catch(e){ showMsg(document.getElementById('detailMsg'), 'Gagal: '+(e.message||e)); }
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
  const namaPetugas = prompt('Nama petugas (untuk catatan):');
  if(namaPetugas === null || !namaPetugas.trim()) return;
  const tokenId = randomToken(8);
  const expiredAt = new Date(Date.now() + 36*60*60*1000);
  try{
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
  }catch(e){
    return showMsg(document.getElementById('detailMsg'), 'Gagal membuat QR: '+(e.message||e));
  }

  await muatLibraryQrCode();
  const qrArea = document.getElementById('qrArea');
  qrArea.style.display = 'block';
  const linkUrl = window.location.origin + window.location.pathname + '?akses=' + tokenId;
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
    const expired = d.expired_at.toDate() < new Date();
    rows += '<tr><td><strong>' + esc(d.nama_petugas||'(tanpa nama)') + '</strong><br><span class="token-code" style="font-size:11px;">' + doc.id + '</span></td><td>' + fmtWaktu(d.expired_at) + '</td><td><span class="badge ' + (expired?'expired':'aktif') + '">' + (expired?'Kedaluwarsa':'Berlaku') + '</span></td></tr>';
  });
  el.innerHTML = '<div class="sheet-wrap"><table class="sheet" style="min-width:420px;"><thead><tr><th>Petugas</th><th>Berlaku s/d</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
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
  let rows = '';
  snap.forEach(doc => {
    const d = doc.data();
    rows += '<tr><td>' + fmtWaktu(d.waktu) + '</td><td><strong>' + esc(d.nama_petugas||'-') + '</strong></td><td>' + esc(d.aksi||'tambah') + ' — ' + esc(d.nama_tamu||'') + '</td></tr>';
  });
  el.innerHTML = '<div class="sheet-wrap"><table class="sheet" style="min-width:420px;"><thead><tr><th>Waktu</th><th>Petugas</th><th>Aksi</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
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
