/* login.html — satu pintu masuk untuk semua peran.
   - Kode akses QR (8 huruf/angka, tanpa password) -> admins.html   (ADM Sementara)
   - Username + password                          -> user.html     (pemilik akun)
   - Email + password                             -> admin.html    (ADM Utama) */
(function(){
const {auth, EMAIL_DOMAIN, HALAMAN, halamanRole, showMsg, pesanError, mulaiBusy, selesaiBusy, cekRole, bacaSesiPetugas} = BT;

const app = document.getElementById('app');
const params = new URLSearchParams(window.location.search);
const kodeUrl = params.get('akses');
let pesanAwal = null; // pesan yang ditampilkan saat form digambar (mis. akun tidak terdaftar)

auth.onAuthStateChanged(async (user) => {
  // Tautan QR lama / tautan langsung dengan ?akses= -> teruskan ke halaman petugas
  if(kodeUrl){
    window.location.replace(HALAMAN.petugas + window.location.search);
    return;
  }

  if(!user){ renderLogin(); return; }

  if(user.isAnonymous){
    // Sesi petugas yang masih tersimpan -> lanjut ke halaman petugas
    if(bacaSesiPetugas()){ window.location.replace(HALAMAN.petugas); return; }
    renderLogin();
    return;
  }

  // Sudah login sebagai ADM Utama / pemilik akun -> alihkan sesuai peran
  mulaiBusy('Memeriksa akun…');
  const r = await cekRole(user);
  if(r.role){
    window.location.replace(halamanRole(r.role));
    return; // overlay dibiarkan sampai halaman berpindah
  }
  selesaiBusy();
  if(r.error){
    pesanAwal = {teks: pesanError(r.error), tipe: 'error'};
    renderLogin();
  }else{
    pesanAwal = {teks: 'Akun ini belum terdaftar sebagai ADM Utama atau pemilik akun. Hubungi ADM Utama.', tipe: 'error'};
    await auth.signOut(); // listener berjalan lagi dengan user null -> form digambar
  }
});

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

  if(pesanAwal){
    showMsg(msgArea, pesanAwal.teks, pesanAwal.tipe, 15000);
    pesanAwal = null;
  }

  async function proses(){
    if(btn.disabled) return;
    const v = inp.value.trim();
    const p = pass.value;
    if(!v) return showMsg(msgArea, 'Isi kode akses, username, atau email.');

    const isEmail = v.includes('@');

    // (1) Kode QR: 8 huruf/angka tanpa password -> halaman petugas
    if(!isEmail && !p){
      const kode = v.toUpperCase();
      if(/^[A-Z0-9]{8}$/.test(kode)){
        window.location.href = HALAMAN.petugas + '?akses=' + encodeURIComponent(kode);
        return;
      }
      return showMsg(msgArea, 'Kode akses harus 8 huruf/angka. Untuk username, isi juga password.');
    }
    // (2) Email tanpa password
    if(isEmail && !p) return showMsg(msgArea, 'Email membutuhkan password.');

    btn.disabled = true; btn.textContent = 'Memproses...';
    mulaiBusy('Memeriksa akun…');
    try{
      const email = isEmail ? v.toLowerCase() : v.toLowerCase() + EMAIL_DOMAIN;
      await auth.signInWithEmailAndPassword(email, p);
      // Sukses: listener auth di atas menentukan halaman tujuan berdasarkan peran.
    }catch(e){
      selesaiBusy();
      showMsg(msgArea, pesanError(e), 'error', 15000);
      btn.disabled = false; btn.textContent = 'Masuk';
    }
  }

  btn.onclick = proses;
  pass.addEventListener('keydown', e => { if(e.key === 'Enter') proses(); });
  inp.addEventListener('keydown', e => {
    if(e.key !== 'Enter') return;
    if(inp.value.includes('@')) proses(); else pass.focus();
  });
}

})();
