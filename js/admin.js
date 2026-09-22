/* admin.html — ADM Utama.
   Kelola akun pemilik, kuota, QR petugas (ADM Sementara), lihat/ubah lembar tamu,
   dan pantau aktivitas petugas.
   Bisa dibuka langsung ke lembar tertentu lewat  admin.html?lembar=UID_AKUN */
(function(){
const {firebaseConfig, auth, db, EMAIL_DOMAIN, HALAMAN, fmtRp, fmtWaktu, randomToken, esc, showMsg,
       mulaiBusy, selesaiBusy, tampilkanMenuKonteks, bukaDialogEdit, unduhCsv} = BT;

const app = document.getElementById('app');
const appHeader = document.getElementById('appHeader');
const whoAmI = document.getElementById('whoAmI');

let currentUser = null;
let onSnapshotUnsub = null;   // langganan tabel lembar yang sedang dibuka
let lembarUid = null;         // akun yang lembarnya sedang dibuka
let dataTamuTerkini = [];     // salinan data tampil — sumber ekspor CSV

document.getElementById('btnLogout').onclick = () => BT.keluar(() => {
  if(onSnapshotUnsub){ onSnapshotUnsub(); onSnapshotUnsub = null; }
});

BT.jagaHalaman(['adm_utama'], (user) => {
  currentUser = user;
  appHeader.style.display = 'flex';
  whoAmI.textContent = user.email || 'ADM Utama';
  const langsung = new URLSearchParams(window.location.search).get('lembar');
  if(langsung) bukaLembarAkun(langsung); else renderAdmDashboard();
});

function lepasLangganan(){
  if(onSnapshotUnsub){ onSnapshotUnsub(); onSnapshotUnsub = null; }
  lembarUid = null;
}
function bersihkanUrl(){
  try{ window.history.replaceState(null, '', window.location.pathname); }catch(e){}
}

// Tautan QR SELALU menunjuk halaman petugas (admins.html). Dibangun dari lokasi
// halaman ini, jadi tetap benar bila situs pindah (mis. custom domain).
function urlTautanQr(tokenId, uidPemilik, namaPetugas){
  const dasar = (window.location.origin + window.location.pathname).replace(/\/[^\/]*\.html?$/, '').replace(/\/$/, '');
  let t = dasar + '/' + HALAMAN.petugas + '?akses=' + encodeURIComponent(tokenId);
  if(uidPemilik) t += '&u=' + encodeURIComponent(uidPemilik);
  if(namaPetugas) t += '&n=' + encodeURIComponent(namaPetugas);
  return t;
}

// ================= DASHBOARD =================
async function renderAdmDashboard(){
  lepasLangganan();
  bersihkanUrl();
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
      // App kedua supaya sesi ADM Utama tidak tergantikan akun yang baru dibuat
      const secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary-' + Date.now());
      const secondaryAuth = secondaryApp.auth();
      const cred = await secondaryAuth.createUserWithEmailAndPassword(username + EMAIL_DOMAIN, password);
      await db.collection('akun_user').doc(cred.user.uid).set({
        username,
        password,
        dibuat_tanggal: firebase.firestore.FieldValue.serverTimestamp(),
        kuota_total: 0, kuota_terpakai: 0,
        dibuat_oleh: currentUser.uid
      });
      await secondaryAuth.signOut();
      await secondaryApp.delete();
      uEl.value = ''; pEl.value = '';
      showMsg(document.getElementById('auMsg'), 'Akun "' + username + '" dibuat.', 'ok');
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

// ===== KELOLA AKUN (butuh masuk SEBAGAI akun tsb lewat auth kedua — Firebase
// client SDK tidak punya cara lain bagi satu user mengubah/menghapus akun
// user lain). Makanya password disimpan di Firestore saat akun dibuat. =====
async function masukSbgAkunViaSecondary(email, password){
  const secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary-' + Date.now());
  const secondaryAuth = secondaryApp.auth();
  const cred = await secondaryAuth.signInWithEmailAndPassword(email, password);
  return {
    secondaryAuth, user: cred.user,
    tutup: async () => { try{ await secondaryAuth.signOut(); }catch(e){} try{ await secondaryApp.delete(); }catch(e){} }
  };
}

async function hapusSubkoleksiTamu(uid){
  const ref = db.collection('akun_user').doc(uid).collection('tamu');
  // Hapus per 400 dokumen supaya aman di bawah batas 500 operasi/batch.
  while(true){
    const snap = await ref.limit(400).get();
    if(snap.empty) return;
    const batch = db.batch();
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if(snap.size < 400) return;
  }
}

function tampilkanInfoDialog(opsi){
  const dlg = document.createElement('div');
  dlg.className = 'edit-dialog';
  dlg.innerHTML = `
    <div class="edit-box">
      <h3>${esc(opsi.judul)}</h3>
      <input type="text" readonly value="${esc(opsi.nilai)}" id="infoNilai" style="font-weight:600;">
      <div class="edit-actions">
        <button class="btn-outline" data-tutup>Tutup</button>
        <button class="btn-primary" data-salin>Salin</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  const inp = dlg.querySelector('#infoNilai');
  inp.focus(); inp.select();
  dlg.querySelector('[data-tutup]').onclick = () => dlg.remove();
  dlg.addEventListener('keydown', e => { if(e.key === 'Escape') dlg.remove(); });
  dlg.querySelector('[data-salin]').onclick = async () => {
    try{
      await navigator.clipboard.writeText(opsi.nilai);
      showMsg(dlg.querySelector('.edit-box'), 'Tersalin ke clipboard.', 'ok', 2000);
    }catch(e){ inp.select(); document.execCommand('copy'); }
  };
}

async function muatDaftarAkun(){
  const body = document.getElementById('auBody');
  if(!body) return;
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
      <tr class="baris-akun" data-id="${doc.id}" data-username="${esc(d.username)}" data-kuota="${d.kuota_total||0}" data-password="${esc(d.password||'')}">
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
      const id = this.dataset.id, username = this.dataset.username;
      tampilkanMenuKonteks(e.clientX || rect.left, e.clientY || rect.top, [
        {label: 'Buka lembar tamu…', aksi: () => bukaLembarAkun(id)},
        {label: 'Tambah 500 kuota', aksi: () => {
          mulaiBusy('Menambah kuota…');
          db.collection('akun_user').doc(id)
            .update({kuota_total: firebase.firestore.FieldValue.increment(500)})
            .then(muatDaftarAkun)
            .catch(err => showMsg(app, 'Gagal: ' + (err.message||err)))
            .finally(selesaiBusy);
        }},
        '-',
        {label: 'Edit username / kuota…', aksi: () => {
          bukaDialogEdit({
            judul: 'Edit akun — ' + username,
            fields: [
              {key: 'username', label: 'Username', nilai: username},
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
        }},
        '-',
        {label: 'Lihat password', aksi: () => {
          const pw = this.dataset.password;
          tampilkanInfoDialog({
            judul: 'Password — ' + username,
            nilai: pw || '(tidak diketahui — akun dibuat sebelum fitur ini ada; hapus lalu buat ulang akunnya bila perlu)'
          });
        }},
        {label: 'Ubah password…', aksi: () => {
          const pwLama = this.dataset.password;
          if(!pwLama){
            showMsg(app, 'Password lama akun "' + username + '" tidak tersimpan (akun dibuat sebelum fitur ini ada), jadi tidak bisa diubah lewat sini. Solusinya: hapus akun ini lalu buat ulang dengan password baru.');
            return;
          }
          bukaDialogEdit({
            judul: 'Ubah password — ' + username,
            fields: [{key:'password_baru', label:'Password baru (min. 6 karakter)', nilai:''}],
            onSimpan: async (nilai) => {
              const baru = nilai.password_baru;
              if(!baru || baru.length < 6) throw new Error('Password baru minimal 6 karakter.');
              const sesi = await masukSbgAkunViaSecondary(username + EMAIL_DOMAIN, pwLama);
              try{
                await sesi.user.updatePassword(baru);
              }finally{
                await sesi.tutup();
              }
              await db.collection('akun_user').doc(id).update({
                password: baru,
                password_diubah_pada: firebase.firestore.FieldValue.serverTimestamp()
              });
              showMsg(app, 'Password akun "' + username + '" berhasil diubah.', 'ok');
              muatDaftarAkun();
            }
          });
        }},
        {label: 'Hapus akun…', bahaya: true, aksi: () => {
          const pw = this.dataset.password;
          const konfirmasi = prompt('Menghapus akun "' + username + '" beserta SELURUH data tamunya, dan tidak bisa dibatalkan.\n\nKetik username-nya untuk konfirmasi:');
          if(konfirmasi !== username) return;
          mulaiBusy('Menghapus akun…');
          (async () => {
            try{
              await hapusSubkoleksiTamu(id);
              await db.collection('akun_user').doc(id).delete();
              if(pw){
                try{
                  const sesi = await masukSbgAkunViaSecondary(username + EMAIL_DOMAIN, pw);
                  await sesi.user.delete();
                }catch(e){
                  console.warn('Gagal hapus login Firebase Auth (data akun tetap terhapus):', e.code || e.message);
                }
              }
              showMsg(app, 'Akun "' + username + '" & seluruh data tamunya dihapus.' + (pw ? '' : ' Catatan: login lamanya masih terdaftar di Firebase Auth (password lama tidak tersimpan) — hapus manual lewat Firebase Console bila perlu.'), 'ok', 10000);
              muatDaftarAkun();
            }catch(e){
              showMsg(app, 'Gagal menghapus akun: ' + (e.message||e));
            }finally{
              selesaiBusy();
            }
          })();
        }}
      ]);
    });
  });
}

// ================= LEMBAR TAMU SATU AKUN =================
async function bukaLembarAkun(userId){
  lepasLangganan();
  let d;
  try{
    const doc = await db.collection('akun_user').doc(userId).get();
    if(!doc.exists) throw new Error('Data akun tidak ditemukan.');
    d = doc.data();
  }catch(e){
    app.innerHTML = '<div class="card"><p class="empty">Gagal membuka lembar akun: ' + esc(e.message||e) + '</p><button class="btn-outline btn-sm" id="kembaliBtn">&larr; Kembali</button></div>';
    document.getElementById('kembaliBtn').onclick = renderAdmDashboard;
    return;
  }
  lembarUid = userId;

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
      <p class="footer-note">Ketuk baris untuk membuka menu: Edit / Ganti status / Hapus.</p>
    </div>
    <div class="card">
      <h2>Riwayat QR Petugas</h2>
      <div id="tokenList"><p class="empty">Memuat…</p></div>
    </div>
  `;

  document.getElementById('backBtn').onclick = renderAdmDashboard;
  document.getElementById('btnEkspor').onclick = () => eksporCsv('tamu-' + d.username);
  document.getElementById('genQrBtn').onclick = async () => {
    // buatQrToken mengelola busy sendiri (try/catch/finally di dalamnya)
    await buatQrToken(userId, d.username);
  };
  document.getElementById('addKuotaBtn').onclick = async () => {
    mulaiBusy('Menambah kuota…');
    try{
      await db.collection('akun_user').doc(userId).update({kuota_total: firebase.firestore.FieldValue.increment(500)});
      showMsg(document.getElementById('detailMsg'), 'Kuota +500.', 'ok');
    }catch(e){ showMsg(document.getElementById('detailMsg'), 'Gagal: ' + (e.message||e)); }
    finally{ selesaiBusy(); }
  };

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

function renderTabel(snap){
  const body = document.getElementById('sheetBody');
  if(!body) return;
  let total = 0, sudah = 0, i = 0, rows = '';
  dataTamuTerkini = [];
  snap.forEach(doc => {
    const t = doc.data();
    i++;
    total += Number(t.rp)||0;
    if(t.status === 'sudah') sudah++;
    dataTamuTerkini.push({nama: t.nama, alamat: t.alamat||'', rp: Number(t.rp)||0, status: t.status==='sudah' ? 'sudah' : 'belum'});
    const pending = doc.metadata.hasPendingWrites ? ' baru' : '';
    rows += `
      <tr class="baris-tamu${pending}" data-id="${doc.id}" data-nama="${esc(t.nama)}" data-alamat="${esc(t.alamat||'')}" data-rp="${Number(t.rp)||0}" data-status="${t.status==='sudah'?'sudah':'belum'}">
        <td class="tcol-no">${i}</td>
        <td>${esc(t.nama)}</td>
        <td>${esc(t.alamat||'')}</td>
        <td style="text-align:right;padding-right:8px;">${t.rp ? fmtRp(t.rp) : '—'}</td>
        <td class="tcol-status" style="text-align:center;"><span class="badge ${t.status==='sudah'?'aktif':'belum'}">${t.status==='sudah'?'Sudah':'Belum'}</span></td>
        <td class="tcol-aksi-hidden"></td>
      </tr>`;
  });
  body.innerHTML = rows || '<tr><td colspan="6"><p class="empty">Belum ada tamu di lembar ini.</p></td></tr>';
  const totalEl = document.getElementById('totalRp');
  const infoEl = document.getElementById('totalInfo');
  if(totalEl) totalEl.textContent = fmtRp(total);
  if(infoEl) infoEl.textContent = i + ' tamu • ' + sudah + ' sudah kembali';

  body.querySelectorAll('tr.baris-tamu').forEach(tr => {
    tr.addEventListener('click', function(e){
      e.stopPropagation();
      const rect = this.getBoundingClientRect();
      tampilkanMenuKonteks(e.clientX || rect.left, e.clientY || rect.top, menuBarisTamu(this));
    });
  });
}

function menuBarisTamu(tr){
  const ref = db.collection('akun_user').doc(lembarUid).collection('tamu').doc(tr.dataset.id);
  return [
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
}

function bukaDialogEditBaris(tr, ref){
  bukaDialogEdit({
    judul: 'Edit — ' + tr.dataset.nama,
    fields: [
      {key: 'nama', label: 'Nama', nilai: tr.dataset.nama},
      {key: 'alamat', label: 'Alamat', nilai: tr.dataset.alamat},
      {key: 'rp', label: 'Rp', nilai: Number(tr.dataset.rp) ? Number(tr.dataset.rp).toLocaleString('id-ID') : '', numerik: true}
    ],
    onSimpan: async (nilai) => { await ref.update(nilai); }
  });
}

function eksporCsv(namaBerkas){
  if(!dataTamuTerkini.length){ alert('Belum ada data tamu untuk diekspor.'); return; }
  const baris = [['No','Nama','Alamat','Rp','Status']];
  dataTamuTerkini.forEach((t, i) => baris.push([i+1, t.nama, t.alamat, t.rp, t.status==='sudah' ? 'Sudah' : 'Belum']));
  const total = dataTamuTerkini.reduce((s, t) => s + t.rp, 0);
  baris.push(['', 'TOTAL', '', total, dataTamuTerkini.length + ' tamu']);
  unduhCsv(namaBerkas || 'daftar-tamu', baris);
}

// ================= QR PETUGAS =================
async function buatQrToken(userId, username){
  // prompt() sinkron — overlay dibuka SETELAHnya, agar layar tidak terkunci
  // sambil dialog pertanyaan masih tampil.
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
        <p class="muted" style="word-break:break-all;"><code>${esc(linkUrl)}</code></p>
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
  if(!el) return;
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
      }).then(() => { showMsg(app, 'QR "' + (namaPetugas||'(tanpa nama)') + '" diperpanjang & aktif.', 'ok'); muatTokenList(userIdPemilik); })
        .catch(e => showMsg(app, 'Gagal: ' + (e.message||e)))
        .finally(selesaiBusy);
    }},
    '-',
    {label: 'Hapus QR', bahaya: true, aksi: () => {
      if(!confirm('Hapus QR petugas "' + (namaPetugas||'(tanpa nama)') + '"? Sesi petugas yang memakainya akan berakhir.')) return;
      mulaiBusy('Menghapus QR…');
      ref.delete()
        .then(() => {
          showMsg(app, 'QR dihapus.', 'ok');
          muatTokenList(userIdPemilik);
        })
        .catch(async (e) => {
          // Rules umumnya tidak mengizinkan delete — fallback: soft-delete lewat
          // update field 'status' saja (muatTokenList menyembunyikan 'dihapus').
          console.warn('Hapus hard ditolak, pakai soft-delete:', e.code || e.message);
          try{
            await ref.update({ status: 'dihapus' });
            showMsg(app, 'QR ditandai dihapus & disembunyikan dari daftar.', 'ok');
            muatTokenList(userIdPemilik);
          }catch(e2){
            showMsg(app, 'Gagal menghapus QR: ' + (e2.message||e2) + (e2.code === 'permission-denied' ? ' — kemungkinan security rules Firestore menolak update pada qr_tokens ini.' : ''));
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
        <p class="muted" style="word-break:break-all;"><code>${esc(linkUrl)}</code></p>
      </div>`;
    new QRCode(document.getElementById('qrcanvas'), {text: linkUrl, width: 200, height: 200});
    qrArea.scrollIntoView({behavior:'smooth', block:'start'});
  }catch(e){
    showMsg(app, 'Gagal menampilkan QR: ' + (e.message||e));
  }finally{
    selesaiBusy();
  }
}

// ================= LOG AKTIVITAS PETUGAS =================
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
  if(!el) return;
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
  el.innerHTML = '<div class="sheet-wrap"><table class="sheet" style="min-width:420px;"><thead><tr><th class="tcol-no">No</th><th>Waktu</th><th>Petugas</th><th>Aksi</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

let qrCodeLibPromise = null;
function muatLibraryQrCode(){
  if(window.QRCode) return Promise.resolve();
  if(!qrCodeLibPromise){
    qrCodeLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = resolve;
      s.onerror = () => { qrCodeLibPromise = null; reject(new Error('Gagal memuat library QR Code.')); };
      document.head.appendChild(s);
    });
  }
  return qrCodeLibPromise;
}

})();
