/* user.html — pemilik akun: melihat hasil DAFTAR TAMU LENGKAP secara
   real-time, termasuk yang diinput oleh ADM Sementara (petugas via QR) di
   perangkat mana pun. Pemilik juga bisa menambah, mengedit, mengubah status,
   menghapus, dan mengekspor — sama seperti sebelumnya, hanya dipisah ke
   halamannya sendiri. */
(function(){
const {db, esc, fmtRp, showMsg, mulaiBusy, selesaiBusy,
       tampilkanMenuKonteks, bukaDialogEdit, unduhCsv} = BT;

const app = document.getElementById('app');
const appHeader = document.getElementById('appHeader');
const whoAmI = document.getElementById('whoAmI');

let onSnapshotUnsub = null;
let targetUid = null;
let addrSuggestions = [];
let dataTamuTerkini = []; // salinan data tampil (setelah cari+urut) — sumber ekspor CSV
let semuaTamu = [];       // salinan MENTAH seluruh dokumen dari snapshot terakhir
let filterTeks = '';      // kata kunci pencarian (nama atau alamat)
let modeSort = 'waktu';   // 'waktu' (terbaru dulu, apa adanya dari server) | 'alamat' (A–Z)

document.getElementById('btnLogout').onclick = () => BT.keluar(() => {
  if(onSnapshotUnsub){ onSnapshotUnsub(); onSnapshotUnsub = null; }
});

BT.jagaHalaman(['akun_user'], (user, role, data) => {
  targetUid = user.uid;
  appHeader.style.display = 'flex';
  whoAmI.textContent = data.username || 'Lembar Tamu';
  renderInputSheet(data);
});

function renderInputSheet(data){
  app.innerHTML = `
    <div class="card quick-card">
      <h2>Tambah Tamu <span class="sync-pill" id="syncPill"><span class="dot"></span><span id="syncText">menyiapkan…</span></span></h2>
      <div class="quick-line">
        <input type="text" id="qNama" placeholder="Nama tamu" autocomplete="off">
        <input type="text" id="qAlamat" placeholder="Alamat (opsional)" autocomplete="off" list="addrList">
        <input type="text" id="qRp" inputmode="numeric" placeholder="Rp" style="text-align:right;">
        <select id="qStatus">
          <option value="belum">Belum</option>
          <option value="sudah">Sudah</option>
        </select>
        <button class="btn-primary" id="qTambah">+ Tambah</button>
      </div>
      <datalist id="addrList"></datalist>
    </div>
    <div class="card">
      <h2>Hasil Daftar Tamu <span class="muted" id="jmlTamu"></span><button class="btn-outline btn-sm" id="btnEkspor" type="button">⬇ Export ke Excel</button></h2>
      <p class="muted" style="margin-top:-4px;">Daftar lengkap real-time — termasuk tamu yang diinput petugas (ADM Sementara) lewat QR, di perangkat mana pun.</p>
      <div class="cari-sort-bar">
        <div class="cari-box">
          <span class="cari-icon" aria-hidden="true">⌕</span>
          <input type="text" id="cariInput" placeholder="Cari nama atau alamat…" autocomplete="off">
        </div>
        <div class="sort-tabs" id="sortTabs" role="tablist" aria-label="Urutkan tabel">
          <button type="button" data-mode="waktu" class="aktif">Terbaru</button>
          <span class="pemisah">·</span>
          <button type="button" data-mode="alamat">Alamat A–Z</button>
        </div>
      </div>
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
      <p class="footer-note">Ketuk baris untuk membuka menu: Edit / Ganti status / Hapus.</p>
    </div>
  `;

  document.getElementById('btnEkspor').onclick = () => eksporCsv('daftar-tamu-' + (data.username||''));
  pasangFormCepat();
  pasangCariSort();
  pasangLangganan();
}

function pasangCariSort(){
  const cari = document.getElementById('cariInput');
  cari.value = filterTeks;
  cari.addEventListener('input', () => {
    filterTeks = cari.value;
    renderTabel();
  });

  const tabs = document.getElementById('sortTabs');
  tabs.querySelectorAll('button[data-mode]').forEach(btn => {
    if(btn.dataset.mode === modeSort) btn.classList.add('aktif'); else btn.classList.remove('aktif');
    btn.onclick = () => {
      modeSort = btn.dataset.mode;
      tabs.querySelectorAll('button[data-mode]').forEach(b => b.classList.toggle('aktif', b === btn));
      renderTabel();
    };
  });
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
      permanen: true,
      dicatat_oleh: 'user',
      dicatat_pada: firebase.firestore.FieldValue.serverTimestamp()
    };
    eNama.value=''; eAlamat.value=''; eRp.value=''; if(eStatus) eStatus.value='belum';
    eNama.focus();

    try{
      await db.collection('akun_user').doc(targetUid).collection('tamu').add(item);
      db.collection('akun_user').doc(targetUid)
        .update({kuota_terpakai: firebase.firestore.FieldValue.increment(1)})
        .catch(()=>{});
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

function pasangLangganan(){
  if(onSnapshotUnsub) onSnapshotUnsub();
  onSnapshotUnsub = db.collection('akun_user').doc(targetUid).collection('tamu')
    .orderBy('dicatat_pada','desc')
    .onSnapshot({includeMetadataChanges: true}, (snap) => {
      semuaTamu = snap.docs.map(doc => {
        const t = doc.data();
        return {
          id: doc.id,
          nama: t.nama || '',
          alamat: t.alamat || '',
          rp: Number(t.rp)||0,
          status: t.status === 'sudah' ? 'sudah' : 'belum',
          baru: doc.metadata.hasPendingWrites
        };
      });
      renderTabel();
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

// Bandingkan alamat A–Z (lokal Indonesia); alamat kosong selalu di bawah.
function bandingkanAlamat(a, b){
  if(!a.alamat && !b.alamat) return 0;
  if(!a.alamat) return 1;
  if(!b.alamat) return -1;
  return a.alamat.localeCompare(b.alamat, 'id', {sensitivity:'base'});
}

function renderTabel(){
  const body = document.getElementById('sheetBody');
  if(!body) return;

  // Saran alamat (datalist) & total keseluruhan selalu dari SELURUH data,
  // supaya tidak berubah-ubah hanya karena sedang menyaring pencarian.
  addrSuggestions = [];
  semuaTamu.forEach(t => { if(t.alamat && addrSuggestions.length < 60) addrSuggestions.push(t.alamat); });
  const dl = document.getElementById('addrList');
  if(dl) dl.innerHTML = addrSuggestions.map(a=>'<option value="'+esc(a)+'">').join('');

  const kataKunci = filterTeks.trim().toLowerCase();
  let daftar = !kataKunci ? semuaTamu.slice() : semuaTamu.filter(t =>
    t.nama.toLowerCase().includes(kataKunci) || t.alamat.toLowerCase().includes(kataKunci)
  );
  if(modeSort === 'alamat') daftar = daftar.slice().sort(bandingkanAlamat);

  dataTamuTerkini = daftar.map(t => ({nama: t.nama, alamat: t.alamat, rp: t.rp, status: t.status}));

  let total = 0, sudah = 0;
  let rows = daftar.map((t, idx) => {
    total += t.rp;
    if(t.status === 'sudah') sudah++;
    return `
      <tr class="baris-tamu${t.baru ? ' baru' : ''}" data-id="${t.id}" data-nama="${esc(t.nama)}" data-alamat="${esc(t.alamat)}" data-rp="${t.rp}" data-status="${t.status}">
        <td class="tcol-no">${idx+1}</td>
        <td>${esc(t.nama)}</td>
        <td>${esc(t.alamat)}</td>
        <td style="text-align:right;padding-right:8px;">${t.rp ? fmtRp(t.rp) : '—'}</td>
        <td class="tcol-status" style="text-align:center;"><span class="badge ${t.status==='sudah'?'aktif':'belum'}">${t.status==='sudah'?'Sudah':'Belum'}</span></td>
        <td class="tcol-aksi-hidden"></td>
      </tr>`;
  }).join('');

  if(!rows){
    rows = '<tr><td colspan="6"><p class="empty">' + (kataKunci
      ? 'Tidak ada tamu yang cocok dengan "' + esc(filterTeks.trim()) + '".'
      : 'Belum ada tamu. Ketik di form atas, atau tunggu petugas menambahkannya lewat QR.') + '</p></td></tr>';
  }
  body.innerHTML = rows;

  const totalEl = document.getElementById('totalRp');
  const infoEl = document.getElementById('totalInfo');
  if(totalEl) totalEl.textContent = fmtRp(total);
  if(infoEl){
    infoEl.textContent = daftar.length + ' tamu • ' + sudah + ' sudah kembali' +
      (kataKunci ? ' (disaring dari ' + semuaTamu.length + ')' : '');
  }
  const jml = document.getElementById('jmlTamu');
  if(jml) jml.textContent = '(' + daftar.length + (kataKunci ? '/' + semuaTamu.length : '') + ')';

  body.querySelectorAll('tr.baris-tamu').forEach(tr => {
    tr.addEventListener('click', function(e){
      e.stopPropagation();
      const rect = this.getBoundingClientRect();
      tampilkanMenuKonteks(e.clientX || rect.left, e.clientY || rect.top, menuBarisTamu(this));
    });
  });
}

function menuBarisTamu(tr){
  const ref = db.collection('akun_user').doc(targetUid).collection('tamu').doc(tr.dataset.id);
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
      {key: 'rp', label: 'Rp', nilai: tr.dataset.rp && Number(tr.dataset.rp) ? Number(tr.dataset.rp).toLocaleString('id-ID') : '', numerik: true}
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

})();
