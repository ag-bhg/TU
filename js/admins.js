/* admins.html — ADM Sementara (petugas lapangan): input & pengelolaan data.
   Halaman ini SENGAJA ringan & terpisah dari admin.html (ADM Utama):
   - Login lewat kode akses QR (8 karakter), lewat scan atau ketik manual.
   - TIDAK membaca seluruh koleksi tamu — hanya menampilkan & mengelola tamu
     yang DITAMBAHKAN dari perangkat/sesi ini (disimpan di localStorage).
     Daftar LENGKAP semua tamu hanya terlihat di user.html / admin.html. */
(function(){
const {auth, db, esc, fmtRp, showMsg, pesanError, mulaiBusy, selesaiBusy,
       tampilkanMenuKonteks, bukaDialogEdit, HALAMAN,
       bacaSesiPetugas, simpanSesiPetugas, hapusSesiPetugas,
       muatEntriesLokalPetugas, simpanEntriesLokalPetugas} = BT;

const app = document.getElementById('app');
const appHeader = document.getElementById('appHeader');
const whoAmI = document.getElementById('whoAmI');

let admSession = null;      // {tokenId, uid, nama}
let entriesLokal = [];      // HANYA tamu yang ditambahkan dari perangkat ini
let sudahDiproses = false;  // anti-loop untuk ?akses= di URL

document.getElementById('btnLogout').onclick = async () => {
  hapusSesiPetugas(admSession && admSession.tokenId);
  admSession = null;
  entriesLokal = [];
  appHeader.style.display = 'none';
  try{ await auth.signOut(); }catch(e){}
};

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
        kuota_total: 0, kuota_terpakai: 0,
        dibuat_oleh: 'qr-otomatis', dibuat_via: 'qr_scan'
      }, {merge:true}).catch(()=>{});
    }).catch(()=>{});
  }
  return profilDijamin[uid];
}

function tulisLog(namaTamu){
  db.collection('log_adm_sementara').add({
    token_id: admSession.tokenId,
    nama_petugas: admSession.nama || '-',
    terikat_ke_userId: admSession.uid,
    aksi: 'tambah',
    nama_tamu: namaTamu,
    waktu: firebase.firestore.FieldValue.serverTimestamp(),
    ttl_hapus_pada: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 48*60*60*1000))
  }).catch(()=>{});
}

// ================= ROUTING =================
auth.onAuthStateChanged(async (user) => {
  const params = new URLSearchParams(window.location.search);
  const kodeUrl = params.get('akses');
  const uidUrl = params.get('u') || '';
  const namaUrl = params.get('n') || '';

  if(user && !user.isAnonymous){
    // Perangkat ini sedang login sebagai ADM Utama / pemilik akun — bukan wilayah halaman ini.
    appHeader.style.display = 'none';
    app.innerHTML = '<div class="center"><div class="card login-box"><p class="empty">Perangkat ini sedang masuk sebagai ADM Utama / pemilik akun.<br>Tekan "Keluar" dulu untuk memakai akses petugas di sini.</p><p class="muted" style="text-align:center;"><a href="' + HALAMAN.login + '">&larr; Ke halaman masuk</a></p></div></div>';
    return;
  }

  if(kodeUrl){
    if(sudahDiproses) return; // anti-loop: proses ?akses= hanya sekali
    sudahDiproses = true;
    masuk(kodeUrl, uidUrl, namaUrl, user);
    return;
  }

  if(user && user.isAnonymous){
    const saved = bacaSesiPetugas();
    if(saved){
      simpanSesiPetugas(saved.tokenId, saved.uid, saved.nama);
      admSession = saved;
      entriesLokal = muatEntriesLokalPetugas(saved.tokenId);
      ensureProfilPemilik(saved.uid);
      try{
        await db.collection('adm_sementara_akses').doc(user.uid).set({
          terikat_ke_userId: saved.uid, token_id: saved.tokenId,
          expired_at: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 36*60*60*1000))
        });
      }catch(e){ console.warn('Catatan akses (restore) gagal:', e.code || e.message); }
      tampilkanSheet();
      return;
    }
  }

  appHeader.style.display = 'none';
  renderLogin();
});

// ================= LOGIN (kode manual) =================
function renderLogin(){
  app.innerHTML = `
    <div class="center">
      <div class="login-box">
        <div class="card">
          <h2 style="justify-content:center;text-align:center;">Akses Petugas</h2>
          <p class="muted" style="text-align:center;margin-top:0;">Cara tercepat: <strong>scan QR</strong> — langsung masuk tanpa proses apa pun. Bila hanya punya kode, isi di bawah.</p>
          <label>Kode Akses</label>
          <input type="text" id="kode" autocapitalize="characters" autocomplete="off" style="text-transform:uppercase;" placeholder="8 huruf/angka">
          <button class="btn-primary" style="margin-top:14px;width:100%;padding:13px;" id="btnMasuk">Masuk</button>
          <div id="pesan"></div>
          <p class="footer-note">Setelah berhasil, Anda langsung dibawa ke lembar input tamu.<br>Gagal? Perbaiki kodenya lalu tekan Masuk lagi.</p>
          <p class="footer-note"><a href="${HALAMAN.login}">&larr; Masuk sebagai ADM Utama / pemilik akun</a></p>
        </div>
      </div>
    </div>
  `;
  const inp = document.getElementById('kode');
  const btn = document.getElementById('btnMasuk');
  const pesan = document.getElementById('pesan');

  async function coba(nilaiKode){
    if(btn.disabled) return;
    const kode = String(nilaiKode || '').trim().toUpperCase();
    if(!/^[A-Z0-9]{8}$/.test(kode)){
      pesan.innerHTML = '<div class="msg error">Kode harus tepat 8 huruf/angka tanpa spasi (contoh: DBBLHEH7).</div>';
      return;
    }
    btn.disabled = true; btn.textContent = 'Memproses...';
    pesan.innerHTML = '';
    await masuk(kode, '', '', auth.currentUser, () => {
      btn.disabled = false; btn.textContent = 'Masuk';
    }, pesan);
  }

  btn.onclick = () => coba(inp.value);
  inp.addEventListener('keydown', (e) => { if(e.key === 'Enter') coba(inp.value); });
  inp.focus();
}

// ================= PROSES MASUK =================
async function masuk(token, uidPemilikAwal, namaAwal, userSaatIni, onGagal, pesanEl){
  mulaiBusy('Membuka lembar input…');
  try{
    let pemilik = uidPemilikAwal;
    let nama = namaAwal;
    if(!pemilik){
      const snap = await db.collection('qr_tokens').doc(token).get();
      if(!snap.exists) throw new Error('Kode akses tidak ditemukan. Periksa penulisan kode (8 karakter).');
      const d = snap.data();
      pemilik = d.terikat_ke_userId;
      if(!nama) nama = d.nama_petugas || '';
    }
    if(!pemilik) throw new Error('QR ini tidak terhubung ke lembar tamu mana pun. Minta ADM Utama membuat QR baru.');

    let anon = userSaatIni;
    if(!anon || !anon.isAnonymous){
      const cred = await auth.signInAnonymously();
      anon = cred.user;
    }
    simpanSesiPetugas(token, pemilik, nama);
    admSession = {tokenId: token, uid: pemilik, nama: nama || ''};
    entriesLokal = muatEntriesLokalPetugas(token);
    await ensureProfilPemilik(pemilik);
    try{
      await db.collection('adm_sementara_akses').doc(anon.uid).set({
        terikat_ke_userId: pemilik, token_id: token,
        expired_at: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 36*60*60*1000))
      });
    }catch(e){ console.warn('Catatan akses petugas gagal ditulis (rules):', e.code || e.message); }
    try{ window.history.replaceState(null, '', window.location.pathname); }catch(e){}
    selesaiBusy();
    tampilkanSheet();
  }catch(e){
    try{ window.history.replaceState(null, '', window.location.pathname); }catch(e2){}
    selesaiBusy();
    if(pesanEl){
      pesanEl.innerHTML = '<div class="msg error">' + esc(pesanError(e)) + '</div>';
      if(onGagal) onGagal();
    }else{
      appHeader.style.display = 'none';
      app.innerHTML = '<div class="center"><div class="card login-box"><p class="empty">' + esc((e && e.message) || 'Gagal membuka QR.') + '</p><button class="btn-primary" id="btnCoba" style="width:100%;margin-top:10px;padding:12px;">Coba lagi</button></div></div>';
      const bc = document.getElementById('btnCoba');
      if(bc) bc.onclick = renderLogin;
    }
  }
}

// ================= LEMBAR INPUT & PENGELOLAAN DATA (data lokal perangkat ini) =================
function tampilkanSheet(){
  appHeader.style.display = 'flex';
  whoAmI.textContent = 'Petugas: ' + (admSession.nama || '-');
  app.innerHTML = `
    <div class="card quick-card">
      <h2>Tambah Tamu</h2>
      <div class="quick-line">
        <input type="text" id="qNama" placeholder="Nama tamu" autocomplete="off">
        <input type="text" id="qAlamat" placeholder="Alamat (opsional)" autocomplete="off">
        <input type="text" id="qRp" inputmode="numeric" placeholder="Rp" style="text-align:right;">
        <button class="btn-primary" id="qTambah">+ Tambah</button>
      </div>
    </div>
    <div class="card">
      <h2>Tamu yang saya input <span class="muted" id="jmlTamu"></span><button class="btn-outline btn-sm" id="btnEkspor" type="button">⬇ Export ke Excel</button></h2>
      <p class="muted" style="margin-top:-4px;">Hanya menampilkan tamu yang ditambahkan dari perangkat ini. Daftar lengkap semua tamu bisa dilihat pemilik akun / ADM Utama.</p>
      <div class="sheet-wrap">
        <table class="sheet">
          <thead><tr><th class="tcol-no">No</th><th>Nama</th><th>Alamat</th><th style="text-align:right;">Rp</th><th class="tcol-aksi-hidden"></th></tr></thead>
          <tbody id="sheetBody"></tbody>
          <tfoot>
            <tr class="sheet-total">
              <td colspan="3">TOTAL (SESI INI)</td>
              <td style="text-align:right;" id="totalRp">Rp 0</td>
              <td class="tcol-aksi-hidden"></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="footer-note">Ketuk baris untuk membuka menu: Edit / Hapus.</p>
    </div>
  `;
  document.getElementById('btnEkspor').onclick = eksporCsv;
  renderTabelLokal();
  pasangFormTambah();
}

function pasangFormTambah(){
  const eNama = document.getElementById('qNama');
  const eAlamat = document.getElementById('qAlamat');
  const eRp = document.getElementById('qRp');
  const btn = document.getElementById('qTambah');

  eRp.addEventListener('input', () => {
    const digits = eRp.value.replace(/[^0-9]/g,'');
    eRp.value = digits ? 'Rp' + parseInt(digits,10).toLocaleString('id-ID') : '';
  });

  async function tambah(){
    if(btn.disabled) return;
    const nama = eNama.value.trim();
    if(!nama){ eNama.focus(); return; }
    const alamat = eAlamat.value.trim();
    const rp = parseInt(eRp.value.replace(/[^0-9]/g,''),10) || 0;
    eNama.value=''; eAlamat.value=''; eRp.value='';
    eNama.focus();

    const ref = db.collection('akun_user').doc(admSession.uid).collection('tamu').doc();
    const baris = {id: ref.id, nama, alamat, rp, waktuLokal: Date.now(), gagal: false};
    entriesLokal.unshift(baris);
    simpanEntriesLokalPetugas(admSession.tokenId, entriesLokal);
    renderTabelLokal();

    try{
      await ref.set({
        nama, alamat, rp,
        status: 'belum',
        permanen: false,
        dicatat_oleh: 'adm_sementara',
        dicatat_pada: firebase.firestore.FieldValue.serverTimestamp()
      });
      tulisLog(nama);
    }catch(e){
      baris.gagal = true;
      simpanEntriesLokalPetugas(admSession.tokenId, entriesLokal);
      renderTabelLokal();
      showMsg(app.querySelector('.quick-card'), 'Gagal menyimpan "' + nama + '": ' + (e.message||e) + ' — cek koneksi lalu tambahkan ulang.', 'error', 10000);
    }
  }

  btn.onclick = tambah;
  [eNama, eAlamat, eRp].forEach(el => el.addEventListener('keydown', e => { if(e.key === 'Enter') tambah(); }));
  eNama.focus();
}

function renderTabelLokal(){
  const body = document.getElementById('sheetBody');
  if(!body) return;
  let total = 0;
  let rows = '';
  entriesLokal.forEach((t, idx) => {
    total += Number(t.rp)||0;
    rows += `
      <tr class="baris-tamu${t.gagal?' baru':''}" data-idx="${idx}">
        <td class="tcol-no">${idx+1}</td>
        <td>${esc(t.nama)}${t.gagal ? ' <span class="badge expired">gagal simpan</span>' : ''}</td>
        <td>${esc(t.alamat||'')}</td>
        <td style="text-align:right;padding-right:8px;">${t.rp ? fmtRp(t.rp) : '—'}</td>
        <td class="tcol-aksi-hidden"></td>
      </tr>`;
  });
  body.innerHTML = rows || '<tr><td colspan="4"><p class="empty">Belum ada tamu yang Anda tambahkan. Ketik di form atas — tekan Enter untuk tambah cepat.</p></td></tr>';
  const totalEl = document.getElementById('totalRp');
  if(totalEl) totalEl.textContent = fmtRp(total);
  const jml = document.getElementById('jmlTamu');
  if(jml) jml.textContent = '(' + entriesLokal.length + ')';

  body.querySelectorAll('tr.baris-tamu').forEach(tr => {
    tr.addEventListener('click', function(e){
      e.stopPropagation();
      const rect = this.getBoundingClientRect();
      tampilkanMenuKonteks(e.clientX || rect.left, e.clientY || rect.top, menuBarisLokal(Number(this.dataset.idx)));
    });
  });
}

function menuBarisLokal(idx){
  const t = entriesLokal[idx];
  const ref = db.collection('akun_user').doc(admSession.uid).collection('tamu').doc(t.id);
  return [
    {label: 'Edit data…', aksi: () => {
      bukaDialogEdit({
        judul: 'Edit — ' + t.nama,
        fields: [
          {key:'nama', label:'Nama', nilai: t.nama},
          {key:'alamat', label:'Alamat', nilai: t.alamat||''},
          {key:'rp', label:'Rp', nilai: t.rp ? Number(t.rp).toLocaleString('id-ID') : '', numerik:true}
        ],
        onSimpan: async (nilai) => {
          await ref.set(nilai, {merge:true});
          Object.assign(t, nilai);
          simpanEntriesLokalPetugas(admSession.tokenId, entriesLokal);
          renderTabelLokal();
        }
      });
    }},
    '-',
    {label: 'Hapus data', bahaya: true, aksi: () => {
      if(!confirm('Hapus data tamu "' + t.nama + '"?')) return;
      mulaiBusy('Menghapus…');
      ref.delete()
        .then(() => {
          entriesLokal.splice(idx, 1);
          simpanEntriesLokalPetugas(admSession.tokenId, entriesLokal);
          renderTabelLokal();
        })
        .catch(e => showMsg(app, 'Gagal menghapus: ' + (e.message||e)))
        .finally(selesaiBusy);
    }}
  ];
}

function eksporCsv(){
  if(!entriesLokal.length){ alert('Belum ada tamu yang Anda tambahkan untuk diekspor.'); return; }
  const kutip = (v) => '"' + String(v==null?'':v).replace(/"/g,'""') + '"';
  const baris = [['No','Nama','Alamat','Rp'].map(kutip).join(';')];
  entriesLokal.forEach((t,i) => baris.push([i+1, t.nama, t.alamat||'', t.rp||0].map(kutip).join(';')));
  const total = entriesLokal.reduce((s,t)=>s+(Number(t.rp)||0),0);
  baris.push(['', 'TOTAL', '', total].map(kutip).join(';'));
  const blob = new Blob(['\uFEFF' + baris.join('\r\n')], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tamu-petugas-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

})();
