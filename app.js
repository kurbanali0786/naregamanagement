/* ================================================================
   Labour Job Card System — app.js
   Developed by Kurban Ali
   Firebase Auth (Email/Password + Google) + Realtime Database
   Har User ka data uske UID ke hisaab se alag save hota hai.
================================================================ */

/* ---------------------------------------------------------------
   SHORTHAND HELPER
--------------------------------------------------------------- */
function $(id){ return document.getElementById(id); }

// Firebase Realtime Database kabhi-kabhi array ko OBJECT bana kar deta hai
// (jab beech ke items delete hote hain to keys sequential nahi rehti) — isse
// DATA.trash.slice()/.filter() jaisi calls silently crash ho jaati thi aur
// Recycle Bin khaali dikhta tha. Ye helper hamesha ek asli Array wapas deta hai.
function toArray(val){
  if(Array.isArray(val)) return val;
  if(val && typeof val === "object") return Object.values(val);
  return [];
}

/* ---------------------------------------------------------------
   FIREBASE CONFIG
--------------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyBVhsIOBQ-8fu4tCeBnYvH7LeZf20t7KVE",
  authDomain: "naregamangment.firebaseapp.com",
  databaseURL: "https://naregamangment-default-rtdb.firebaseio.com",
  projectId: "naregamangment",
  storageBucket: "naregamangment.firebasestorage.app",
  messagingSenderId: "367881034184",
  appId: "1:367881034184:web:8250c6fe144c8bc6a088fd",
  measurementId: "G-BE4X03S7PY"
};
let firebaseReady = false;
try{
  if(typeof firebase === "undefined") throw new Error("Firebase SDK load nahi hua (internet/CDN block)");
  firebase.initializeApp(firebaseConfig);
  firebaseReady = true;
}catch(e){
  console.error("Firebase init fail:", e);
}

let firebaseEnabled = false;
let dbRef = null;
let currentUser = null;

/* Main in-memory data store — HAMESHA khaali start hota hai,
   koi Default/Seed Labour data nahi hai. */
let DATA = {
  labours: [],   // {id, jobcardNo, name, aadhar, status}
  demands: [],   // {id, date, labourId}
  payments: [],  // {id, date, labourId, amount, mateShare, labourShare}
  acCredits: [], // {id, date, labourId, status}
  trash: []      // {id, type: 'labour'|'demand'|'payment', data, cascade, deletedAt}
};

const LS_KEY_PREFIX = "labour_jobcard_data_v1_";

/* ---------------------------------------------------------------
   SMALL UTILITIES
--------------------------------------------------------------- */
function makeId(){
  return "id_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}
function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
function fmtDate(iso){
  if(!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}
function todayISO(){
  return new Date().toISOString().split("T")[0];
}

/* ---------------------------------------------------------------
   FUZZY NAME MATCH — Levenshtein Distance + Normalize
   Mustroll Paste Matching (Demand Tab) ke liye use hota hai
--------------------------------------------------------------- */
function levenshteinDistance(a, b){
  const m = a.length, n = b.length;
  if(m === 0) return n;
  if(n === 0) return m;

  let prevRow = new Array(n + 1);
  let curRow = new Array(n + 1);
  for(let j = 0; j <= n; j++) prevRow[j] = j;

  for(let i = 1; i <= m; i++){
    curRow[0] = i;
    for(let j = 1; j <= n; j++){
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curRow[j] = Math.min(prevRow[j] + 1, curRow[j - 1] + 1, prevRow[j - 1] + cost);
    }
    [prevRow, curRow] = [curRow, prevRow];
  }
  return prevRow[n];
}

// Naam ko compare-layak banata hai — lowercase, extra spaces/symbols hatao
function normalizeName(name){
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, "") // sirf English + Hindi (Devanagari) letters/digits/spaces
    .replace(/\s+/g, " ")
    .trim();
}

// 0-100 ke beech match percentage deta hai (100 = hoobahoo same naam)
function nameSimilarityPercent(a, b){
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if(!na || !nb) return 0;
  if(na === nb) return 100;
  const dist = levenshteinDistance(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  if(maxLen === 0) return 100;
  return Math.round((1 - dist / maxLen) * 100);
}

/* ---------------------------------------------------------------
   TOAST
--------------------------------------------------------------- */
function toast(message, type){
  type = type || "success";
  const box = $("toastContainer");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* PDF ko ya to seedha Download karta hai ya WhatsApp/Share sheet khol deta
   hai (mode="share") — jis device/browser me Share support nahi, wahan
   apne aap normal Download ho jaata hai (koi PDF khoyega nahi) */
async function finalizePdf(pdf, filename, mode){
  if(mode === "share"){
    try{
      const blob = pdf.output("blob");
      const file = new File([blob], filename, { type: "application/pdf" });
      if(navigator.canShare && navigator.canShare({ files: [file] })){
        await navigator.share({ files: [file], title: filename });
        return;
      }
    }catch(err){
      if(err && err.name === "AbortError") return; // User ne Share cancel kar diya
      console.error("Share error:", err);
    }
    toast("Is device/browser me seedha WhatsApp Share support nahi hai — PDF Download ho gaya, WhatsApp me manually attach kar dein", "info");
  }
  pdf.save(filename);
}

/* ---------------------------------------------------------------
   CUSTOM CONFIRM / PROMPT MODAL
--------------------------------------------------------------- */
let modalConfirmCallback = null;

function openModal(title, message, withInput, inputValue){
  $("modalTitle").textContent = title || "Confirm";
  $("modalMessage").textContent = message;
  const inp = $("modalInput");
  if(withInput){
    inp.classList.remove("hidden");
    inp.value = inputValue ?? "";
  } else {
    inp.classList.add("hidden");
  }
  $("modalOverlay").classList.remove("hidden");
  if(withInput) setTimeout(() => inp.focus(), 50);
}
function closeModal(){
  $("modalOverlay").classList.add("hidden");
  modalConfirmCallback = null;
}
function showConfirm(message, onConfirm, title){
  modalConfirmCallback = () => onConfirm();
  openModal(title || "Confirm", message, false);
}
function showPrompt(message, defaultValue, onSubmit, title){
  modalConfirmCallback = () => onSubmit($("modalInput").value);
  openModal(title || "Enter Value", message, true, defaultValue);
}
$("modalOkBtn").addEventListener("click", () => {
  const cb = modalConfirmCallback;
  closeModal();
  if(cb) cb();
});
$("modalCancelBtn").addEventListener("click", closeModal);
$("modalOverlay").addEventListener("click", e => {
  if(e.target.id === "modalOverlay") closeModal();
});

/* ---------------------------------------------------------------
   AUTH — Login / Register / Google / Logout
--------------------------------------------------------------- */
function switchAuthTab(mode){
  const isLogin = mode === "login";
  $("tabLogin").classList.toggle("active", isLogin);
  $("tabRegister").classList.toggle("active", !isLogin);
  $("loginForm").classList.toggle("hidden", !isLogin);
  $("registerForm").classList.toggle("hidden", isLogin);
}

function friendlyAuthError(err){
  if(err && err.code === "auth/unauthorized-domain"){
    return "Yeh domain (" + location.hostname + ") Firebase me Authorized nahi hai — Firebase Console → Authentication → Settings → Authorized domains me isse add karein";
  }
  const map = {
    "auth/email-already-in-use": "Yeh Email pehle se Register hai — Login karein",
    "auth/invalid-email": "Email sahi format me nahi hai",
    "auth/weak-password": "Password kamzor hai — kam se kam 6 characters",
    "auth/user-not-found": "Yeh Email Register nahi hai — pehle Register karein",
    "auth/wrong-password": "Password galat hai",
    "auth/invalid-credential": "Email ya Password galat hai",
    "auth/too-many-requests": "Bahut baar galat try hua — thodi der baad try karein",
    "auth/network-request-failed": "Internet connection check karein",
    "auth/popup-closed-by-user": "Google Login cancel kar diya gaya",
    "auth/popup-blocked": "Browser ne popup block kar diya — popup allow karein",
    "auth/cancelled-popup-request": "Ek se zyada login popup khul gaye — ek baar try karein",
    "auth/operation-not-allowed": "Yeh login method Firebase Console me Enable nahi hai — Authentication → Sign-in method me Email/Password (aur Google) enable karein",
    "auth/invalid-api-key": "Firebase API Key sahi nahi hai",
    "auth/internal-error": "Firebase me koi dikkat hai — thodi der baad try karein"
  };
  return map[err.code] || err.message;
}

// Login/Register button par bhi click ki tarah kaam kare agar do baar jaldi-jaldi
// dabaya jaaye, taaki duplicate request na jaaye aur user ko lage "kuch nahi ho raha"
let authBusy = false;
function setAuthBusy(busy){
  authBusy = busy;
  document.querySelectorAll("#authScreen .btn").forEach(b => { b.disabled = busy; });
}

function loginWithEmail(){
  if(authBusy) return;
  if(!firebaseReady){ toast("Firebase load nahi hua — Internet check karke page Refresh karein", "error"); return; }
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  if(!email || !password){ toast("Email aur Password bharein", "error"); return; }
  setAuthBusy(true);
  firebase.auth().signInWithEmailAndPassword(email, password)
    .catch(err => toast(friendlyAuthError(err), "error"))
    .finally(() => setAuthBusy(false));
}

function registerWithEmail(){
  if(authBusy) return;
  if(!firebaseReady){ toast("Firebase load nahi hua — Internet check karke page Refresh karein", "error"); return; }
  const email = $("regEmail").value.trim();
  const password = $("regPassword").value;
  const password2 = $("regPassword2").value;
  if(!email || !password || !password2){ toast("Sabhi fields bharein", "error"); return; }
  if(password.length < 6){ toast("Password kam se kam 6 characters ka ho", "error"); return; }
  if(password !== password2){ toast("Password match nahi ho raha", "error"); return; }
  setAuthBusy(true);
  firebase.auth().createUserWithEmailAndPassword(email, password)
    .catch(err => toast(friendlyAuthError(err), "error"))
    .finally(() => setAuthBusy(false));
}

function loginWithGoogle(){
  if(authBusy) return;
  if(!firebaseReady){ toast("Firebase load nahi hua — Internet check karke page Refresh karein", "error"); return; }
  const provider = new firebase.auth.GoogleAuthProvider();
  setAuthBusy(true);
  firebase.auth().signInWithPopup(provider)
    .catch(err => {
      // Popup block/close ho jaye to Redirect mode me chale jao (mobile browsers me popup aksar block hota hai)
      if(err && (err.code === "auth/popup-blocked" || err.code === "auth/popup-closed-by-user" ||
                 err.code === "auth/cancelled-popup-request" || err.code === "auth/operation-not-supported-in-this-environment")){
        return firebase.auth().signInWithRedirect(provider);
      }
      toast(friendlyAuthError(err), "error");
    })
    .finally(() => setAuthBusy(false));
}

// Mobile keyboard ka "Go/Enter" dabane par bhi Login/Register chal jaaye —
// pehle sirf button tap karne par hi kaam karta tha, Enter dabane par kuch nahi hota tha
$("loginEmail").addEventListener("keydown", e => { if(e.key === "Enter") loginWithEmail(); });
$("loginPassword").addEventListener("keydown", e => { if(e.key === "Enter") loginWithEmail(); });
$("regEmail").addEventListener("keydown", e => { if(e.key === "Enter") $("regPassword").focus(); });
$("regPassword").addEventListener("keydown", e => { if(e.key === "Enter") $("regPassword2").focus(); });
$("regPassword2").addEventListener("keydown", e => { if(e.key === "Enter") registerWithEmail(); });

function logout(){
  showConfirm("Kya aap Logout karna chahte hain?", () => {
    firebase.auth().signOut();
  });
}

/* Google se Login kiye hue account me EK Password bhi jod (link) deta hai —
   isse aage koi bhi doosra device Google account share kiye bina, seedha
   Email + Password se Login kar sakta hai (data wahi purana milta hai,
   kyunki Firebase me dono tareeke ek hi account/UID se jude rehte hain) */
function setAccountPassword(){
  if(!currentUser){ toast("Pehle Login karein", "error"); return; }
  const p1 = $("pwNewPassword").value;
  const p2 = $("pwNewPassword2").value;
  if(!p1 || !p2){ toast("Dono Password field bharein", "error"); return; }
  if(p1.length < 6){ toast("Password kam se kam 6 characters ka ho", "error"); return; }
  if(p1 !== p2){ toast("Dono Password match nahi ho rahe", "error"); return; }

  const email = currentUser.email;
  if(!email){ toast("Is account ka Email nahi mila", "error"); return; }

  const hasPasswordProvider = currentUser.providerData.some(p => p.providerId === "password");
  const credential = firebase.auth.EmailAuthProvider.credential(email, p1);

  const done = () => {
    $("pwNewPassword").value = "";
    $("pwNewPassword2").value = "";
    toast(`Password set ho gaya! Ab kisi bhi device pe "${email}" aur ye Password daal kar Login kar sakte hain`, "success");
  };

  if(hasPasswordProvider){
    // Pehle se Password linked hai — sirf update karo
    currentUser.updatePassword(p1).then(done).catch(err => toast(friendlyAuthError(err), "error"));
  } else {
    // Naya Password link karo (Google account ke saath)
    currentUser.linkWithCredential(credential).then(done).catch(err => {
      if(err && err.code === "auth/provider-already-linked"){
        currentUser.updatePassword(p1).then(done).catch(e2 => toast(friendlyAuthError(e2), "error"));
      } else {
        toast(friendlyAuthError(err), "error");
      }
    });
  }
}

if(firebaseReady){
  // Google login Redirect mode se wapas aane par result/error pakdo
  firebase.auth().getRedirectResult().catch(err => {
    if(err && err.code) toast(friendlyAuthError(err), "error");
  });

firebase.auth().onAuthStateChanged(user => {
  if(dbRef){ dbRef.off(); dbRef = null; }

  if(user){
    currentUser = user;
    $("authScreen").classList.add("hidden");
    $("appScreen").classList.remove("hidden");
    $("userDisplay").textContent = "👤 " + (user.email || user.displayName || "User");
    if($("pwEmailDisplay")) $("pwEmailDisplay").textContent = user.email ? `Email: ${user.email}` : "";

    ["loginEmail","loginPassword","regEmail","regPassword","regPassword2"].forEach(id => {
      const el = $(id);
      if(el) el.value = "";
    });

    initStorage(user.uid);
  } else {
    currentUser = null;
    $("authScreen").classList.remove("hidden");
    $("appScreen").classList.add("hidden");
    DATA = { labours: [], demands: [], payments: [], acCredits: [], trash: [] };
  }
});
} else {
  // Firebase SDK hi load nahi hua (offline / CDN block) — user ko saaf batayo
  window.addEventListener("DOMContentLoaded", () => {
    const card = document.querySelector(".auth-card");
    if(card && !document.getElementById("firebaseFailNote")){
      const d = document.createElement("div");
      d.id = "firebaseFailNote";
      d.style.cssText = "background:#fde8e8;color:#a93226;padding:10px 12px;border-radius:10px;font-size:12.5px;margin-top:14px;text-align:center;line-height:1.6";
      d.innerHTML = "⚠️ <b>Firebase load nahi ho paya</b> — Internet on karke page Refresh karein.";
      card.appendChild(d);
    }
  });
}

/* ---------------------------------------------------------------
   DATA STORAGE — Har User ka data uske UID ke hisaab se alag
--------------------------------------------------------------- */
function initStorage(uid){
  try{
    dbRef = firebase.database().ref("user/" + uid + "/labour_jobcard_data");
    firebaseEnabled = true;

    dbRef.on("value", snap => {
      const val = snap.val();
      DATA = {
        labours: toArray(val && val.labours),
        demands: toArray(val && val.demands),
        payments: toArray(val && val.payments),
        acCredits: toArray(val && val.acCredits),
        trash: toArray(val && val.trash)
      };
      renderAll();
    }, err => {
      console.warn("Firebase error, switching to offline:", err);
      fallbackToLocalStorage(uid);
    });
  } catch(e){
    console.warn("Firebase init failed, using LocalStorage:", e);
    fallbackToLocalStorage(uid);
  }
}

function fallbackToLocalStorage(uid){
  firebaseEnabled = false;
  const saved = localStorage.getItem(LS_KEY_PREFIX + uid);
  if(saved){
    try{
      const parsed = JSON.parse(saved);
      DATA = {
        labours: toArray(parsed.labours),
        demands: toArray(parsed.demands),
        payments: toArray(parsed.payments),
        acCredits: toArray(parsed.acCredits),
        trash: toArray(parsed.trash)
      };
    } catch(e){ console.warn("LocalStorage parse error", e); }
  } else {
    DATA = { labours: [], demands: [], payments: [], acCredits: [], trash: [] };
  }
  renderAll();
  toast("Offline Mode — LocalStorage me save ho raha hai", "info");
}

function persist(){
  // Save karne se pehle hamesha proper Array normalize kar do — kabhi kabhi
  // Firebase se aaya hua data ya koi bhi mutation object bana sakta hai,
  // isse Recycle Bin/Labour/Demand jaise tabs khaali dikhne ka bug aata tha
  DATA.labours = toArray(DATA.labours);
  DATA.demands = toArray(DATA.demands);
  DATA.payments = toArray(DATA.payments);
  DATA.acCredits = toArray(DATA.acCredits);
  DATA.trash = toArray(DATA.trash);

  if(firebaseEnabled && dbRef){
    dbRef.set(DATA).catch(err => {
      console.warn("Cloud save failed, falling back to local:", err);
      if(currentUser) localStorage.setItem(LS_KEY_PREFIX + currentUser.uid, JSON.stringify(DATA));
      toast("Cloud save fail hua, LocalStorage me save kiya", "error");
    });
  } else if(currentUser){
    localStorage.setItem(LS_KEY_PREFIX + currentUser.uid, JSON.stringify(DATA));
  }
}

// Purani/kharab save hui entries me Mate Share/Labour Share theek karta hai
// (jaise Amount ka aadha-aadha na ho) — taaki sabhi Demand ka Mate Share sahi aaye
function repairMateShare(){
  let fixed = 0;
  DATA.payments.forEach(p => {
    const amt = Number(p.amount) || 0;
    const expected = amt * 0.5;
    const mate = Number(p.mateShare) || 0;
    const labour = Number(p.labourShare) || 0;
    if(Math.abs(mate - expected) > 0.01 || Math.abs(labour - expected) > 0.01){
      p.mateShare = expected;
      p.labourShare = expected;
      fixed++;
    }
  });
  if(fixed > 0) persist();
}

function renderAll(){
  repairMateShare();
  renderDashboard();
  renderLabourProfileList();
  renderLabours();
  renderDemandLabourList();
  renderDemands();
  renderACList();
  renderTrash();
  renderNregaSearch();
  buildNregaFormTable();
}

/* ---------------------------------------------------------------
   TABS
--------------------------------------------------------------- */
const TAB_ORDER = ["dashboard", "labour", "past", "accredit", "report", "nrega"];

function switchTab(name){
  document.querySelectorAll("nav.tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll("main .panel").forEach(p => p.classList.remove("active"));
  $("panel-" + name).classList.add("active");
  const activeBtn = document.querySelector(`nav.tabs button[data-tab="${name}"]`);
  if(activeBtn) activeBtn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  refreshTab(name);
}

// Swipe se bhi tab badal sake (left swipe = agla tab, right swipe = pichla tab) —
// wide tables (.table-wrap) aur input/select ke andar se swipe start ho to ignore karo,
// warna table ka horizontal scroll aur tab-swipe aapas me takra jayenge
function setupSwipeNav(){
  let startX = 0, startY = 0, active = false;

  document.addEventListener("touchstart", e => {
    if(e.touches.length !== 1) return;
    if(e.target.closest(".table-wrap, input, textarea, select, .chk-list")) { active = false; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    active = true;
  }, { passive: true });

  document.addEventListener("touchend", e => {
    if(!active) return;
    active = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if(Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    const activeBtn = document.querySelector("nav.tabs button.active");
    if(!activeBtn) return;
    const idx = TAB_ORDER.indexOf(activeBtn.dataset.tab);
    if(idx === -1) return;

    const nextIdx = dx < 0 ? Math.min(TAB_ORDER.length - 1, idx + 1) : Math.max(0, idx - 1);
    if(nextIdx !== idx) switchTab(TAB_ORDER[nextIdx]);
  }, { passive: true });
}
setupSwipeNav();

// Har tab ka data dobara render karo — manual "Refresh" button aur tab-switch dono isi se chalte hain
function refreshTab(name){
  if(name === "dashboard"){ renderDashboard(); renderLabourProfileList(); }
  if(name === "labour") renderLabours();
  if(name === "past"){
    if($("onePasteDate") && !$("onePasteDate").value) $("onePasteDate").value = todayISO();
    if($("demandDate") && !$("demandDate").value) $("demandDate").value = todayISO();
    renderDemandLabourList();
    renderDemands();
  }
  if(name === "accredit"){ renderACList(); }
  if(name === "report") generateReport();
  if(name === "nrega"){ renderNregaSearch(); buildNregaFormTable(); }
}

function manualRefresh(name){
  refreshTab(name);
  toast("Refresh ho gaya", "info");
}

// Jagah bachane wale collapsible sections (Bulk Import, Mustroll Paste, Manual Select) —
// default HIDDEN rehte hain, button dabane par hi khulte/band hote hain
function toggleCollapse(id, btn, showText, hideText){
  const el = $(id);
  const isShown = el.classList.toggle("show");
  btn.textContent = isShown ? hideText : showText;
}

/* ACCORDION — ek tab me ek hi section khula rahe:
   naya section kholte hi usi panel ke baaki sections apne-aap band ho jate hain */
function toggleAcc(id, btn){
  const el = $(id);
  const willShow = !el.classList.contains("show");
  const panel = btn.closest(".panel") || document;
  panel.querySelectorAll(".acc-item.show").forEach(o => { if(o !== el) o.classList.remove("show"); });
  panel.querySelectorAll(".acc-btn").forEach(b => { if(b !== btn && b.dataset.show) b.textContent = b.dataset.show; });
  el.classList.toggle("show", willShow);
  btn.textContent = willShow ? (btn.dataset.hide || btn.textContent) : (btn.dataset.show || btn.textContent);
}

/* ================================================================
   🏠 DASHBOARD — Login hote hi Quick Summary
================================================================ */
function renderDashboard(){
  const box = $("dashboardSummary");
  if(!box) return;

  const totalLabour = DATA.labours.length;
  const activeLabour = DATA.labours.filter(l => l.status === "Active").length;
  const totalPayment = DATA.payments.reduce((sum, p) => sum + (p.amount || 0), 0);

  const creditedKeys = new Set(DATA.acCredits.filter(a => a.status === "Credited").map(a => a.date + "|" + a.labourId));
  let creditedAmount = 0, creditedMateShare = 0, pendingAmount = 0;
  DATA.payments.forEach(p => {
    if(creditedKeys.has(p.date + "|" + p.labourId)){
      creditedAmount += (p.amount || 0);
      creditedMateShare += (Number(p.amount) || 0) * 0.5;
    } else {
      pendingAmount += (p.amount || 0);
    }
  });

  const warnBox = $("dashboardWarning");
  if(warnBox){
    const lowCount = countLowBaakiJobcards();
    warnBox.innerHTML = lowCount > 0
      ? `<div class="warn-banner" style="cursor:pointer" onclick="toggleLowJobcardDetails()"><span class="n">${lowCount}</span><div>Jobcard aise hain jinke <b>${JOBCARD_LOW_WARNING} Din se kam Baaki</b> hain (Financial Year ${getCurrentFYLabel()}) — inka Form 10 jaldi nikalwa lein. <span style="text-decoration:underline">(dekhne ke liye click karein)</span></div></div>
         <div id="lowJobcardDetails" class="hidden" style="border:1px solid var(--border);border-radius:8px;margin-top:6px;padding:4px 10px;background:#fff"></div>`
      : "";
  }

  box.innerHTML = `
    <div class="sum-card"><div class="v">${totalLabour}</div><div class="l">Total Labour</div></div>
    <div class="sum-card"><div class="v">${activeLabour}</div><div class="l">Active Labour</div></div>
    <div class="sum-card"><div class="v">₹${totalPayment.toFixed(2)}</div><div class="l">Total Payment (Sab Milakar)</div></div>
    <div class="sum-card"><div class="v">₹${creditedAmount.toFixed(2)}</div><div class="l">AC Credited (₹)</div></div>
    <div class="sum-card"><div class="v">₹${pendingAmount.toFixed(2)}</div><div class="l">AC Pending (₹)</div></div>
    <div class="sum-card"><div class="v">₹${creditedMateShare.toFixed(2)}</div><div class="l">Mate Share (Credited)</div></div>
  `;
}

/* ================================================================
   👷 LABOUR PROFILE / SUMMARY (MERGED) — Search karke ek ya kai
   Labour select karo (kuch select na karo to Sabhi Labour aa jaate
   hain). Har selected Labour ka apna block — Date-wise poori History
   + uski Kul Demand/Kul Din/Kul Payment/Credited/Pending summary.
   Date Range (Quick buttons) aur Status (All/Credited/Pending) se
   filter hota hai — jis Labour ki koi entry filter me nahi milti,
   uska block hi report me nahi aata.
================================================================ */
let lpSelected = new Set();   // selected Labour id's — khaali = "Sabhi Labour"
let lpLastReport = [];        // Generate ke baad ka result — Print/PDF isi ko use karte hain

const JOBCARD_DIN_LIMIT = 125; // Har Jobcard pe (1 ya 2+ naam) itni Hajri milti hai (sab naamon ke saath)
const JOBCARD_LOW_WARNING = 16; // Isse kam Baaki ho to ⚠️ Warning dikhegi (Form 10 me min 10-16 din chahiye)

// NREGA Financial Year: 1 April se 31 March — 125 Din ka hisaab har naye
// Financial Year me apne aap 0 se shuru ho jaata hai (purane saal ka carry nahi hota)
function getCurrentFYRange(){
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  const startYear = m >= 4 ? y : y - 1;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}

function getCurrentFYLabel(){
  const { start } = getCurrentFYRange();
  const startYear = parseInt(start.slice(0, 4), 10);
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}

// Ek Labour ke IS Financial Year ke Kul Din (sabhi Demand jod ke)
function getLabourDinHue(labourId){
  const { start, end } = getCurrentFYRange();
  return DATA.demands
    .filter(d => d.labourId === labourId && d.date >= start && d.date <= end)
    .reduce((sum, d) => sum + (Number(d.kulDin) || 0), 0);
}

// Ek Jobcard Number pe (jitne bhi naam us par hain) sabke Din jod kar — is Financial Year ke
function getJobcardDinHue(jobcardNo){
  const ids = DATA.labours.filter(l => l.jobcardNo === jobcardNo).map(l => l.id);
  return ids.reduce((sum, id) => sum + getLabourDinHue(id), 0);
}

// Us Jobcard ke 125 me se kitne Din abhi baaki hain (sabhi naam milakar — saanjha)
function getJobcardBaaki(jobcardNo){
  return Math.max(0, JOBCARD_DIN_LIMIT - getJobcardDinHue(jobcardNo));
}

// Kitne (Active Labour ke) Jobcard "Low Warning" me hain (Baaki < 16) — Dashboard card ke liye
function countLowBaakiJobcards(){
  return getLowBaakiJobcardsList().length;
}

// Warning wale Jobcard ki poori list (naam + baaki din) — click karke dikhane ke liye
function getLowBaakiJobcardsList(){
  const seen = new Set();
  const result = [];
  DATA.labours.filter(l => l.status === "Active").forEach(l => {
    if(seen.has(l.jobcardNo)) return;
    seen.add(l.jobcardNo);
    const baaki = getJobcardBaaki(l.jobcardNo);
    if(baaki < JOBCARD_LOW_WARNING){
      const names = DATA.labours.filter(x => x.jobcardNo === l.jobcardNo).map(x => x.name);
      result.push({ jobcardNo: l.jobcardNo, names, baaki });
    }
  });
  return result.sort((a, b) => a.baaki - b.baaki);
}

function toggleLowJobcardDetails(){
  const el = $("lowJobcardDetails");
  if(!el) return;
  if(el.classList.contains("hidden")){
    el.innerHTML = getLowBaakiJobcardsList().map(x => `
      <div class="dd-item"><span>${escapeHtml(x.jobcardNo)} — ${escapeHtml(x.names.join(", "))}</span><span><b>${x.baaki}</b> Din Baaki</span></div>
    `).join("");
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function renderLabourProfileList(){
  const term = ($("labourProfileSearch") && $("labourProfileSearch").value || "").trim().toLowerCase();
  const box = $("labourProfileList");
  if(!box) return;

  let list = DATA.labours.slice().sort((a, b) => a.name.localeCompare(b.name));
  if(term){
    list = list.filter(l =>
      l.name.toLowerCase().includes(term) || String(l.jobcardNo || "").toLowerCase().includes(term)
    );
  }

  if(!list.length){
    box.innerHTML = `<div class="empty">Koi Labour nahi mila.</div>`;
    updateLpSelectedCount();
    return;
  }

  box.innerHTML = list.map(l => `
    <div class="chk-item">
      <input type="checkbox" class="lp-chk" value="${l.id}" ${lpSelected.has(l.id) ? "checked" : ""} onchange="toggleLpSelect('${l.id}', this.checked)">
      <div style="flex:1">${escapeHtml(l.name)} <span class="badge ${l.status.toLowerCase()}">${l.status}</span>
        <div style="font-size:11.5px;color:var(--muted)">Jobcard: ${escapeHtml(l.jobcardNo)}</div>
      </div>
    </div>
  `).join("");
  updateLpSelectedCount();
}

function toggleLpSelect(id, checked){
  if(checked) lpSelected.add(id); else lpSelected.delete(id);
  updateLpSelectedCount();
}

// Abhi jitne bhi visible (search-filtered) Labour hain, sabko select karo
function toggleLpSelectAll(){
  const chks = document.querySelectorAll(".lp-chk");
  if(!chks.length){ toast("Select karne ke liye koi Labour nahi hai", "error"); return; }
  chks.forEach(chk => { chk.checked = true; lpSelected.add(chk.value); });
  updateLpSelectedCount();
  toast(`${chks.length} Labour select ho gaye`, "success");
}

function clearLpSelection(){
  lpSelected.clear();
  document.querySelectorAll(".lp-chk").forEach(chk => chk.checked = false);
  updateLpSelectedCount();
}

function updateLpSelectedCount(){
  const el = $("lpSelectedCount");
  if(!el) return;
  el.textContent = lpSelected.size ? `${lpSelected.size} selected` : "Koi select nahi — Sabhi Labour aayenge";
}

// Quick Range buttons — 7 Din / 1-2-3 Mahine / Sabhi Dates
function setLpQuickRange(type, btn){
  document.querySelectorAll(".lp-quick-btn").forEach(b => b.classList.remove("active"));
  if(btn) btn.classList.add("active");

  const toISO = d => d.toISOString().split("T")[0];
  if(type === "all"){
    if($("lpFromDate")) $("lpFromDate").value = "";
    if($("lpToDate")) $("lpToDate").value = "";
    return;
  }
  const today = new Date();
  const from = new Date(today);
  if(type === "7d") from.setDate(from.getDate() - 7);
  else if(type === "1m") from.setMonth(from.getMonth() - 1);
  else if(type === "2m") from.setMonth(from.getMonth() - 2);
  else if(type === "3m") from.setMonth(from.getMonth() - 3);

  if($("lpFromDate")) $("lpFromDate").value = toISO(from);
  if($("lpToDate")) $("lpToDate").value = toISO(today);
}

// Ek Labour ka data — date-range aur status-filter lagakar
function getLabourProfileRows(labourId, fromDate, toDate, statusFilter){
  const creditedKeys = new Set(DATA.acCredits.filter(a => a.status === "Credited").map(a => a.date + "|" + a.labourId));

  let demands = DATA.demands.filter(d => d.labourId === labourId);
  if(fromDate) demands = demands.filter(d => d.date >= fromDate);
  if(toDate) demands = demands.filter(d => d.date <= toDate);
  demands = demands.slice().sort((a, b) => a.date.localeCompare(b.date));

  let rows = demands.map(d => {
    const p = DATA.payments.find(x => x.date === d.date && x.labourId === labourId);
    const ac = DATA.acCredits.find(x => x.date === d.date && x.labourId === labourId);
    const status = creditedKeys.has(d.date + "|" + labourId) ? "Credited" : "Pending";
    const amount = p ? (p.amount || 0) : 0;
    return {
      date: d.date, kulDin: d.kulDin ?? "", pratidin: d.pratidin ?? "",
      amount, status, creditedDate: ac && ac.creditedDate ? ac.creditedDate : "",
      comment: d.comment ? String(d.comment).trim() : ""
    };
  });

  if(statusFilter === "Credited") rows = rows.filter(r => r.status === "Credited");
  else if(statusFilter === "Pending") rows = rows.filter(r => r.status === "Pending");

  let kulDin = 0, kulPayment = 0, creditedAmt = 0, pendingAmt = 0;
  rows.forEach(r => {
    kulDin += Number(r.kulDin) || 0;
    kulPayment += r.amount;
    if(r.status === "Credited") creditedAmt += r.amount; else pendingAmt += r.amount;
  });

  return { rows, kulDin, kulPayment, creditedAmt, pendingAmt, demandCount: rows.length };
}

// Selected (ya Sabhi) Labour ke liye poora report ikattha karta hai —
// jis Labour ki filter me koi entry nahi milti, uska block skip ho jaata hai
function getLabourProfileReport(){
  const fromDate = $("lpFromDate") ? $("lpFromDate").value : "";
  const toDate = $("lpToDate") ? $("lpToDate").value : "";
  const statusFilter = $("lpStatusFilter") ? $("lpStatusFilter").value : "All";

  const targetLabours = lpSelected.size
    ? DATA.labours.filter(l => lpSelected.has(l.id))
    : DATA.labours.slice();

  const blocks = targetLabours
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(l => ({ labour: l, ...getLabourProfileRows(l.id, fromDate, toDate, statusFilter) }))
    .filter(b => b.rows.length > 0);

  return { blocks, fromDate, toDate, statusFilter };
}

// Blocks ko Jobcard Number ke hisaab se group karta hai (jinka Jobcard same
// hai — jaise Pati-Patni — wo ek saath ek group me aa jaate hain)
function groupBlocksByJobcard(blocks){
  const order = [];
  const map = {};
  blocks.forEach(b => {
    const jc = b.labour.jobcardNo || "—";
    if(!map[jc]){ map[jc] = []; order.push(jc); }
    map[jc].push(b);
  });
  return order.map(jc => ({ jobcardNo: jc, members: map[jc] }));
}

function labourProfileBlockHtml(b){
  return `
    <div class="lp-block">
      <div class="lp-block-head">
        <div class="lp-avatar">${escapeHtml(b.labour.name.charAt(0))}</div>
        <div>
          <div class="lp-name">${escapeHtml(b.labour.name)} <span class="badge ${b.labour.status.toLowerCase()}">${b.labour.status}</span></div>
          <div class="lp-jc">Jobcard: ${escapeHtml(b.labour.jobcardNo)}</div>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Din</th><th>Dar</th><th>Payment ₹</th><th>Status</th><th>Credited Date</th><th>Comment</th></tr></thead>
          <tbody>
            ${b.rows.map(r => `
              <tr>
                <td>${fmtDate(r.date)}</td>
                <td style="text-align:center">${r.kulDin || "—"}</td>
                <td style="text-align:center">${r.pratidin || "—"}</td>
                <td style="text-align:center">₹${r.amount}</td>
                <td style="text-align:center"><span class="badge ${r.status.toLowerCase()}">${r.status}</span></td>
                <td style="text-align:center">${r.creditedDate ? fmtDate(r.creditedDate) : "—"}</td>
                <td style="text-align:center">${r.comment ? escapeHtml(r.comment) : (r.status === "Credited" ? '<span class="badge pending">⚠️ Baaki Hai</span>' : "—")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="lp-summary">
        <span>Kul Demand: <b>${b.demandCount}</b></span>
        <span>Kul Din: <b>${b.kulDin}</b></span>
        <span>Kul Payment: <b>₹${b.kulPayment.toFixed(2)}</b></span>
        <span>Credited: <b>₹${b.creditedAmt.toFixed(2)}</b></span>
        <span>Pending: <b>₹${b.pendingAmt.toFixed(2)}</b></span>
      </div>
    </div>
  `;
}

function lpRangeLabel(fromDate, toDate){
  if(!fromDate && !toDate) return "Sabhi Dates";
  return `${fromDate ? fmtDate(fromDate) : "Shuru"} se ${toDate ? fmtDate(toDate) : "Aaj"} tak`;
}

function generateLabourProfileReport(){
  const { blocks, fromDate, toDate, statusFilter } = getLabourProfileReport();
  lpLastReport = { blocks, fromDate, toDate, statusFilter };
  const box = $("labourProfileBox");
  if(!box) return;

  if(!blocks.length){
    box.innerHTML = `<div class="empty mt">Is filter/date-range me koi Demand data nahi mila.</div>`;
    return;
  }

  const groups = groupBlocksByJobcard(blocks);
  box.innerHTML = `
    <div class="lp-doc-head">📊 Labour Report — ${blocks.length} Labour — ${lpRangeLabel(fromDate, toDate)} — ${statusFilter}</div>
    ${groups.map(g => `
      <div class="jc-group">
        <div class="jc-group-head">Jobcard: ${escapeHtml(g.jobcardNo)}</div>
        ${g.members.map(labourProfileBlockHtml).join("")}
      </div>
    `).join("")}
  `;
}

function printLabourProfileReport(){
  if(!lpLastReport.blocks || !lpLastReport.blocks.length){ toast("Pehle Generate karein", "error"); return; }
  const st = document.createElement("style");
  st.textContent = "@page{size:A4 portrait;margin:5mm}";
  document.head.appendChild(st);
  document.body.classList.add("print-lp");
  window.print();
  setTimeout(() => { document.body.classList.remove("print-lp"); st.remove(); }, 500);
}

/* PDF ke liye ek Labour ka block — black-border document style (baaki
   PDF reports jaisa hi), taaki poori file me look consistent rahe */
function labourProfileBlockPdfHtml(b){
  return `
    <div style="font-family:'Hind',Arial,sans-serif;color:#000;background:#fff;padding:6px;border:1px solid #000">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-size:13.5px;font-weight:700">${escapeHtml(b.labour.name)}${b.partLabel || ""}</div>
        <div style="font-size:11px;color:#555">Jobcard: ${escapeHtml(b.labour.jobcardNo)} · Status: ${escapeHtml(b.labour.status)}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:10.5px">
        <thead><tr>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Date</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Din</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Dar</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Payment ₹</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Status</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Credited Date</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Comment</th>
        </tr></thead>
        <tbody>
          ${b.rows.map(r => `
            <tr>
              <td style="border:1px solid #000;padding:4px;text-align:center">${fmtDate(r.date)}</td>
              <td style="border:1px solid #000;padding:4px;text-align:center">${r.kulDin || "—"}</td>
              <td style="border:1px solid #000;padding:4px;text-align:center">${r.pratidin || "—"}</td>
              <td style="border:1px solid #000;padding:4px;text-align:center">₹${r.amount}</td>
              <td style="border:1px solid #000;padding:4px;text-align:center">${r.status}</td>
              <td style="border:1px solid #000;padding:4px;text-align:center">${r.creditedDate ? fmtDate(r.creditedDate) : "—"}</td>
              <td style="border:1px solid #000;padding:4px;text-align:center">${r.comment ? escapeHtml(r.comment) : (r.status === "Credited" ? "⚠️ Baaki Hai" : "—")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <div style="margin-top:6px;font-size:10.5px;background:#f3f3f3;padding:5px 8px;border:1px solid #000">
        Kul Demand: <b>${b.demandCount}</b> &nbsp;|&nbsp; Kul Din: <b>${b.kulDin}</b> &nbsp;|&nbsp;
        Kul Payment: <b>₹${b.kulPayment.toFixed(2)}</b> &nbsp;|&nbsp;
        Credited: <b>₹${b.creditedAmt.toFixed(2)}</b> &nbsp;|&nbsp; Pending: <b>₹${b.pendingAmt.toFixed(2)}</b>
      </div>
    </div>`;
}

function lpTitlePdfHtml(count, rangeLabel, statusFilter){
  return `
    <div style="font-family:'Hind',Arial,sans-serif;color:#000;background:#fff;padding:6px;border:1px solid #000;text-align:center">
      <div style="font-size:15px;font-weight:700">Labour Report</div>
      <div style="font-size:11px;color:#555;margin-top:3px">${count} Labour — ${rangeLabel} — ${statusFilter} — Labour Job Card System — ${fmtDate(todayISO())}</div>
    </div>`;
}

function lpFooterPdfHtml(){
  return `
    <div style="font-family:'Hind',Arial,sans-serif;color:#444;background:#fff;padding:8px;text-align:right;font-size:10px;border-top:1px solid #999">
      Developed by Kurban Ali
    </div>`;
}

// Jobcard group ka chhota header — jab bhi naya Jobcard shuru ho
function jcGroupHeaderPdfHtml(jobcardNo){
  return `
    <div style="font-family:'Hind',Arial,sans-serif;color:#fff;background:#0a3b24;padding:6px 10px;font-size:11.5px;font-weight:700">
      Jobcard: ${escapeHtml(jobcardNo)}
    </div>`;
}

/* PDF Download — Portrait, kam margin, poori page width, aur har Labour
   ka block bin-packing se lagta hai (jitna fit ho jaaye usi page pe,
   block bich me nahi kategi — agar fit nahi hua to agle page pe jaayegi) */
async function downloadLabourProfileReportPDF(mode){
  mode = mode || "download";
  if(!lpLastReport.blocks || !lpLastReport.blocks.length){ toast("Pehle Generate karein", "error"); return; }
  if(typeof window.jspdf === "undefined" || typeof html2canvas === "undefined"){
    toast("PDF library load nahi hui — Internet check karke dobara try karein", "error"); return;
  }
  toast("PDF taiyar ho raha hai...", "info");

  const MAX_ROWS_PER_CHUNK = 26; // Bahut lambi history ho to Labour ka block isse bade chunks me tootega
  const chunks = [lpTitlePdfHtml(lpLastReport.blocks.length, lpRangeLabel(lpLastReport.fromDate, lpLastReport.toDate), lpLastReport.statusFilter)];

  const groups = groupBlocksByJobcard(lpLastReport.blocks);
  groups.forEach(g => {
    chunks.push(jcGroupHeaderPdfHtml(g.jobcardNo));
    g.members.forEach(b => {
      if(b.rows.length <= MAX_ROWS_PER_CHUNK){
        chunks.push(labourProfileBlockPdfHtml({ ...b, partLabel: "" }));
      } else {
        const total = Math.ceil(b.rows.length / MAX_ROWS_PER_CHUNK);
        for(let i = 0; i < total; i++){
          chunks.push(labourProfileBlockPdfHtml({
            ...b,
            rows: b.rows.slice(i * MAX_ROWS_PER_CHUNK, (i + 1) * MAX_ROWS_PER_CHUNK),
            partLabel: ` (Part ${i + 1}/${total})`
          }));
        }
      }
    });
  });
  chunks.push(lpFooterPdfHtml());

  try{
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4"); // Portrait
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 4; // kam margin — poori page use ho
    const usableWidth = pageWidth - margin * 2;

    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:760px;background:#fff";
    document.body.appendChild(container);

    let yCursor = margin;
    let pageHasContent = false;

    try{
      for(let i = 0; i < chunks.length; i++){
        container.innerHTML = chunks[i];
        await new Promise(r => setTimeout(r, 40));
        const canvas = await html2canvas(container.firstElementChild, { scale: 2, backgroundColor: "#ffffff", logging: false });
        if(!canvas || !canvas.width) continue;

        let imgWidth = usableWidth;
        let imgHeight = (canvas.height * imgWidth) / canvas.width;

        // Agar akela chunk hi ek page se lamba hai (bahut rare), to use page ki height me fit kar do
        if(imgHeight > pageHeight - margin * 2){
          imgHeight = pageHeight - margin * 2;
          imgWidth = (canvas.width * imgHeight) / canvas.height;
        }

        if(pageHasContent && yCursor + imgHeight > pageHeight - margin){
          pdf.addPage();
          yCursor = margin;
          pageHasContent = false;
        }
        pdf.addImage(canvas.toDataURL("image/png", 1.0), "PNG", margin, yCursor, imgWidth, imgHeight);
        yCursor += imgHeight + 2.5;
        pageHasContent = true;
      }
    } finally { document.body.removeChild(container); }

    await finalizePdf(pdf, `Labour_Report_${todayISO()}.pdf`, mode);
    if(mode !== "share") toast("PDF Download ho gaya");
  }catch(err){
    console.error("Labour Profile Report PDF error:", err);
    toast("PDF banane me dikkat hui, dobara try karein", "error");
  }
}

function shareLabourProfileReportPDF(){ downloadLabourProfileReportPDF("share"); }

/* ================================================================
   💾 DATA BACKUP / RESTORE (JSON)
================================================================ */
/* ================================================================
   🗑️ RECYCLE BIN — Delete karne par turant permanent delete nahi hota,
   pehle Trash me jata hai. Wahan se Restore ya Permanently Delete kar sakte hain.
   Ek saath (bulk) delete kiye gaye items EK trash record me batch hote hain — taaki
   ek hi Restore click se sab wapas aa jayen, ek-ek karke restore na karna pade.
================================================================ */
function moveToTrash(type, items, cascades){
  const arr = Array.isArray(items) ? items : [items];
  if(!arr.length) return;
  DATA.trash = toArray(DATA.trash);
  DATA.trash.push({
    id: makeId(),
    type,
    items: arr,
    cascades: cascades || null,
    deletedAt: new Date().toISOString()
  });
}

function renderTrash(){
  const box = $("trashList");
  const emptyBox = $("trashEmpty");
  const countBox = $("trashCount");
  if(!box) return;

  DATA.trash = toArray(DATA.trash);
  DATA.labours = toArray(DATA.labours);

  const typeLabel = { labour: "👷 Labour", demand: "📋 Demand", payment: "💰 Payment" };
  const list = DATA.trash.slice().sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""));

  if(countBox) countBox.textContent = "(" + list.length + " Batch)";

  if(!list.length){
    box.innerHTML = "";
    if(emptyBox) emptyBox.classList.remove("hidden");
    return;
  }
  if(emptyBox) emptyBox.classList.add("hidden");

  box.innerHTML = list.map(t => {
    const names = t.items.map(x => {
      if(t.type === "labour") return x.name;
      const l = DATA.labours.find(y => y.id === x.labourId);
      return l ? l.name : "(Labour bhi delete ho chuka)";
    });
    const count = t.items.length;
    const preview = names.slice(0, 3).map(escapeHtml).join(", ") + (count > 3 ? ` +${count - 3} aur` : "");
    const dateStr = new Date(t.deletedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    return `
      <div class="chk-item">
        <div style="flex:1">
          <div><b>${typeLabel[t.type] || t.type}</b> — <b>${count}</b> item${count > 1 ? "s" : ""}: ${preview}</div>
          <div style="font-size:12px;color:var(--muted)">Delete kiya: ${dateStr}</div>
        </div>
        <button class="btn btn-green btn-sm" onclick="restoreTrashItem('${t.id}')">↩️ Restore</button>
        <button class="btn btn-red btn-sm" onclick="permanentDeleteTrashItem('${t.id}')">Permanent Delete</button>
      </div>
    `;
  }).join("");
}

function restoreTrashItem(trashId){
  DATA.trash = toArray(DATA.trash);
  const t = DATA.trash.find(x => x.id === trashId);
  if(!t) return;

  DATA.labours = toArray(DATA.labours);
  DATA.demands = toArray(DATA.demands);
  DATA.payments = toArray(DATA.payments);
  DATA.acCredits = toArray(DATA.acCredits);

  if(t.type === "labour"){
    t.items.forEach(x => DATA.labours.push(x));
  } else if(t.type === "demand"){
    t.items.forEach((x, idx) => {
      DATA.demands.push(x);
      const c = t.cascades && t.cascades[idx];
      if(c){
        (c.payments || []).forEach(p => DATA.payments.push(p));
        (c.acCredits || []).forEach(a => DATA.acCredits.push(a));
      }
    });
  } else if(t.type === "payment"){
    t.items.forEach(x => DATA.payments.push(x));
  }

  DATA.trash = DATA.trash.filter(x => x.id !== trashId);
  persist();
  renderAll();
  toast(`${t.items.length} entry Restore ho gayi`);
}

function permanentDeleteTrashItem(trashId){
  DATA.trash = toArray(DATA.trash);
  const t = DATA.trash.find(x => x.id === trashId);
  const count = t ? t.items.length : 0;
  showConfirm(`Ye ${count} entry hamesha ke liye delete ho jayengi, wapas nahi aayengi. Confirm karein?`, () => {
    DATA.trash = toArray(DATA.trash).filter(x => x.id !== trashId);
    persist();
    renderTrash();
    toast("Permanent delete ho gaya");
  });
}

function clearAllTrash(){
  DATA.trash = toArray(DATA.trash);
  if(!DATA.trash.length){ toast("Recycle Bin pehle se khaali hai", "info"); return; }
  showConfirm(`Recycle Bin ki sabhi ${DATA.trash.length} batch entries hamesha ke liye delete karni hain?`, () => {
    DATA.trash = [];
    persist();
    renderTrash();
    toast("Recycle Bin khaali ho gaya");
  });
}

// Recycle Bin ab tab nahi hai — header ke button se popup (modal) me khulta hai
function openTrashModal(){
  renderTrash();
  $("trashModalOverlay").classList.remove("hidden");
}
function closeTrashModal(){
  $("trashModalOverlay").classList.add("hidden");
}
$("trashModalOverlay").addEventListener("click", e => {
  if(e.target.id === "trashModalOverlay") closeTrashModal();
});

function exportDataJSON(){
  const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `Labour_Jobcard_Backup_${todayISO()}.json`;
  link.click();
  toast("Backup file download ho gayi");
}

function importDataJSON(event){
  const file = event.target.files[0];
  if(!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    let parsed;
    try{
      parsed = JSON.parse(e.target.result);
      if(!parsed || typeof parsed !== "object") throw new Error("invalid");
    } catch(err){
      toast("Ye file sahi Backup JSON nahi hai", "error");
      event.target.value = "";
      return;
    }

    showConfirm(
      "Backup file load karne se aapka MOJUDA data poora badal jaayega (overwrite ho jaayega). Kya aap sure hain?",
      () => {
        DATA = {
          labours: toArray(parsed.labours),
          demands: toArray(parsed.demands),
          payments: toArray(parsed.payments),
          acCredits: toArray(parsed.acCredits),
          trash: toArray(parsed.trash)
        };
        persist();
        renderAll();
        toast("Backup se Data Restore ho gaya");
      },
      "Data Restore Karein?"
    );
    event.target.value = "";
  };
  reader.readAsText(file);
}

/* ================================================================
   📥 BULK LABOUR IMPORT (CSV)
================================================================ */
function downloadSampleCSV(){
  const csv =
    "Jobcard No,Name,Aadhar No,Status\n" +
    "RJ-05-001-001,Ram Lal,123456789012,Active\n" +
    "RJ-05-001-002,Sita Devi,,\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "Sample_Labour_Import.csv";
  link.click();
}

function parseCSVLine(line){
  const result = [];
  let cur = "", inQuotes = false;
  for(let i = 0; i < line.length; i++){
    const c = line[i];
    if(c === '"'){
      inQuotes = !inQuotes;
    } else if(c === "," && !inQuotes){
      result.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

function importLabourFile(){
  const fileInput = $("csvImportFile");
  const file = fileInput.files[0];
  if(!file){ toast("Pehle CSV, Excel ya PDF file select karein", "error"); return; }

  const ext = file.name.split(".").pop().toLowerCase();

  if(ext === "csv"){
    const reader = new FileReader();
    reader.onload = (e) => {
      const lines = String(e.target.result).split(/\r?\n/).filter(l => l.trim().length);
      const rows = lines.map(parseCSVLine);
      processLabourImportRows(rows);
      fileInput.value = "";
    };
    reader.readAsText(file);
  } else if(ext === "xlsx" || ext === "xls"){
    if(typeof XLSX === "undefined"){
      toast("Excel Import library load nahi ho payi — Internet connection check karein", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try{
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "", raw: false });
        processLabourImportRows(rows);
      } catch(err){
        console.error("Excel padhne me error:", err);
        toast("Excel file padhne me dikkat hui — file sahi format me hai ya check karein", "error");
      }
      fileInput.value = "";
    };
    reader.readAsArrayBuffer(file);
  } else if(ext === "pdf"){
    if(typeof pdfjsLib === "undefined"){
      toast("PDF Import library load nahi ho payi — Internet connection check karein", "error");
      return;
    }
    toast("PDF padha ja raha hai...", "info");
    extractRowsFromPDF(file)
      .then(rows => {
        if(!rows.length){
          toast("PDF me se koi table data nahi mila — ho sakta hai ye scanned/image PDF ho, us case me CSV ya Excel use karein", "error");
          return;
        }
        processLabourImportRows(rows);
      })
      .catch(err => {
        console.error("PDF padhne me error:", err);
        toast("PDF padhne me dikkat hui — file sahi hai check karein", "error");
      })
      .finally(() => { fileInput.value = ""; });
  } else {
    toast("Sirf .csv, .xlsx, .xls ya .pdf file select karein", "error");
  }
}

/* PDF ki text-layer se row/column table nikalta hai — har text-item ki
   x/y position ke hisaab se lines (rows) aur columns banaye jaate hain.
   Sirf text-based PDF ke liye kaam karta hai (scanned/image PDF ke liye nahi). */
async function extractRowsFromPDF(file){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const allRows = [];

  for(let p = 1; p <= pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({ text: String(it.str || ""), x: it.transform[4], y: it.transform[5] }))
      .filter(it => it.text.trim().length);
    if(!items.length) continue;

    // Y ke hisaab se (upar se neeche) sort karke same-line items ek row me group karo
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lineRows = [];
    let current = [], lastY = null;
    const Y_TOL = 4;
    items.forEach(it => {
      if(lastY === null || Math.abs(it.y - lastY) <= Y_TOL){
        current.push(it);
      } else {
        lineRows.push(current);
        current = [it];
      }
      lastY = it.y;
    });
    if(current.length) lineRows.push(current);

    // Har row ke andar x-gap dekh kar columns banao
    lineRows.forEach(rowItems => {
      rowItems.sort((a, b) => a.x - b.x);
      const cells = [];
      let cellText = rowItems[0].text;
      let lastX = rowItems[0].x + rowItems[0].text.length * 4.2;
      const GAP_THRESHOLD = 9;
      for(let i = 1; i < rowItems.length; i++){
        const it = rowItems[i];
        if(it.x - lastX > GAP_THRESHOLD){
          cells.push(cellText.trim());
          cellText = it.text;
        } else {
          cellText += (/\s$/.test(cellText) ? "" : " ") + it.text;
        }
        lastX = it.x + it.text.length * 4.2;
      }
      cells.push(cellText.trim());
      if(cells.some(c => c)) allRows.push(cells);
    });
  }
  return allRows;
}

/* Header row ke naam se columns dhoondta hai (Jobcard / Name / Aadhar / Status).
   Sr.No / Serial No jaisa column jaan-bujhkar IGNORE hota hai — app khud apna
   number lagata hai, isliye file me chahe koi bhi Sr No column ho, use chhoda jaata hai. */
function detectImportColumns(headerRow){
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  let jobcard = -1, name = -1, aadhar = -1, status = -1;
  (headerRow || []).forEach((cell, idx) => {
    const h = norm(cell);
    if(!h) return;
    if(jobcard === -1 && /jobcard|jobno|jcno|jobcardno/.test(h)) jobcard = idx;
    else if(name === -1 && /name|naam/.test(h)) name = idx;
    else if(aadhar === -1 && /aadhar|aadhaar/.test(h)) aadhar = idx;
    else if(status === -1 && h === "status") status = idx;
    // "srno" / "slno" / "serialno" / "क्रसं" jaise column yahan match hi nahi karte — automatically skip
  });
  return { jobcard, name, aadhar, status };
}

function processLabourImportRows(rows){
  if(!rows || rows.length < 2){ toast("File khaali hai ya sirf header hai", "error"); return; }

  const header = rows[0] || [];
  let { jobcard: colJobcard, name: colName, aadhar: colAadhar, status: colStatus } = detectImportColumns(header);

  // Header ke naam se Jobcard + Name mile to wahi columns use karo (Sr.No column
  // kahin bhi ho, ye tareeqa use khud-b-khud ignore kar deta hai).
  // Nahi mile to purana fixed-position tareeqa — lekin agar pehla column
  // Sr.No/Serial jaisa dikhta hai to use bhi skip kar dete hain.
  if(colJobcard === -1 || colName === -1){
    const firstHeaderNorm = String(header[0] || "").toLowerCase().replace(/[^a-z]/g, "");
    const looksLikeSerial = /^(srno|sno|slno|serialno|serialnumber|sr|sl)$/.test(firstHeaderNorm);
    const base = looksLikeSerial ? 1 : 0;
    colJobcard = base; colName = base + 1; colAadhar = base + 2; colStatus = base + 3;
  }

  let added = 0, skipped = 0;
  for(let i = 1; i < rows.length; i++){
    const cols = rows[i] || [];
    const jobcardNo = String(cols[colJobcard] ?? "").trim();
    const name = String(cols[colName] ?? "").trim();
    let aadhar = colAadhar !== -1 ? String(cols[colAadhar] ?? "").trim() : "";
    let status = colStatus !== -1 ? String(cols[colStatus] ?? "").trim() : "";
    if(!["Active", "Inactive", "Completed"].includes(status)) status = "Active";

    if(!jobcardNo || !name){ skipped++; continue; }
    if(aadhar && !/^\d{12}$/.test(aadhar)){ aadhar = ""; }

    const dupAadhar = aadhar ? DATA.labours.find(l => l.aadhar === aadhar) : null;
    // Pati-patni same Jobcard use karte hain — 2 tak allowed, teesri baar hi skip
    const sameJobcardCount = DATA.labours.filter(l => shortJobcard(l.jobcardNo) === shortJobcard(jobcardNo)).length;
    if(dupAadhar || sameJobcardCount >= 2){ skipped++; continue; }

    DATA.labours.push({ id: makeId(), jobcardNo, name, aadhar, status });
    added++;
  }

  if(added > 0){
    persist();
    renderLabours();
    renderDemandLabourList();
    renderDashboard();
  }
  toast(`✅ ${added} Labour Import ho gaye` + (skipped ? `, ⚠️ ${skipped} skip ho gaye (Jobcard/Name khaali ya duplicate)` : ""));
}

/* ================================================================
   📋 MUSTROLL PASTE IMPORT — NREGA site se Table Copy-Paste karke
   Naam + Jobcard Number nikalna (OCR ki koi zaroorat nahi)
   (Labour Tab me seedha Add, Demand Tab me Fuzzy-Match karke Add)
================================================================ */

// "RJ-27160010180238400/516450772" jaisi kisi bhi string me se "/" ke baad wala short number
function shortJobcard(raw){
  const s = String(raw || "").trim();
  const idx = s.lastIndexOf("/");
  return (idx === -1 ? s : s.slice(idx + 1)).replace(/\D/g, "");
}

/* NREGA Mustroll table jab copy karke paste ki jaati hai, to har row ka
   "नाम/पंजीकरण संख्या" cell aksar 2 lines me hota hai — pehli line Naam
   (jaise "इमामत(Wife)"), doosri line WorkCode/Jobcard (jaise
   "RJ-271600.../516451313"). Yeh function dono ko dhoondh kar jodta hai.
   Tag — (Wife)/(Husband)/(Self) — sirf hata di jaati hai, usse koi
   matching nahi hoti, sirf shuddh Naam use hota hai. */
function parseMustrollPasteText(text){
  const rawLines = String(text || "").split(/\r?\n/);
  // Jobcard pattern: WorkCode (letters/digits/dashes) + "/" + sirf digits
  const jcRegex = /([A-Za-z0-9\-]{4,})\s*\/\s*(\d{5,15})\b/;
  const results = [];

  for(let i = 0; i < rawLines.length; i++){
    const line = rawLines[i];
    const m = line.match(jcRegex);
    if(!m) continue;
    const jobcard = m[2];

    // Pehle isi line par jobcard se pehle koi naam-jaisa text dhoondo
    let name = line.slice(0, m.index).replace(/\t/g, " ").trim();

    // Agar isi line par kuch nahi mila (jaise "RJ-.../516451313" line ki
    // shuruaat me hi hai), to naam PICHLI line se lo — real Mustroll paste
    // me yahi hota hai (Naam upar wali line par, Jobcard neeche)
    if(!name || name.length < 2){
      for(let j = i - 1; j >= Math.max(0, i - 2); j--){
        const parts = rawLines[j].split("\t").map(s => s.trim()).filter(Boolean);
        const cand = parts.length ? parts[parts.length - 1] : "";
        if(cand && cand.length > 1 && !jcRegex.test(cand) && !/^\d+\.?$/.test(cand)){
          name = cand;
          break;
        }
      }
    }

    // "(Wife)" / "(Husband)" / "(Self)" jaisa tag — kuch bhi ho — hata do,
    // sirf shuddh Naam bachao. Tag se koi matching nahi hoti.
    name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();

    if(name && jobcard) results.push({ name, jobcard });
  }
  return results;
}

/* Fuzzy Name Match Engine — Feature 2 ka core logic:
   1) Pehle Jobcard number se candidates dhoondo (ek jobcard par 2 Labour
      bhi ho sakte hain — pati/patni).
   2) Har candidate ke naam se paste-wale-naam ka Levenshtein match % nikalo.
   3) Best match >= 80% aur clearly sabse alag ho to "matched".
   4) Best match < 80% ho to "skip" (galat aadmi select hone se behtar
      hai chhod dena).
   5) Do candidates dono >= 80% ho AUR unka difference < 5% ho to
      "ambiguous" — auto-add NAHI hoga, user khud chunega. */
const MATCH_THRESHOLD = 80;
const AMBIGUOUS_GAP = 5;

function matchMustrollRowToLabour(pasteRow){
  const jc = shortJobcard(pasteRow.jobcard);
  const candidates = DATA.labours.filter(l => shortJobcard(l.jobcardNo) === jc);

  if(!candidates.length){
    return { pasteName: pasteRow.name, jobcard: jc, status: "notfound", labourId: null, matchPercent: 0, candidates: [] };
  }

  // Paste me naam nahi mila — sirf jobcard se match (single candidate ho to pakka)
  if(!pasteRow.name || !String(pasteRow.name).trim()){
    if(candidates.length === 1){
      return { pasteName: "", jobcard: jc, status: "matched", labourId: candidates[0].id,
               matchedName: candidates[0].name, matchPercent: 100, candidates: [] };
    }
    return { pasteName: "", jobcard: jc, status: "ambiguous", labourId: null, matchPercent: 0,
             candidates: candidates.map(c => ({ id: c.id, name: c.name, jobcardNo: c.jobcardNo, score: 0 })) };
  }

  const scored = candidates
    .map(c => ({ id: c.id, name: c.name, jobcardNo: c.jobcardNo, score: nameSimilarityPercent(pasteRow.name, c.name) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if(best.score < MATCH_THRESHOLD){
    return { pasteName: pasteRow.name, jobcard: jc, status: "skip", labourId: null, matchPercent: best.score, candidates: scored };
  }

  if(second && second.score >= MATCH_THRESHOLD && (best.score - second.score) < AMBIGUOUS_GAP){
    return { pasteName: pasteRow.name, jobcard: jc, status: "ambiguous", labourId: null, matchPercent: best.score, candidates: scored };
  }

  return {
    pasteName: pasteRow.name, jobcard: jc, status: "matched",
    labourId: best.id, matchedName: best.name, matchPercent: best.score, candidates: scored
  };
}

/* ---- Labour Tab: jobcard pehle se hai to naam UPDATE hoga (40%+ match par),
   nahi hai to naya Labour add hoga (max 2/jobcard cap ke saath) ---- */
let labourImportRows = [];
const LABOUR_UPDATE_THRESHOLD = 40; // ispar Labour tab me update-confidence decide hoti hai (Demand tab ke 80% se kam, kyunki jobcard number pehle se hi deterministic hai)

function scanMustrollForLabour(){
  const text = ($("labourMustrollPaste") && $("labourMustrollPaste").value) || "";
  if(!text.trim()){ toast("Pehle Mustroll table Paste Box me paste karein", "error"); return; }

  $("labourImportPreview").innerHTML = "";
  const rows = parseMustrollPasteText(text);

  if(!rows.length){
    toast("Paste kiye text me se koi naam-jobcard nahi mila. Table sahi se copy hui hai check karein.", "error");
    return;
  }

  const seenNewInBatch = {};   // jobcard -> isi batch me ab tak kitne NAYE add queue hue
  const usedExistingIds = new Set(); // ek existing Labour record isi batch me do baar update na ho

  labourImportRows = rows.map(r => {
    const jc = r.jobcard;
    const existing = DATA.labours.filter(l => shortJobcard(l.jobcardNo) === jc && !usedExistingIds.has(l.id));

    if(existing.length){
      // Jobcard pehle se Labour list me hai — naam se best-match candidate chuno aur UPDATE karo
      const scored = existing
        .map(l => ({ labour: l, score: nameSimilarityPercent(r.name, l.name) }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      usedExistingIds.add(best.labour.id);

      return {
        name: r.name, jobcard: jc,
        status: best.score >= LABOUR_UPDATE_THRESHOLD ? "update" : "review",
        labourId: best.labour.id, oldName: best.labour.name, score: best.score
      };
    }

    // Jobcard Labour list me nahi hai — naya Labour (max 2/jobcard isi batch me bhi)
    const willBe = (seenNewInBatch[jc] || 0) + 1;
    seenNewInBatch[jc] = willBe;

    return {
      name: r.name, jobcard: jc,
      status: willBe <= 2 ? "add" : "dup",
      note: willBe > 2 ? "Ye jobcard isi paste me 2 baar se zyada naya add ho raha hai" : ""
    };
  });

  renderLabourImportPreview();
}

function renderLabourImportPreview(){
  const box = $("labourImportPreview");
  const addCount = labourImportRows.filter(r => r.status === "add").length;
  const updateCount = labourImportRows.filter(r => r.status === "update").length;
  const reviewCount = labourImportRows.filter(r => r.status === "review").length;
  const dupCount = labourImportRows.filter(r => r.status === "dup").length;

  box.innerHTML = `
    <p style="font-size:13px;margin:10px 0 6px">
      <b>${labourImportRows.length}</b> naam mile —
      <b style="color:#1a7a3d">${addCount} Naye Add honge</b>,
      <b style="color:#2471a3">${updateCount} Update honge</b>
      ${reviewCount ? `, <b style="color:#b7791f">${reviewCount} Check karein</b>` : ""}
      ${dupCount ? `, <b style="color:#c0392b">${dupCount} Duplicate (skip)</b>` : ""}
    </p>
    <div class="chk-list">
      ${labourImportRows.map((r, i) => {
        if(r.status === "add") return `
        <div class="chk-item">
          <input type="checkbox" class="labour-import-chk" data-idx="${i}" checked>
          <div style="flex:1">
            <div>${escapeHtml(r.name)} <span class="badge active">Naya Add hoga</span></div>
            <div style="font-size:12px;color:var(--muted)">Jobcard: ${escapeHtml(r.jobcard)}</div>
          </div>
        </div>`;

        if(r.status === "update" || r.status === "review") return `
        <div class="chk-item">
          <input type="checkbox" class="labour-import-chk" data-idx="${i}" ${r.status === "update" ? "checked" : ""}>
          <div style="flex:1">
            <div>${escapeHtml(r.name)} <span class="badge" style="${r.status === "update" ? "background:#dceefb;color:#2471a3" : "background:#fdf0d5;color:#b7791f"}">${r.status === "update" ? "Update hoga" : "Check karein"} (${r.score}%)</span></div>
            <div style="font-size:12px;color:var(--muted)">Jobcard: ${escapeHtml(r.jobcard)} — Abhi: <b>${escapeHtml(r.oldName)}</b> → Paste: <b>${escapeHtml(r.name)}</b></div>
          </div>
        </div>`;

        return `
        <div class="chk-item">
          <input type="checkbox" class="labour-import-chk" data-idx="${i}" disabled>
          <div style="flex:1">
            <div>${escapeHtml(r.name)} <span class="badge inactive">Duplicate</span></div>
            <div style="font-size:12px;color:var(--muted)">Jobcard: ${escapeHtml(r.jobcard)}${r.note ? " — " + r.note : ""}</div>
          </div>
        </div>`;
      }).join("")}
    </div>
    <button class="btn btn-green mt" onclick="confirmLabourImport()">✅ Confirm karein</button>
  `;
}

function confirmLabourImport(){
  const checks = Array.from(document.querySelectorAll(".labour-import-chk:checked"));
  if(!checks.length){ toast("Koi bhi add/update karne layak entry nahi hai", "error"); return; }

  let added = 0, updated = 0;
  checks.forEach(chk => {
    const r = labourImportRows[parseInt(chk.dataset.idx, 10)];
    if(!r) return;

    if(r.status === "update" || r.status === "review"){
      const lab = DATA.labours.find(l => l.id === r.labourId);
      if(lab){ lab.name = r.name; updated++; }
      return;
    }

    DATA.labours.push({ id: makeId(), jobcardNo: r.jobcard, name: r.name, aadhar: "", status: "Active" });
    added++;
  });

  persist();
  renderLabours();
  renderDemandLabourList();
  renderDashboard();
  labourImportRows = [];
  $("labourImportPreview").innerHTML = "";
  if($("labourMustrollPaste")) $("labourMustrollPaste").value = "";
  toast(`${added} naye Labour add hue${updated ? `, ${updated} Labour ka naam update hua` : ""}`);
}

/* ---- Demand Mustroll Paste option hata diya gaya — ab sab kuch ⚡ Ek Paste se hota hai ---- */

/* ================================================================
   ⚡ ONE PASTE — Ek Paste se Demand + Payment + AC Credit
   Mustroll row se Naam, Jobcard, Payment (कुल नकद भुगतान),
   Status aur Credited Date sab nikalta hai.
================================================================ */

// "20/08/2026" ya "20-08-2026" ko ISO "2026-08-20" me badalta hai
function parseDDMMYYYY(str){
  const m = String(str || "").trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(!m) return "";
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/* Mustroll paste ka FULL parser — Naam + Jobcard ke saath payment columns bhi:
   Do format support:
   A) Full jobcard:  "RJ-271600101802038400/2510304"  (naam pichli line / same line se)
   B) Naam+Jobcard cell: "इनायता / 2510304"  (Devanagari naam, same cell me)
   Payment: [totalDays, dailyWage, deyaRashi] triple (days × wage = deya) se,
   aur uske baad [yatra, auzar, totalCash] ho to कुल नकद भुगतान = totalCash. */
function parseMustrollFullPaste(text){
  const rawLines = String(text || "").split(/\r?\n/);
  const jcRegexA = /([A-Za-z]{2,3}-[0-9A-Za-z\-]{3,})\s*\/\s*(\d{5,15})\b/;
  const jcRegexB = /([\p{L}\p{M}][\p{L}\p{M} .'\-]{1,60}?)\s*\/\s*(\d{5,15})\b/u;
  const results = [];

  for(let i = 0; i < rawLines.length; i++){
    const line = rawLines[i];
    let m = line.match(jcRegexA);
    let nameInCell = "";
    if(!m){
      m = line.match(jcRegexB);
      if(m) nameInCell = (m[1] || "").trim();
    }
    if(!m) continue;
    const jobcard = m[2];

    // Naam — same cell se (format B), nahi to jobcard se pehle isi line par,
    // nahi to pichli line se
    let name = nameInCell;
    if(!name) name = line.slice(0, m.index).replace(/\t/g, " ").trim();
    // shuruaat ka serial number hatao ("1", "1.", "2)" aadi)
    name = name.replace(/^\d+[\.\)]?\s*/, "").replace(/[\/\s.\-]+$/, "").trim();
    if(!name || name.length < 2){
      for(let j = i - 1; j >= Math.max(0, i - 2); j--){
        const parts = rawLines[j].split("\t").map(s => s.trim()).filter(Boolean);
        const cand = parts.length ? parts[parts.length - 1] : "";
        if(cand && cand.length > 1 && !jcRegexA.test(cand) && !jcRegexB.test(cand) && !/^\d+\.?$/.test(cand)){
          name = cand;
          break;
        }
      }
    }
    name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();

    // Payment columns — jobcard wali line ke tabs se.
    // Amount dhoondhne ka SMART tareeqa: Mustroll me 3 lagatar numeric columns
    // hote hain [totalDays, dailyWage, कुल नकद भुगतान] jahan days × wage = amount.
    // Fixed column-index column-count badalne par tut jaata hai, isliye yeh pattern
    // se dhoondte hain. (12 din × ₹260 = ₹3120 jaisa)
    const cols = line.split("\t").map(c => c.trim());
    const num = s => /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;

    let amount = 0, days = 0, wage = 0;
    for(let k = 0; k + 2 < cols.length; k++){
      const dD = num(cols[k]), dW = num(cols[k + 1]), total = num(cols[k + 2]);
      if(!isNaN(dD) && !isNaN(dW) && !isNaN(total) && dD > 0 && dW > 0 &&
         Math.abs(dD * dW - total) < 1){
        amount = total; days = dD; wage = dW;
        // देय राशि ke baad [यात्रा/खानपान, औज़ार, कुल नकद भुगतान] ho to
        // कुल नकद भुगतान hi final amount hai (deya + yatra + auzar = totalCash)
        const yat = num(cols[k + 3]), auz = num(cols[k + 4]), tc = num(cols[k + 5]);
        if(!isNaN(tc) && Math.abs(total + (isNaN(yat) ? 0 : yat) + (isNaN(auz) ? 0 : auz) - tc) < 1){
          amount = tc;
        }
        break;
      }
    }
    // Fallback — purana fixed-index tareeqa (aakhiri 15 columns me 6th = totalCash)
    if(!amount){
      const trailing = cols.slice(-15);
      amount = parseFloat(trailing[5]) || 0;
    }

    // Credited Date — koi bhi dd/mm/yyyy token; Status — uske theek pehle wala
    // non-empty, non-numeric token (jaise "Processed")
    let status = "", creditedDateRaw = "";
    for(let k = 0; k < cols.length; k++){
      if(/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}$/.test(cols[k])){
        creditedDateRaw = cols[k];
        for(let j = k - 1; j >= 0; j--){
          if(cols[j] && isNaN(num(cols[j])) && !/^\d{1,2}[\/\-.]/.test(cols[j])){
            status = cols[j];
            break;
          }
        }
        break;
      }
    }
    // Status fallback — date na mile to aakhiri columns me jaane-pehchane
    // status shabd dhoondho (Processed / Credited / Pending / Rejected aadi)
    if(!status){
      for(let k = cols.length - 1; k >= 0; k--){
        if(/processed|credited|success|paid|sent|pending|reject|fail|hold/i.test(cols[k] || "")){
          status = cols[k];
          break;
        }
      }
    }

    // Naam na mile to bhi row rakho — jobcard se labour match ho sakta hai
    if(jobcard){
      results.push({
        name, jobcard, amount, days, wage, status,
        creditedDate: parseDDMMYYYY(creditedDateRaw)
      });
    }
  }
  return results;
}

let onePasteRows = [];

function scanOnePaste(){
  const text = ($("onePasteText") && $("onePasteText").value) || "";
  if(!text.trim()){ toast("Pehle Mustroll table Paste Box me paste karein", "error"); return; }
  if(!$("onePasteDate").value) $("onePasteDate").value = todayISO();

  $("onePastePreview").innerHTML = "";
  const parsed = parseMustrollFullPaste(text);
  if(!parsed.length){
    toast("Paste kiye text me se koi naam-jobcard nahi mila. Table sahi se copy hui hai check karein.", "error");
    return;
  }

  onePasteRows = parsed.map(r => {
    const match = matchMustrollRowToLabour(r);
    return { ...r, match };
  });
  renderOnePastePreview();
}

function renderOnePastePreview(){
  const box = $("onePastePreview");
  const date = $("onePasteDate").value;

  const counts = { credited: 0, pending: 0, noAmount: 0 };
  onePasteRows.forEach(r => {
    if(!r.amount || r.amount <= 0) counts.noAmount++;
    else if(r.status || r.creditedDate) counts.credited++;
    else counts.pending++;
  });

  box.innerHTML = `
    <div class="stat-strip mt">
      <div class="sum-card"><div class="v">${onePasteRows.length}</div><div class="l">Total Rows mili</div></div>
      <div class="sum-card"><div class="v" style="color:#146c33">${counts.credited}</div><div class="l">AC Credit honge ✅</div></div>
      <div class="sum-card"><div class="v" style="color:#b05e0d">${counts.pending}</div><div class="l">Pending rahenge ⏳</div></div>
      ${counts.noAmount ? `<div class="sum-card"><div class="v" style="color:#c0392b">${counts.noAmount}</div><div class="l">Amount nahi mila ⚠️</div></div>` : ""}
    </div>
    <div class="chk-list" style="max-height:380px">
      ${onePasteRows.map((r, i) => {
        const isCredited = !!(r.status || r.creditedDate);
        const acBadge = isCredited
          ? `<span class="badge credited">AC Credit ${r.creditedDate ? "(" + fmtDate(r.creditedDate) + ")" : ""}</span>`
          : `<span class="badge pending">Pending</span>`;

        let matchHtml = "";
        if(r.match.status === "matched"){
          matchHtml = `<div style="font-size:12px;color:var(--muted)">✅ List me mila: <b>${escapeHtml(r.match.matchedName)}</b> (${r.match.matchPercent}%)</div>`;
        } else if(r.match.status === "notfound"){
          matchHtml = `<div style="font-size:12px;color:#2471a3">🆕 Naya Labour ban jayega (list me nahi mila)</div>`;
        } else if(r.match.status === "ambiguous"){
          matchHtml = `<div style="font-size:12px;color:#b05e0d;margin-bottom:3px">⚠️ 2 log match ho rahe — sahi wala chunein:</div>` +
            r.match.candidates.filter(c => c.score >= MATCH_THRESHOLD).map(c => `
              <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;margin-top:3px">
                <input type="radio" name="onepaste-ambig-${i}" class="onepaste-pick" data-idx="${i}" value="${c.id}">
                ${escapeHtml(c.name)} <span style="color:var(--muted)">(${c.score}%)</span>
              </label>`).join("");
        } else { // skip — naam match kam, user khud chune
          matchHtml = `<div style="font-size:12px;color:#b05e0d;margin-bottom:3px">⚠️ Naam match kam hai — sahi Labour chunein:</div>` +
            r.match.candidates.map(c => `
              <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;margin-top:3px">
                <input type="radio" name="onepaste-skip-${i}" class="onepaste-pick" data-idx="${i}" value="${c.id}">
                ${escapeHtml(c.name)} <span style="color:var(--muted)">(${c.score}%)</span>
              </label>`).join("");
        }

        const alreadyDemand = r.match.labourId && DATA.demands.some(d => d.date === date && d.labourId === r.match.labourId);
        const alreadyPaid = r.match.labourId && DATA.payments.some(p => p.date === date && p.labourId === r.match.labourId);

        return `
        <div class="chk-item">
          <input type="checkbox" class="onepaste-chk" data-idx="${i}" checked>
          <div style="flex:1">
            <div><b>${escapeHtml(r.name)}</b> ${acBadge}</div>
            <div style="font-size:12px;color:var(--muted)">Jobcard: ${escapeHtml(r.jobcard)}${r.status ? " — Status: " + escapeHtml(r.status) : ""}</div>
            ${matchHtml}
            ${alreadyPaid ? `<div style="font-size:12px;color:#b7791f;margin-top:3px">⚠️ Is date ki Payment pehle se hai — dobara nahi banegi</div>` : (alreadyDemand ? `<div style="font-size:12px;color:#b7791f;margin-top:3px">⚠️ Is date ki Demand pehle se hai — sirf Payment banegi</div>` : "")}
          </div>
          <input type="number" class="amt-in onepaste-amt" data-idx="${i}" value="${r.amount || ""}" placeholder="₹" min="0" style="width:100px">
        </div>`;
      }).join("")}
    </div>
    <button class="btn btn-green mt" onclick="confirmOnePaste()">✅ Confirm — Sab Kuch Add Karein</button>
  `;
}

function confirmOnePaste(){
  const date = $("onePasteDate").value;
  if(!date){ toast("Pehle Demand Date select karein", "error"); return; }

  const checks = Array.from(document.querySelectorAll(".onepaste-chk:checked"));
  if(!checks.length){ toast("Koi bhi add karne layak entry nahi hai", "error"); return; }

  let addedDemand = 0, addedPayment = 0, addedCredit = 0, addedLabour = 0, skippedNoPick = 0, skippedNoAmount = 0;

  checks.forEach(chk => {
    const idx = parseInt(chk.dataset.idx, 10);
    const r = onePasteRows[idx];
    if(!r) return;

    const amtInput = document.querySelector(`.onepaste-amt[data-idx="${idx}"]`);
    const amount = amtInput ? parseFloat(amtInput.value) : r.amount;
    if(!amount || amount <= 0){ skippedNoAmount++; return; }

    let labourId = r.match.labourId;

    // Ambiguous / kam-match rows — user ne radio se chuna hoga
    if(r.match.status === "ambiguous" || r.match.status === "skip"){
      const picked = document.querySelector(`.onepaste-pick[data-idx="${idx}"]:checked`);
      if(!picked){ skippedNoPick++; return; }
      labourId = picked.value;
    }

    // List me nahi mila — naya Labour banao
    if(!labourId && r.match.status === "notfound"){
      const newLabour = { id: makeId(), jobcardNo: r.jobcard, name: r.name, aadhar: "", status: "Active" };
      DATA.labours.push(newLabour);
      labourId = newLabour.id;
      addedLabour++;
    }
    if(!labourId) return;

    // 1) Demand — agar is date ki pehle se nahi hai (Mustroll se Kul Din / Pratidin bhi aa jata hai)
    if(!DATA.demands.some(d => d.date === date && d.labourId === labourId)){
      DATA.demands.push({ id: makeId(), date, labourId,
        kulDin: r.days || "", kulHajri: r.days || "", pratidin: r.wage || "", comment: "" });
      addedDemand++;
    }

    // 2) Payment — agar is date ki pehle se nahi hai (Amount ka aadha Mate Share, aadha Labour Share)
    if(!DATA.payments.some(p => p.date === date && p.labourId === labourId)){
      const mateShare = amount * 0.5;
      const labourShare = amount * 0.5;
      DATA.payments.push({ id: makeId(), date, labourId, amount, mateShare, labourShare });
      addedPayment++;

      // 3) AC Credit — Status ya Credited Date bhara ho to seedha Credited
      if(r.status || r.creditedDate){
        DATA.acCredits.push({
          id: makeId(), date, labourId, status: "Credited",
          creditedDate: r.creditedDate || todayISO()
        });
        addedCredit++;
      }
    }
  });

  persist();
  renderAll();
  onePasteRows = [];
  $("onePastePreview").innerHTML = "";
  if($("onePasteText")) $("onePasteText").value = "";

  let msg = `✅ ${addedPayment} Payment + ${addedDemand} Demand ban gayi`;
  if(addedCredit) msg += `, ${addedCredit} AC Credit bhi ho gaya`;
  if(addedLabour) msg += `, ${addedLabour} naye Labour bane`;
  if(skippedNoPick) msg += `, ${skippedNoPick} rows skip (Labour choose nahi kiya)`;
  if(skippedNoAmount) msg += `, ${skippedNoAmount} rows skip (Amount nahi mila)`;
  toast(msg, addedPayment || addedDemand || addedLabour ? "success" : "info");
}

/* ================================================================
   TAB 1: LABOUR
================================================================ */
let editingLabourId = null;

function saveLabour(){
  const jobcardNo = $("labJobcard").value.trim();
  const name = $("labName").value.trim();
  const aadhar = $("labAadhar").value.trim();
  const status = $("labStatus").value;

  // Aadhar ab OPTIONAL hai — sirf Jobcard No. aur Name zaroori hain
  if(!jobcardNo || !name){ toast("Jobcard No. aur Name bharna zaroori hai", "error"); return; }
  if(aadhar && !/^\d{12}$/.test(aadhar)){ toast("Agar Aadhar No. bharte hain to poore 12 digit ka hona chahiye", "error"); return; }

  const dupAadhar = aadhar ? DATA.labours.find(l => l.aadhar === aadhar && l.id !== editingLabourId) : null;
  if(dupAadhar){
    toast(`Yeh Aadhar No. pehle se hai — ${dupAadhar.name} (Jobcard ${dupAadhar.jobcardNo})`, "error");
    return;
  }
  // Pati-patni same Jobcard use karte hain — isliye ek Jobcard max 2 baar allowed hai,
  // teesri baar (same jobcard) par hi rokna hai
  const sameJobcardCount = DATA.labours.filter(l => shortJobcard(l.jobcardNo) === shortJobcard(jobcardNo) && l.id !== editingLabourId).length;
  if(sameJobcardCount >= 2){
    toast("Yeh Jobcard No. pehle se 2 baar hai (pati-patni tak allowed) — teesri baar add nahi ho sakta", "error");
    return;
  }

  if(editingLabourId){
    const idx = DATA.labours.findIndex(l => l.id === editingLabourId);
    if(idx > -1) DATA.labours[idx] = { id: editingLabourId, jobcardNo, name, aadhar, status };
    toast("Labour update ho gaya");
    cancelLabourEdit();
  } else {
    DATA.labours.push({ id: makeId(), jobcardNo, name, aadhar, status });
    toast("Labour add ho gaya");
    $("labJobcard").value = "";
    $("labName").value = "";
    $("labAadhar").value = "";
    $("labStatus").value = "Active";
  }

  persist();
  renderLabours();
  renderDemandLabourList();
}

function editLabour(id){
  const l = DATA.labours.find(x => x.id === id);
  if(!l) return;
  editingLabourId = id;
  $("labJobcard").value = l.jobcardNo;
  $("labName").value = l.name;
  $("labAadhar").value = l.aadhar;
  $("labStatus").value = l.status;
  $("labourFormTitle").textContent = "✏️ Edit Labour";
  $("labSaveBtn").textContent = "💾 Update Labour";
  $("labCancelBtn").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelLabourEdit(){
  editingLabourId = null;
  $("labJobcard").value = "";
  $("labName").value = "";
  $("labAadhar").value = "";
  $("labStatus").value = "Active";
  $("labourFormTitle").textContent = "➕ Add Labour";
  $("labSaveBtn").textContent = "💾 Save Labour";
  $("labCancelBtn").classList.add("hidden");
}

function deleteLabour(id){
  showConfirm("Kya aap is Labour ko delete karna chahte hain? Recycle Bin se wapas la sakte hain.", () => {
    const labour = DATA.labours.find(l => l.id === id);
    if(labour) moveToTrash("labour", [labour]);
    DATA.labours = DATA.labours.filter(l => l.id !== id);
    persist();
    renderAll();
    toast("Labour Recycle Bin me chala gaya");
  });
}

function toggleLabSelectAll(){
  const checked = $("labSelectAll").checked;
  document.querySelectorAll(".lab-row-chk").forEach(chk => chk.checked = checked);
}

function updateSelectedLaboursStatus(){
  const checked = Array.from(document.querySelectorAll(".lab-row-chk:checked"));
  if(!checked.length){ toast("Pehle kam se kam ek Labour select karein", "error"); return; }

  const newStatus = $("labBulkStatus").value;
  const ids = checked.map(chk => chk.value);

  showConfirm(`${ids.length} Labour ka Status "${newStatus}" kar dein?`, () => {
    DATA.labours.forEach(l => {
      if(ids.includes(l.id)) l.status = newStatus;
    });
    persist();
    renderAll();
    $("labSelectAll").checked = false;
    toast(`${ids.length} Labour ka Status "${newStatus}" ho gaya`);
  });
}

function deleteSelectedLabours(){
  const checked = Array.from(document.querySelectorAll(".lab-row-chk:checked"));
  if(!checked.length){ toast("Pehle kam se kam ek Labour select karein", "error"); return; }

  showConfirm(`${checked.length} Labour delete karni hain? Ek hi click se sab Recycle Bin se wapas la sakte hain.`, () => {
    const ids = checked.map(chk => chk.value);
    const labours = DATA.labours.filter(l => ids.includes(l.id));
    moveToTrash("labour", labours);
    DATA.labours = DATA.labours.filter(l => !ids.includes(l.id));
    persist();
    renderAll();
    $("labSelectAll").checked = false;
    toast(`${ids.length} Labour Recycle Bin me chale gaye`);
  });
}

function clearAllLabours(){
  if(!DATA.labours.length){ toast("Labour List pehle se khaali hai", "info"); return; }
  showConfirm(`Pura Labour List (${DATA.labours.length} Labour) clear karna hai?`, () => {
    DATA = { labours: [], demands: [], payments: [], acCredits: [], trash: [] };
    persist();
    renderAll();
    toast("Pura Labour List clear ho gaya");
  }, "Sab Kuch Clear Karein?");
}

function renderLabours(){
  const term = ($("labSearch").value || "").trim().toLowerCase();
  const filter = $("labFilter").value;

  let list = DATA.labours.slice().sort((a, b) => String(a.jobcardNo).localeCompare(String(b.jobcardNo)));
  if(term){
    list = list.filter(l =>
      l.name.toLowerCase().includes(term) ||
      String(l.jobcardNo).toLowerCase().includes(term) ||
      l.aadhar.includes(term)
    );
  }
  if(filter) list = list.filter(l => l.status === filter);

  $("labourCount").textContent = "(" + list.length + " Labour)";

  $("labourTableBody").innerHTML = list.map((l, i) => `
    <tr>
      <td><input type="checkbox" class="lab-row-chk" value="${l.id}"></td>
      <td>${i + 1}</td>
      <td>${escapeHtml(l.jobcardNo)}</td>
      <td>${escapeHtml(l.name)}</td>
      <td>${escapeHtml(l.aadhar)}</td>
      <td><span class="badge ${l.status.toLowerCase()}">${l.status}</span></td>
      <td>
        <button class="btn btn-blue btn-sm" onclick="editLabour('${l.id}')">Edit</button>
        <button class="btn btn-red btn-sm" onclick="deleteLabour('${l.id}')">Delete</button>
      </td>
    </tr>
  `).join("");
  $("labourEmpty").classList.toggle("hidden", list.length > 0);
  $("labSelectAll").checked = false;
}


/* ================================================================
   👷 LABOUR PRINT / PDF — Status filter (Active/Inactive/Completed/All)
   me jo select hai wahi list Print ya PDF me aayegi
================================================================ */
function getPrintableLabours(){
  const term = ($("labSearch") && $("labSearch").value || "").trim().toLowerCase();
  const filter = $("labFilter") ? $("labFilter").value : "";
  let list = DATA.labours.slice().sort((a, b) => String(a.jobcardNo).localeCompare(String(b.jobcardNo)));
  if(term){
    list = list.filter(l =>
      l.name.toLowerCase().includes(term) ||
      String(l.jobcardNo).toLowerCase().includes(term) ||
      (l.aadhar || "").includes(term)
    );
  }
  if(filter) list = list.filter(l => l.status === filter);
  return { list, filter };
}

function labourPrintDocHtml(pageRows, filter, pageNum, totalPages, startIndex){
  const rows = pageRows.map((l, i) => `
    <tr><td style="border:1px solid #000;padding:6px;text-align:center">${startIndex + i + 1}</td>
      <td style="border:1px solid #000;padding:6px">${escapeHtml(l.jobcardNo)}</td>
      <td style="border:1px solid #000;padding:6px">${escapeHtml(l.name)}</td>
      <td style="border:1px solid #000;padding:6px">${escapeHtml(l.aadhar || "")}</td>
      <td style="border:1px solid #000;padding:6px;text-align:center">${l.status}</td></tr>`).join("");
  return `
    <div style="font-family:'Hind',Arial,sans-serif;color:#000;background:#fff;padding:6px;border:1px solid #000">
      <h2 style="text-align:center;font-size:17px;margin:0">👷 Labour List — ${filter || "All Status"}</h2>
      <p style="text-align:center;font-size:11.5px;margin:4px 0 12px">Labour Job Card System — ${fmtDate(todayISO())}${totalPages > 1 ? ` — Page ${pageNum}/${totalPages}` : ""}</p>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr>
          <th style="border:1px solid #000;padding:6px;background:#f0f0f0;width:40px">#</th>
          <th style="border:1px solid #000;padding:6px;background:#f0f0f0">Jobcard No.</th>
          <th style="border:1px solid #000;padding:6px;background:#f0f0f0">Name</th>
          <th style="border:1px solid #000;padding:6px;background:#f0f0f0">Aadhar</th>
          <th style="border:1px solid #000;padding:6px;background:#f0f0f0">Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="text-align:right;font-size:10.5px;color:#444;margin-top:14px;border-top:1px solid #999;padding-top:5px">Developed by Kurban Ali</p>
    </div>`;
}

function printLabourList(){
  const { list, filter } = getPrintableLabours();
  if(!list.length){ toast("Is filter me koi Labour nahi hai", "error"); return; }
  $("labourPrintArea").innerHTML = labourPrintDocHtml(list, filter, 1, 1, 0);
  document.body.classList.add("print-labour");
  window.print();
  setTimeout(() => document.body.classList.remove("print-labour"), 500);
}

async function downloadLabourPDF(){
  const { list, filter } = getPrintableLabours();
  if(!list.length){ toast("Is filter me koi Labour nahi hai", "error"); return; }
  if(typeof window.jspdf === "undefined" || typeof html2canvas === "undefined"){
    toast("PDF library load nahi hui — Internet check karke dobara try karein", "error"); return;
  }
  toast("PDF taiyar ho raha hai...", "info");
  try{
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 4;
    const ROWS_PER_PAGE = 30;
    const chunks = [];
    for(let i = 0; i < list.length; i += ROWS_PER_PAGE) chunks.push(list.slice(i, i + ROWS_PER_PAGE));

    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:700px;background:#fff";
    document.body.appendChild(container);
    try{
      for(let p = 0; p < chunks.length; p++){
        container.innerHTML = labourPrintDocHtml(chunks[p], filter, p + 1, chunks.length, p * ROWS_PER_PAGE);
        await new Promise(r => setTimeout(r, 60));
        const canvas = await html2canvas(container.firstElementChild, { scale: 2, backgroundColor: "#ffffff", logging: false });
        if(!canvas || !canvas.width) throw new Error("blank canvas");
        const imgWidth = pageWidth - margin * 2;
        const imgHeight = Math.min((canvas.height * imgWidth) / canvas.width, pageHeight - margin * 2);
        if(p > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/png", 1.0), "PNG", margin, margin, imgWidth, imgHeight);
      }
    } finally { document.body.removeChild(container); }
    pdf.save(`Labour_List_${filter || "All"}_${todayISO()}.pdf`);
    toast("PDF Download ho gaya");
  }catch(err){
    console.error("Labour PDF error:", err);
    toast("PDF banane me dikkat hui, dobara try karein", "error");
  }
}

/* ================================================================
   TAB 2: DEMAND (ab 🗂️ Past tab ke andar hai)
================================================================ */
// Search badalne par bhi selection bani rahe — isliye checkbox state ko
// isi persistent Set me track karte hain, DOM re-render pe nahi khoti
let demandSelected = new Set();

function renderDemandLabourList(){
  const date = $("demandDate").value;
  const term = ($("demandLabourSearch").value || "").trim().toLowerCase();
  const box = $("demandLabourList");

  if(!DATA.labours.length){
    box.innerHTML = `<div class="empty">Pehle Labour Tab me Labour add karein.</div>`;
    return;
  }
  const existingIds = date ? DATA.demands.filter(d => d.date === date).map(d => d.labourId) : [];

  let list = DATA.labours.slice().sort((a, b) => String(a.jobcardNo).localeCompare(String(b.jobcardNo)));
  if(term){
    list = list.filter(l =>
      l.name.toLowerCase().includes(term) || String(l.jobcardNo).toLowerCase().includes(term)
    );
  }

  // Jo pehle se disabled honge unhe select-set se bhi hata do (data-consistency)
  DATA.labours.forEach(l => { if(existingIds.includes(l.id)) demandSelected.delete(l.id); });

  if(!list.length){
    box.innerHTML = `<div class="empty">Koi Labour nahi mila.</div>`;
    $("demandSelectAll").checked = false;
    updateDemandSelectedCount();
    return;
  }

  box.innerHTML = list.map(l => `
    <div class="chk-item">
      <input type="checkbox" class="demand-chk" value="${l.id}"
        ${existingIds.includes(l.id) ? "checked disabled" : (demandSelected.has(l.id) ? "checked" : "")}
        onchange="toggleDemandSelect('${l.id}', this.checked)">
      <div style="flex:1">
        <div>${escapeHtml(l.name)} <span class="badge ${l.status.toLowerCase()}">${l.status}</span></div>
        <div style="font-size:12px;color:var(--muted)">Jobcard: ${escapeHtml(l.jobcardNo)}</div>
      </div>
    </div>
  `).join("");

  const selectable = list.filter(l => !existingIds.includes(l.id));
  $("demandSelectAll").checked = selectable.length > 0 && selectable.every(l => demandSelected.has(l.id));
  updateDemandSelectedCount();
}

function toggleDemandSelect(id, checked){
  if(checked) demandSelected.add(id); else demandSelected.delete(id);
  updateDemandSelectedCount();
}

function toggleDemandSelectAll(){
  const checked = $("demandSelectAll").checked;
  document.querySelectorAll(".demand-chk:not(:disabled)").forEach(c => {
    c.checked = checked;
    if(checked) demandSelected.add(c.value); else demandSelected.delete(c.value);
  });
  updateDemandSelectedCount();
}

function updateDemandSelectedCount(){
  const el = $("demandSelectedCount");
  if(el) el.textContent = `${demandSelected.size} selected`;
}

function addDemand(){
  const date = $("demandDate").value;
  if(!date){ toast("Pehle Date select karein", "error"); return; }

  if(!demandSelected.size){ toast("Kam se kam ek Labour select karein", "error"); return; }

  let count = 0;
  demandSelected.forEach(labourId => {
    const already = DATA.demands.find(d => d.date === date && d.labourId === labourId);
    if(!already){
      DATA.demands.push({ id: makeId(), date, labourId, kulDin: "", kulHajri: "", pratidin: "", comment: "" });
      count++;
    }
  });

  demandSelected.clear();
  persist();
  toast(`${count} Demand add ho gayi`);
  renderDemandLabourList();
  renderDemands();
}

/* ---------------------------------------------------------------
   BULK COMMENT APPLY — Past Tab Demand List
--------------------------------------------------------------- */
function bulkApplyComment(){
  const text = ($("bulkCommentText") && $("bulkCommentText").value) || "";
  const checked = Array.from(document.querySelectorAll(".demand-row-chk:checked")).map(c => c.value);
  if(!checked.length){ toast("Pehle Demand List se kam se kam ek Demand select karein", "error"); return; }
  if(!text.trim()){ toast("Comment box khaali hai — pehle comment likhein", "error"); return; }
  checked.forEach(id => {
    const d = DATA.demands.find(x => x.id === id);
    if(d) d.comment = text.trim();
  });
  persist();
  renderDemands();
  toast(checked.length + " Demand pe comment lag gaya", "success");
}

// Sabhi Demand Dates ki list — click karke us din ka data khulta/band hota hai
function renderDemandDates(){
  const box = $("demandDatesList");
  if(!box) return;
  const dates = [...new Set(DATA.demands.map(d => d.date))].sort().reverse();
  if(!dates.length){ box.innerHTML = `<div class="empty">Koi Demand nahi hai.</div>`; return; }

  box.innerHTML = dates.map((dt, i) => {
    const entries = DATA.demands.filter(d => d.date === dt);
    const itemsHtml = entries.map(e => {
      const l = DATA.labours.find(x => x.id === e.labourId) || {};
      const p = DATA.payments.find(x => x.date === dt && x.labourId === e.labourId);
      const hasComment = e.comment && String(e.comment).trim();
      return `
        <div class="dd-item">
          <span>${escapeHtml(l.name || "—")} — ${e.kulDin || 0} Din</span>
          <span>₹${p ? p.amount : 0} ${hasComment ? `<span class="badge active">${escapeHtml(e.comment)}</span>` : `<span class="badge pending">Khaali</span>`}</span>
        </div>`;
    }).join("");
    return `
      <div class="dd-date-row" onclick="toggleDemandDate(${i})">
        <span>📅 ${fmtDate(dt)}</span><span class="dd-count">${entries.length} Labour</span>
      </div>
      <div class="dd-detail" id="ddDetail-${i}">${itemsHtml}</div>
    `;
  }).join("");
}
function toggleDemandDate(i){
  const el = $("ddDetail-" + i);
  if(el) el.classList.toggle("open");
}

// Jin Demand ka payment CREDIT ho chuka hai lekin Comment abhi bhi khaali hai
// (matlab paisa bank se aa gaya, par Labour ko mila ya nahi confirm nahi hai) —
// Pending (abhi Credit hi nahi hua) waalon ka comment khaali hona to normal hai,
// unhe yahan nahi dikhaya jaata
// Data taiyar karta hai (screen render aur PDF dono isi ko use karte hain)
function getPaymentPendingData(){
  const pending = DATA.demands.filter(d => {
    const hasComment = d.comment && String(d.comment).trim();
    if(hasComment) return false;
    const ac = DATA.acCredits.find(x => x.date === d.date && x.labourId === d.labourId);
    return ac && ac.status === "Credited";
  });

  const byLabour = {};
  pending.forEach(d => { if(!byLabour[d.labourId]) byLabour[d.labourId] = []; byLabour[d.labourId].push(d); });

  let bulkTotal = 0, bulkCount = 0;
  const groups = Object.keys(byLabour).map(labourId => {
    const l = DATA.labours.find(x => x.id === labourId) || {};
    let total = 0;
    const items = byLabour[labourId].slice().sort((a, b) => a.date.localeCompare(b.date)).map(d => {
      const p = DATA.payments.find(x => x.date === d.date && x.labourId === labourId);
      const amt = p ? (p.amount || 0) : 0;
      total += amt; bulkCount++;
      return { demandId: d.id, date: d.date, kulDin: d.kulDin || 0, amt };
    });
    bulkTotal += total;
    return { labour: l, items, total };
  });

  return { groups, bulkTotal, bulkCount };
}

function renderPaymentPending(){
  const box = $("paymentPendingList");
  if(!box) return;
  const { groups, bulkTotal, bulkCount } = getPaymentPendingData();

  if(!groups.length){ box.innerHTML = `<div class="empty">Koi Pending nahi mila — Credited entries ke Comment bhare hue hain. 🎉</div>`; return; }

  let html = groups.map(g => `
    <div class="pp-block">
      <div class="pp-head"><span>${escapeHtml(g.labour.name || "—")}</span><span>₹${g.total.toFixed(2)}</span></div>
      ${g.items.map(i => `
        <div class="pp-item">
          <span>${fmtDate(i.date)} · ${i.kulDin} Din · ₹${i.amt.toFixed(2)}</span>
          <div style="display:flex;gap:4px;align-items:center">
            <input type="text" id="ppNote-${i.demandId}" placeholder="jaise: de diya" style="width:100px;padding:4px 6px;font-size:11px">
            <button class="btn btn-blue btn-sm" style="padding:4px 8px" onclick="savePendingNote('${i.demandId}')">💾</button>
          </div>
        </div>
      `).join("")}
    </div>
  `).join("");

  html += `<div class="pp-bulk"><div class="v">₹${bulkTotal.toFixed(2)}</div><div style="font-size:11px">Bulk Pending Total — ${bulkCount} Entries</div></div>`;
  box.innerHTML = html;
}

// Payment Pending list se seedha comment likh kar Save karne ke liye
function savePendingNote(demandId){
  const input = $("ppNote-" + demandId);
  if(!input) return;
  const val = input.value.trim();
  if(!val){ toast("Kuch likhein pehle", "error"); return; }
  const d = DATA.demands.find(x => x.id === demandId);
  if(!d) return;
  d.comment = val;
  persist();
  toast("Save ho gaya");
  renderPaymentPending();
  renderDemandDates();
  renderDemands();
}

// Payment Pending list ka Print-friendly HTML (PDF ke liye)
function paymentPendingPdfHtml(groups, bulkTotal, bulkCount){
  return `
    <div style="font-family:'Hind',Arial,sans-serif;color:#000;background:#fff;padding:8px;border:1px solid #000">
      <h2 style="text-align:center;font-size:15px;margin:0 0 4px">⏳ Payment Pending — Khaali Comment (Credited)</h2>
      <p style="text-align:center;font-size:10px;margin:0 0 8px">Labour Job Card System — ${fmtDate(todayISO())}</p>
      ${groups.map(g => `
        <div style="margin-bottom:8px;border:1px solid #000">
          <div style="background:#f0f0f0;padding:5px 8px;font-size:11.5px;font-weight:700;display:flex;justify-content:space-between">
            <span>${escapeHtml(g.labour.name || "—")}</span><span>₹${g.total.toFixed(2)}</span>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:10.5px">
            <thead><tr><th style="border:1px solid #000;padding:3px">Date</th><th style="border:1px solid #000;padding:3px">Din</th><th style="border:1px solid #000;padding:3px">Amount ₹</th></tr></thead>
            <tbody>${g.items.map(i => `<tr><td style="border:1px solid #000;padding:3px;text-align:center">${fmtDate(i.date)}</td><td style="border:1px solid #000;padding:3px;text-align:center">${i.kulDin}</td><td style="border:1px solid #000;padding:3px;text-align:center">${i.amt.toFixed(2)}</td></tr>`).join("")}</tbody>
          </table>
        </div>
      `).join("")}
      <div style="background:#9c3b2e;color:#fff;text-align:center;padding:8px;border-radius:6px;margin-top:6px">
        <div style="font-size:15px;font-weight:700">₹${bulkTotal.toFixed(2)}</div>
        <div style="font-size:10.5px">Bulk Pending Total — ${bulkCount} Entries</div>
      </div>
      <p style="text-align:right;font-size:9.5px;color:#444;margin-top:8px;border-top:1px solid #999;padding-top:4px">Developed by Kurban Ali</p>
    </div>`;
}

async function downloadPaymentPendingPDF(mode){
  mode = mode || "download";
  const { groups, bulkTotal, bulkCount } = getPaymentPendingData();
  if(!groups.length){ toast("Abhi koi Payment Pending nahi hai", "error"); return; }
  if(typeof window.jspdf === "undefined" || typeof html2canvas === "undefined"){
    toast("PDF library load nahi hui — Internet check karke dobara try karein", "error"); return;
  }
  toast("PDF taiyar ho raha hai...", "info");
  try{
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 4;
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:700px;background:#fff";
    document.body.appendChild(container);
    try{
      container.innerHTML = paymentPendingPdfHtml(groups, bulkTotal, bulkCount);
      await new Promise(r => setTimeout(r, 60));
      const canvas = await html2canvas(container.firstElementChild, { scale: 2, backgroundColor: "#ffffff", logging: false });
      if(!canvas || !canvas.width) throw new Error("blank canvas");
      const imgWidth = pageWidth - margin * 2;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      pdf.addImage(canvas.toDataURL("image/png", 1.0), "PNG", margin, margin, imgWidth, imgHeight);
    } finally { document.body.removeChild(container); }
    await finalizePdf(pdf, `Payment_Pending_${todayISO()}.pdf`, mode);
    if(mode !== "share") toast("PDF Download ho gaya");
  }catch(err){
    console.error("Payment Pending PDF error:", err);
    toast("PDF banane me dikkat hui, dobara try karein", "error");
  }
}
function sharePaymentPendingPDF(){ downloadPaymentPendingPDF("share"); }

function renderDemands(){
  const filterDate = $("demandFilterDate").value;
  const term = ($("demandListSearch") && $("demandListSearch").value || "").trim().toLowerCase();

  let list = filterDate ? DATA.demands.filter(d => d.date === filterDate) : DATA.demands.slice();
  list = list.slice().sort((a, b) => b.date.localeCompare(a.date));

  if(term){
    list = list.filter(d => {
      const l = DATA.labours.find(x => x.id === d.labourId) || {};
      return (l.name || "").toLowerCase().includes(term) || String(l.jobcardNo || "").toLowerCase().includes(term);
    });
  }

  $("demandCount").textContent = "(" + list.length + " Demand)";

  $("demandTableBody").innerHTML = list.map((d, i) => {
    const l = DATA.labours.find(x => x.id === d.labourId) || {};
    const p = DATA.payments.find(x => x.date === d.date && x.labourId === d.labourId);
    const ac = DATA.acCredits.find(a => a.date === d.date && a.labourId === d.labourId);
    const creditStatus = ac ? ac.status : (p ? "Pending" : "—");
    const creditDate = ac ? fmtDate(ac.creditedDate || ac.date) : "";
    return `
      <tr>
        <td><input type="checkbox" class="demand-row-chk" value="${d.id}"></td>
        <td>${i + 1}</td>
        <td>${fmtDate(d.date)}</td>
        <td>${escapeHtml(l.jobcardNo || "—")}</td>
        <td>${escapeHtml(l.name || "—")}</td>
        <td><input type="number" class="att-in" min="0" value="${d.kulDin ?? ""}" onchange="updateDemandField('${d.id}','kulDin',this.value)"></td>
        <td><input type="number" class="att-in" min="0" value="${d.kulHajri ?? ""}" onchange="updateDemandField('${d.id}','kulHajri',this.value)"></td>
        <td><input type="number" class="att-in" min="0" value="${d.pratidin ?? ""}" onchange="updateDemandField('${d.id}','pratidin',this.value)"></td>
        <td><input type="number" class="att-in" style="width:84px" min="0" value="${p ? p.amount : ""}" ${p ? "" : "disabled"} onchange="updateDemandAmount('${d.id}',this.value)"></td>
        <td><span class="badge ${(l.status || "").toLowerCase()}">${l.status || "—"}</span></td>
        <td><span class="badge ${creditStatus === "Credited" ? "credited" : creditStatus === "Pending" ? "pending" : ""}">${creditStatus}</span></td>
        <td>${creditDate || "—"}</td>
        <td>
          <div style="display:flex;gap:4px;align-items:center">
            <input type="text" class="rep-comment" id="cmt-${d.id}" value="${escapeHtml(d.comment || "")}" placeholder="..." style="width:90px">
            <button class="btn btn-blue btn-sm" style="padding:5px 8px" onclick="saveComment('${d.id}')" title="Comment Save karein">💾</button>
          </div>
        </td>
        <td><button class="btn btn-red btn-sm" onclick="removeDemand('${d.id}')">Delete</button></td>
      </tr>
    `;
  }).join("");
  $("demandEmpty").classList.toggle("hidden", list.length > 0);
  $("demandListSelectAll").checked = false;
  renderDemandDates();
  renderPaymentPending();
}

// Demand List ke inline column (Kul Din / Kul Hajri / Pratidin / Comment) — turant save
function updateDemandField(demandId, field, value){
  const d = DATA.demands.find(x => x.id === demandId);
  if(!d) return;
  if(field === "comment") d[field] = String(value || "");
  else d[field] = (value === "" || isNaN(parseFloat(value))) ? "" : parseFloat(value);
  persist();
}

// Har row ke comment ke saamne wala 💾 Save button — Demand List (Past tab)
function saveComment(demandId){
  const input = $("cmt-" + demandId);
  if(!input) return;
  updateDemandField(demandId, "comment", input.value);
  toast("Comment save ho gaya", "success");
}

// Har row ke comment ke saamne wala 💾 Save button — Report tab
function saveReportComment(demandId){
  const input = $("rcmt-" + demandId);
  if(!input) return;
  updateDemandField(demandId, "comment", input.value);
  toast("Comment save ho gaya", "success");
}

// Kul Bhugtan (₹) — linked Payment ka amount update hota hai (Amount ka aadha Mate Share, aadha Labour Share)
function updateDemandAmount(demandId, value){
  const d = DATA.demands.find(x => x.id === demandId);
  if(!d) return;
  const p = DATA.payments.find(x => x.date === d.date && x.labourId === d.labourId);
  if(!p){ toast("Is Demand ki koi Payment nahi hai", "error"); renderDemands(); return; }
  const amt = parseFloat(value);
  if(!amt || amt <= 0){ toast("Sahi Amount daalein", "error"); renderDemands(); return; }
  p.amount = amt;
  p.mateShare = amt * 0.5;
  p.labourShare = amt * 0.5;
  persist();
  renderDashboard();
  toast("Kul Bhugtan update ho gaya");
}

function toggleDemandListSelectAll(){
  const checked = $("demandListSelectAll").checked;
  document.querySelectorAll(".demand-row-chk").forEach(c => c.checked = checked);
}

function clearDemandFilter(){
  $("demandFilterDate").value = "";
  renderDemands();
}

// Demand delete karte waqt cascade hoga: usi date+labour ki Payment aur AC Credit entry bhi
// delete hongi — lekin sab Recycle Bin me ek saath jayengi, taaki ek hi Restore se teeno wapas aa jayein
function cascadeDeleteForDemand(demand){
  if(!demand) return { payments: [], acCredits: [] };
  const payments = DATA.payments.filter(p => p.date === demand.date && p.labourId === demand.labourId);
  const acCredits = DATA.acCredits.filter(a => a.date === demand.date && a.labourId === demand.labourId);
  DATA.payments = DATA.payments.filter(p => !(p.date === demand.date && p.labourId === demand.labourId));
  DATA.acCredits = DATA.acCredits.filter(a => !(a.date === demand.date && a.labourId === demand.labourId));
  return { payments, acCredits };
}

function removeDemand(id){
  showConfirm("Is Demand ko delete karna hai? Ismein judi Payment aur AC Credit entry bhi delete ho jayegi. Recycle Bin se wapas la sakte hain.", () => {
    const demand = DATA.demands.find(x => x.id === id);
    const cascade = cascadeDeleteForDemand(demand);
    if(demand) moveToTrash("demand", [demand], [cascade]);
    DATA.demands = DATA.demands.filter(x => x.id !== id);
    persist();
    renderDemands();
    renderDemandLabourList();
    renderACList();
    renderTrash();
    toast("Demand, Payment aur AC Credit teeno Recycle Bin me chale gaye");
  });
}

function bulkDeleteDemands(){
  const checked = Array.from(document.querySelectorAll(".demand-row-chk:checked")).map(c => c.value);
  if(!checked.length){ toast("Pehle Demand select karein", "error"); return; }

  showConfirm(`${checked.length} Demand delete karni hai? Ismein judi Payment aur AC Credit entries bhi delete ho jayengi. Ek hi click se sab Recycle Bin se wapas la sakte hain.`, () => {
    const demandsToTrash = [];
    const cascadesToTrash = [];
    checked.forEach(id => {
      const demand = DATA.demands.find(x => x.id === id);
      const cascade = cascadeDeleteForDemand(demand);
      if(demand){ demandsToTrash.push(demand); cascadesToTrash.push(cascade); }
    });
    moveToTrash("demand", demandsToTrash, cascadesToTrash);
    DATA.demands = DATA.demands.filter(d => !checked.includes(d.id));
    persist();
    renderDemands();
    renderDemandLabourList();
    renderACList();
    renderTrash();
    toast(`${checked.length} Demand, Payment aur AC Credit ek batch me Recycle Bin gaye — ek hi click se sab wapas aa jayenge`);
  });
}

/* ================================================================
   PAYMENT TAB (UI hata di gayi) — Payment ab ⚡ Ek Paste se banti hai.
   DATA.payments AC Credit, Past List aur Report ke liye bana rehta hai.
================================================================ */

/* ================================================================
   TAB 4: AC CREDIT
================================================================ */
function renderACList(){
  const date = $("acDate").value;
  const term = ($("acSearch") && $("acSearch").value || "").trim().toLowerCase();
  let list = date ? DATA.payments.filter(p => p.date === date) : DATA.payments.slice();
  list = list.slice().sort((a, b) => b.date.localeCompare(a.date));

  if(term){
    list = list.filter(p => {
      const l = DATA.labours.find(x => x.id === p.labourId) || {};
      return (l.name || "").toLowerCase().includes(term) || String(l.jobcardNo || "").toLowerCase().includes(term);
    });
  }

  $("acCount").textContent = "(" + list.length + " Entries)";

  $("acTableBody").innerHTML = list.map((p, i) => {
    const l = DATA.labours.find(x => x.id === p.labourId) || {};
    const ac = DATA.acCredits.find(a => a.date === p.date && a.labourId === p.labourId);
    const status = ac ? ac.status : "Pending";
    const creditedDate = ac ? (ac.creditedDate || ac.date) : "";
    return `
      <tr>
        <td><input type="checkbox" class="ac-row-chk" value="${p.id}"></td>
        <td>${i + 1}</td>
        <td>${fmtDate(p.date)}</td>
        <td>${escapeHtml(l.jobcardNo || "—")}</td>
        <td>${escapeHtml(l.name || "—")}</td>
        <td>₹${p.amount}</td>
        <td>
          <span class="badge ${status.toLowerCase()}">${status}</span>
          ${status === "Credited" ? `<div class="mt" style="display:flex;align-items:center;gap:4px">
            <input type="date" class="ac-date-edit" value="${creditedDate}" style="width:132px;font-size:11.5px;padding:4px 5px" onchange="updateACCreditedDate('${p.id}', this.value)">
          </div>` : ""}
        </td>
        <td>
          ${status === "Credited"
            ? `<button class="btn btn-orange btn-sm" onclick="undoACCredit('${p.id}')">Undo</button>`
            : `<button class="btn btn-green btn-sm" onclick="creditAC('${p.id}')">Credit</button>`}
        </td>
      </tr>
    `;
  }).join("");
  $("acEmpty").classList.toggle("hidden", list.length > 0);
  $("acSelectAll").checked = false;
}

function clearACFilter(){
  $("acDate").value = "";
  renderACList();
}

function toggleACSelectAll(){
  const checked = $("acSelectAll").checked;
  document.querySelectorAll(".ac-row-chk").forEach(c => c.checked = checked);
}

// Credit karte waqt "Credited Date" field se date liya jata hai (agar khaali hai to aaj ki date) —
// yeh Demand Date se alag hoti hai, kyunki paisa aksar Demand ke kai din baad Account me credit hota hai
function creditACRecord(paymentId){
  const p = DATA.payments.find(x => x.id === paymentId);
  if(!p) return;
  const chosenDate = ($("acCreditDate") && $("acCreditDate").value) || todayISO();
  const idx = DATA.acCredits.findIndex(a => a.date === p.date && a.labourId === p.labourId);
  const record = { id: idx > -1 ? DATA.acCredits[idx].id : makeId(), date: p.date, labourId: p.labourId, status: "Credited", creditedDate: chosenDate };
  if(idx > -1) DATA.acCredits[idx] = record; else DATA.acCredits.push(record);
}

function creditAC(paymentId){
  creditACRecord(paymentId);
  persist();
  renderACList();
  renderDemands();
  toast("AC Credit ho gaya");
}

// Credited entry ki date baad me bhi badli/theek ki ja sakti hai, seedha table se
function updateACCreditedDate(paymentId, newDate){
  if(!newDate) return;
  const p = DATA.payments.find(x => x.id === paymentId);
  if(!p) return;
  const idx = DATA.acCredits.findIndex(a => a.date === p.date && a.labourId === p.labourId);
  if(idx === -1) return;
  DATA.acCredits[idx].creditedDate = newDate;
  persist();
  toast("Credited Date update ho gayi");
}

function undoACCredit(paymentId){
  const p = DATA.payments.find(x => x.id === paymentId);
  if(!p) return;
  DATA.acCredits = DATA.acCredits.filter(a => !(a.date === p.date && a.labourId === p.labourId));
  persist();
  renderACList();
  renderDemands();
  toast("AC Credit wapas Pending kar diya");
}

function bulkACCredit(){
  const checked = Array.from(document.querySelectorAll(".ac-row-chk:checked")).map(c => c.value);
  if(!checked.length){ toast("Pehle Payment select karein", "error"); return; }
  checked.forEach(pid => creditACRecord(pid));
  persist();
  renderACList();
  renderDemands();
  toast(`${checked.length} AC Credit ho gaya`);
}

function bulkUndoACCredit(){
  const checked = Array.from(document.querySelectorAll(".ac-row-chk:checked")).map(c => c.value);
  if(!checked.length){ toast("Pehle Payment select karein", "error"); return; }
  checked.forEach(pid => {
    const p = DATA.payments.find(x => x.id === pid);
    if(p) DATA.acCredits = DATA.acCredits.filter(a => !(a.date === p.date && a.labourId === p.labourId));
  });
  persist();
  renderACList();
  renderDemands();
  toast(`${checked.length} AC Credit wapas Pending kar diya`);
}

/* ================================================================
   TAB 5: REPORT
================================================================ */
function generateReport(){
  const date = $("reportDate") ? $("reportDate").value : "";
  const onlyCredited = $("reportOnlyCredited") ? $("reportOnlyCredited").checked : false;

  DATA.demands = toArray(DATA.demands);
  DATA.labours = toArray(DATA.labours);
  DATA.payments = toArray(DATA.payments);
  DATA.acCredits = toArray(DATA.acCredits);

  let demandList = date ? DATA.demands.filter(d => d.date === date) : DATA.demands.slice();
  demandList.sort((a, b) => b.date.localeCompare(a.date));

  if(onlyCredited){
    demandList = demandList.filter(d => {
      const ac = DATA.acCredits.find(x => x.date === d.date && x.labourId === d.labourId);
      return !!(ac && ac.status === "Credited");
    });
  }

  const emptyBox = $("reportEmpty");
  const titleBox = $("reportTitle");
  const summaryBox = $("reportSummary");
  const bodyBox = $("reportTableBody");

  if(!demandList.length){
    if(bodyBox) bodyBox.innerHTML = "";
    if(summaryBox) summaryBox.innerHTML = "";
    if(titleBox) titleBox.textContent = "📊 Report";
    if(emptyBox) emptyBox.classList.remove("hidden");
    return;
  }
  if(emptyBox) emptyBox.classList.add("hidden");
  if(titleBox) titleBox.textContent = date ? `📊 Report — ${fmtDate(date)}` : "📊 Report — Sabhi Dates";

  let totalPayment = 0, totalMate = 0, totalLabour = 0, creditedCount = 0;
  const rowsHtml = [];

  demandList.forEach((d, i) => {
    const l = DATA.labours.find(x => x.id === d.labourId) || {};
    const p = DATA.payments.find(x => x.date === d.date && x.labourId === d.labourId);
    const ac = DATA.acCredits.find(x => x.date === d.date && x.labourId === d.labourId);
    const acStatus = ac ? ac.status : (p ? "Pending" : "—");

    if(p){ totalPayment += Number(p.amount) || 0; totalMate += (Number(p.amount) || 0) * 0.5; totalLabour += (Number(p.amount) || 0) * 0.5; }
    if(acStatus === "Credited") creditedCount++;

    const creditDate = ac ? fmtDate(ac.creditedDate || ac.date) : "";
    rowsHtml.push(`
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(l.name || "—")}</td>
        <td>${escapeHtml(l.jobcardNo || "—")}</td>
        <td>${d.kulDin ?? ""}</td>
        <td>${d.pratidin ?? ""}</td>
        <td>${p ? "₹" + p.amount : "—"}</td>
        <td><span class="badge ${acStatus === "Credited" ? "credited" : acStatus === "Pending" ? "pending" : ""}">${acStatus}</span></td>
        <td>${creditDate || "—"}</td>
        <td>
          <div style="display:flex;gap:4px;align-items:center">
            <input type="text" class="rep-comment" id="rcmt-${d.id}" value="${escapeHtml(d.comment || "")}" placeholder="...">
            <button class="btn btn-blue btn-sm" style="padding:5px 8px" onclick="saveReportComment('${d.id}')" title="Comment Save karein">💾</button>
          </div>
        </td>
      </tr>
    `);
  });

  if(bodyBox) bodyBox.innerHTML = rowsHtml.join("");
  if(summaryBox){
    summaryBox.innerHTML = `
      <div class="sum-card"><div class="v">${demandList.length}</div><div class="l">Total Records</div></div>
      <div class="sum-card"><div class="v">₹${totalPayment.toFixed(2)}</div><div class="l">Total Payment</div></div>
      <div class="sum-card"><div class="v">₹${totalMate.toFixed(2)}</div><div class="l">Mate Share</div></div>
      <div class="sum-card"><div class="v">₹${totalLabour.toFixed(2)}</div><div class="l">Labour Share</div></div>
      <div class="sum-card"><div class="v">${creditedCount}/${demandList.length}</div><div class="l">AC Credited</div></div>
    `;
  }
}

function printReport(){
  const hasComments = DATA.demands.some(d => d.comment && String(d.comment).trim());
  const reportArea = $("reportPrintArea");
  if(!hasComments) reportArea.classList.add("no-comments");
  const st = document.createElement("style");
  st.textContent = "@page{size:A4 portrait;margin:8mm}";
  document.head.appendChild(st);
  document.body.classList.add("print-report");
  window.print();
  setTimeout(() => { document.body.classList.remove("print-report"); st.remove(); if(!hasComments) reportArea.classList.remove("no-comments"); }, 500);
}

/* ================================================================
   📊 REPORT PDF — Portrait mode, ek page me jitni entry fit ho jaayein
   (CSV ki jagah seedha PDF download hota hai)
================================================================ */
function getReportRowsData(){
  const date = $("reportDate") ? $("reportDate").value : "";
  const onlyCredited = $("reportOnlyCredited") ? $("reportOnlyCredited").checked : false;

  let demandList = date ? DATA.demands.filter(d => d.date === date) : DATA.demands.slice();
  if(onlyCredited){
    demandList = demandList.filter(d => {
      const ac = DATA.acCredits.find(x => x.date === d.date && x.labourId === d.labourId);
      return !!(ac && ac.status === "Credited");
    });
  }

  return demandList.map(d => {
    const l = DATA.labours.find(x => x.id === d.labourId) || {};
    const p = DATA.payments.find(x => x.date === d.date && x.labourId === d.labourId);
    const ac = DATA.acCredits.find(x => x.date === d.date && x.labourId === d.labourId);
    const acStatus = ac ? ac.status : (p ? "Pending" : "—");
    const creditDate = ac ? fmtDate(ac.creditedDate || ac.date) : "";
    return {
      name: l.name || "—",
      jobcardNo: l.jobcardNo || "—",
      kulDin: d.kulDin ?? "",
      pratidin: d.pratidin ?? "",
      amount: p ? "₹" + p.amount : "—",
      status: acStatus,
      credit: creditDate || "—",
      // Comment khaali hai to yahan bilkul khaali string hi jaayegi —
      // koi placeholder/"comment" word print nahi hoga
      comment: d.comment ? String(d.comment).trim() : ""
    };
  });
}

function reportPrintDocHtml(pageRows, dateLabel, pageNum, totalPages, startIndex){
  const nw = "white-space:nowrap;width:1%"; // content jitni hi chaudi, wrap nahi
  const rows = pageRows.map((r, i) => `
    <tr>
      <td style="border:1px solid #000;padding:5px;text-align:center;${nw}">${startIndex + i + 1}</td>
      <td style="border:1px solid #000;padding:5px">${escapeHtml(r.name)}</td>
      <td style="border:1px solid #000;padding:5px;${nw}">${escapeHtml(r.jobcardNo)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;${nw}">${escapeHtml(String(r.kulDin))}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;${nw}">${escapeHtml(String(r.pratidin))}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;${nw}">${escapeHtml(r.amount)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;${nw}">${escapeHtml(r.status)}</td>
      <td style="border:1px solid #000;padding:5px;text-align:center;${nw}">${escapeHtml(r.credit)}</td>
      <td style="border:1px solid #000;padding:5px">${escapeHtml(r.comment)}</td>
    </tr>`).join("");
  return `
    <div style="font-family:'Hind',Arial,sans-serif;color:#000;background:#fff;padding:6px;border:1px solid #000">
      <h2 style="text-align:center;font-size:16px;margin:0">📊 Report${dateLabel ? " — " + dateLabel : " — Sabhi Dates"}</h2>
      <p style="text-align:center;font-size:10.5px;margin:4px 0 10px">Labour Job Card System — ${fmtDate(todayISO())}${totalPages > 1 ? ` — Page ${pageNum}/${totalPages}` : ""}</p>
      <table style="width:100%;border-collapse:collapse;font-size:10.5px">
        <thead><tr>
          <th style="border:1px solid #000;padding:5px;background:#f0f0f0;${nw}">#</th>
          <th style="border:1px solid #000;padding:5px;background:#f0f0f0">Name</th>
          <th style="border:1px solid #000;padding:5px;background:#f0f0f0;${nw}">Jobcard No.</th>
          <th style="border:1px solid #000;padding:5px;background:#f0f0f0;${nw}">Kul Divas</th>
          <th style="border:1px solid #000;padding:5px;background:#f0f0f0;${nw}">Pratidin ₹</th>
          <th style="border:1px solid #000;padding:5px;background:#f0f0f0;${nw}">Kul Bhugtan ₹</th>
          <th style="border:1px solid #000;padding:5px;background:#f0f0f0;${nw}">Status</th>
          <th style="border:1px solid #000;padding:5px;background:#f0f0f0;${nw}">Credit</th>
          <th style="border:1px solid #000;padding:5px;background:#f0f0f0">Comment</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="text-align:right;font-size:10px;color:#444;margin-top:12px;border-top:1px solid #999;padding-top:5px">Developed by Kurban Ali</p>
    </div>`;
}

async function downloadReportPDF(mode){
  mode = mode || "download";
  const rows = getReportRowsData();
  if(!rows.length){ toast("Pehle Report Generate karein", "error"); return; }
  if(typeof window.jspdf === "undefined" || typeof html2canvas === "undefined"){
    toast("PDF library load nahi hui — Internet check karke dobara try karein", "error"); return;
  }
  toast("PDF taiyar ho raha hai...", "info");
  try{
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4"); // Portrait
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 4; // kam margin — poori page use ho
    const ROWS_PER_PAGE = 32; // ek portrait page me jitni entry fit ho jaayein
    const chunks = [];
    for(let i = 0; i < rows.length; i += ROWS_PER_PAGE) chunks.push(rows.slice(i, i + ROWS_PER_PAGE));

    const date = $("reportDate") ? $("reportDate").value : "";
    const dateLabel = date ? fmtDate(date) : "";

    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:700px;background:#fff";
    document.body.appendChild(container);
    try{
      for(let p = 0; p < chunks.length; p++){
        container.innerHTML = reportPrintDocHtml(chunks[p], dateLabel, p + 1, chunks.length, p * ROWS_PER_PAGE);
        await new Promise(r => setTimeout(r, 60));
        const canvas = await html2canvas(container.firstElementChild, { scale: 2, backgroundColor: "#ffffff", logging: false });
        if(!canvas || !canvas.width) throw new Error("blank canvas");
        const imgWidth = pageWidth - margin * 2;
        const imgHeight = Math.min((canvas.height * imgWidth) / canvas.width, pageHeight - margin * 2);
        if(p > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/png", 1.0), "PNG", margin, margin, imgWidth, imgHeight);
      }
    } finally { document.body.removeChild(container); }
    await finalizePdf(pdf, `Report_${date || "All"}_${todayISO()}.pdf`, mode);
    if(mode !== "share") toast("PDF Download ho gaya");
  }catch(err){
    console.error("Report PDF error:", err);
    toast("PDF banane me dikkat hui, dobara try karein", "error");
  }
}

function shareReportPDF(){ downloadReportPDF("share"); }

/* ================================================================
   TAB 6: NREGA FORM 10 — UPDATED: Show All + Select All + Hajri Filter
================================================================ */
let nregaSelected = new Set();
let nregaShowAll = false;  // Naya variable
let nregaFilterMode = null;  // "gt" (isse zyada) ya "lt" (isse kam)
let nregaFilterVal = null;

function renderNregaSearch(){
  const term = ($("nregaSearch").value || "").trim().toLowerCase();
  const box = $("nregaSearchList");

  // NREGA Form 10 ke liye sirf Active status wale Labour hi aayenge
  let results = DATA.labours.filter(l => l.status === "Active");
  if(!nregaShowAll && term){
    results = results.filter(l =>
      l.name.toLowerCase().includes(term) || String(l.jobcardNo).toLowerCase().includes(term)
    );
  }

  // Hajri (Din Hue) ke hisaab se "Isse Zyada"/"Isse Kam" filter
  if(nregaFilterMode && nregaFilterVal !== null && !isNaN(nregaFilterVal)){
    results = results.filter(l => {
      const hue = getLabourDinHue(l.id);
      return nregaFilterMode === "gt" ? hue > nregaFilterVal : hue < nregaFilterVal;
    });
  }

  if(!results.length){
    box.innerHTML = `<div class="empty">Is filter me koi Active Labour nahi mila.</div>`;
    $("nregaSelectAll").checked = false;
    updateNregaSelectedCount();
    return;
  }

  box.innerHTML = results.map(l => {
    const hue = getLabourDinHue(l.id);
    const baaki = getJobcardBaaki(l.jobcardNo);
    const low = baaki < JOBCARD_LOW_WARNING;
    const jcMembers = DATA.labours.filter(x => x.jobcardNo === l.jobcardNo && x.status === "Active");
    const isDual = jcMembers.length > 1;
    const isSel = nregaSelected.has(l.id);
    const partnerSelected = isDual && !isSel && jcMembers.some(m => m.id !== l.id && nregaSelected.has(m.id));
    return `
    <div class="chk-item">
      <input type="checkbox" class="nrega-chk" value="${l.id}" ${isSel ? "checked" : ""} onchange="toggleNregaSelect('${l.id}', this.checked)">
      <div style="flex:1">${escapeHtml(l.name)} <span style="font-size:12px;color:var(--muted)">(Jobcard: ${escapeHtml(l.jobcardNo)})</span>${low ? ' <span class="badge" style="background:#ffe4b3;color:#8a5300">⚠️ Kam Din</span>' : ""}${partnerSelected ? ' <span class="badge" style="background:#ffe4b3;color:#8a5300">Jodidaar select, ye baaki</span>' : ""}</div>
      <div style="font-size:11px;color:var(--muted);text-align:right;line-height:1.5">Hue: <b style="color:var(--green-dark)">${hue}</b><br>Baaki: <b style="color:${low ? "#c0392b" : "#b05e0d"}">${baaki}</b></div>
    </div>
  `;
  }).join("");

  $("nregaSelectAll").checked = results.every(l => nregaSelected.has(l.id));
  updateNregaSelectedCount();
  buildNregaFormTable(); // live preview — select karte hi Form 10 me naam aa jayenge
}

// "Isse Zyada"/"Isse Kam" + number laga kar list filter karta hai —
// Selection (nregaSelected) filter badalne se bilkul nahi hatta
function applyNregaFilter(){
  const mode = $("nregaFilterMode") ? $("nregaFilterMode").value : "gt";
  const val = $("nregaFilterVal") ? parseFloat($("nregaFilterVal").value) : NaN;
  if(isNaN(val)){ toast("Pehle koi number daalein", "error"); return; }
  nregaFilterMode = mode;
  nregaFilterVal = val;
  renderNregaSearch();
}

function clearNregaFilter(){
  nregaFilterMode = null;
  nregaFilterVal = null;
  if($("nregaFilterVal")) $("nregaFilterVal").value = "";
  renderNregaSearch();
}

function toggleNregaSelect(id, checked){
  if(checked) nregaSelected.add(id); else nregaSelected.delete(id);
  updateNregaSelectedCount();
  buildNregaFormTable(); // live preview
}

function toggleNregaSelectAll(){
  const checked = $("nregaSelectAll").checked;
  document.querySelectorAll(".nrega-chk").forEach(chk => {
    chk.checked = checked;
    if(checked) nregaSelected.add(chk.value); else nregaSelected.delete(chk.value);
  });
  updateNregaSelectedCount();
  buildNregaFormTable(); // live preview
}

function clearNregaSelection(){
  nregaSelected.clear();
  document.querySelectorAll(".nrega-chk").forEach(chk => chk.checked = false);
  $("nregaSelectAll").checked = false;
  updateNregaSelectedCount();
  buildNregaFormTable(); // live preview
  toast("Selection clear ho gayi", "info");
}

function updateNregaSelectedCount(){
  $("nregaSelectedCount").textContent = `${nregaSelected.size} selected`;
}

// Naya function — Show All toggle
function toggleNregaShowAll(){
  nregaShowAll = !nregaShowAll;
  $("nregaSearch").value = ""; // search clear karo
  renderNregaSearch();
}

function buildNregaFormTable(){
  // Form 10 me sirf ACTIVE Labour aayenge — Inactive/Completed kabhi nahi.
  const selectedActive = Array.from(nregaSelected)
    .map(id => DATA.labours.find(l => l.id === id))
    .filter(Boolean)
    .filter(l => l.status === "Active");

  // Har Jobcard ke Active members (Dual-naam Jobcard check karne ke liye)
  const jcActiveMembers = {};
  DATA.labours.filter(l => l.status === "Active").forEach(l => {
    if(!jcActiveMembers[l.jobcardNo]) jcActiveMembers[l.jobcardNo] = [];
    jcActiveMembers[l.jobcardNo].push(l.id);
  });

  // "Series" me sirf wahi jaate hain jinke Jobcard ke SAARE (Dual ho ya Single)
  // Active naam select ho chuke hain — baaki (adhoore-select Dual) sab
  // "Series se bahar" — sabse last me, inka koi fix order zaroori nahi
  const inSeries = [], outside = [];
  selectedActive.forEach(l => {
    const members = jcActiveMembers[l.jobcardNo] || [l.id];
    const allMembersSelected = members.every(id => nregaSelected.has(id));
    if(allMembersSelected) inSeries.push(l); else outside.push(l);
  });
  inSeries.sort((a, b) => String(a.jobcardNo).localeCompare(String(b.jobcardNo)));
  outside.sort((a, b) => String(a.jobcardNo).localeCompare(String(b.jobcardNo)));

  const rows = [...inSeries, ...outside];
  const skipped = Array.from(nregaSelected).length - rows.length;

  // Sirf जॉब कार्ड नंबर + श्रमिक का नाम bharte hain — baaki column khaali (hath se bharne ke liye)
  const box = $("nregaFormTableBody");
  if(box){
    box.innerHTML = rows.map((l, i) => `
      <tr><td>${i + 1}</td><td></td><td>${escapeHtml(l.jobcardNo)}</td><td>${escapeHtml(l.name)}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
    `).join("");
  }

  return { rows, skipped };
}

/* Sarkari Form 10 ka letterhead — screen preview aur PDF dono me yahi use hota hai */
function nregaLetterHtml(rowsHtml, showSign, pageNum, totalPages){
  return `
    <div class="nrega-doc" style="margin:0;max-width:none">
      <h2>कार्यालय कार्यक्रम अधिकारी महानरेगा पंचायत समिति जैसलमेर</h2>
      <h4>राष्ट्रीय ग्रामीण रोजगार गारंटी स्कीम राजस्थान</h4>
      <p style="margin:12px 0 2px">श्रीमान कार्यक्रम अधिकारी<br>पंचायत समिति जैसलमेर</p>
      <p style="margin-top:8px"><b>विषयः–</b> राष्ट्रीय ग्रामीण रोजगार गारंटी योजना के अन्तर्गत मस्टरोल दिलाने बाबत।</p>
      <p style="margin-top:8px">महोदय,<br>
        उपरोक्त विषयान्तर्गत निवेदन है कि ग्राम पंचायत/पंचायत समिति जैसलमेर क्षेत्र में चल रहे कार्य. का नाम: <span class="dots">...........................</span><br>
        कार्य कोड <span class="dots">..........</span> वित्तिय स्वीकृति <span class="dots">..........</span> पर ग्राम पंचायत/विभाग द्वारा कार्य करवाया गया हैं।
      </p>
      <table class="nf-table10">
        <thead><tr><th>क.स.</th><th>ग्राम</th><th>जॉब कार्ड नंबर</th><th>श्रमिक का नाम</th><th>खाता संख्या</th><th>बैंक का नाम/<br>IFC Code</th><th>भामाशाह नम्बर</th><th>आधार नम्बर</th><th>कार्य मांग दिवस</th><th>कुल दिवस</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      ${showSign ? `<div class="sign-row">
        <div>ग्राम सेवक एवं पदेन सचिव<br>ग्राम पंचायत ...............</div>
        <div>ग्राम रोजगार सहायक<br>ग्राम पंचायत</div>
      </div>` : ""}
      <div class="nf-credit">Developed by Kurban Ali${totalPages > 1 ? ` — Page ${pageNum}/${totalPages}` : ""}</div>
    </div>`;
}

/* Ek page pe 10 naam — HAR page pe POORA Form 10 format (letterhead + table) repeat hota hai.
   10 se zyada Labour ho to agle pages pe same format me naam aate jate hain. */
async function renderNregaPdfPages(pdf, rows, marginMM, pageWidthMM, pageHeightMM){
  const ROWS_PER_PAGE = 10;
  const chunks = [];
  for(let i = 0; i < rows.length; i += ROWS_PER_PAGE){
    chunks.push(rows.slice(i, i + ROWS_PER_PAGE));
  }

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0";
  container.style.width = "1080px";
  container.style.background = "#ffffff";
  document.body.appendChild(container);

  try{
    for(let p = 0; p < chunks.length; p++){
      const chunk = chunks[p];
      const startIndex = p * ROWS_PER_PAGE;
      const rowsHtml = chunk.map((l, i) => `
        <tr><td>${startIndex + i + 1}</td><td></td><td>${escapeHtml(l.jobcardNo)}</td><td>${escapeHtml(l.name)}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
      `).join("");

      container.innerHTML = nregaLetterHtml(rowsHtml, p === chunks.length - 1, p + 1, chunks.length);

      // Layout ko settle hone ka time do, warna html2canvas blank capture kar sakta hai
      await new Promise(r => setTimeout(r, 60));

      const canvas = await html2canvas(container.firstElementChild, {
        scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false
      });

      if(!canvas || !canvas.width || !canvas.height){
        throw new Error("Page " + (p + 1) + " ka canvas blank aaya");
      }

      const usableWidth = pageWidthMM - marginMM * 2;
      const usableHeight = pageHeightMM - marginMM * 2;
      let imgWidth = usableWidth;
      let imgHeight = (canvas.height * imgWidth) / canvas.width;
      if(imgHeight > usableHeight){ imgHeight = usableHeight; imgWidth = (canvas.width * imgHeight) / canvas.height; }
      const xOffset = marginMM + (usableWidth - imgWidth) / 2; // center karo

      if(p > 0) pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/png", 1.0), "PNG", xOffset, marginMM, imgWidth, imgHeight);
    }
  } finally {
    document.body.removeChild(container);
  }
}

async function downloadNregaPDF(mode){
  mode = mode || "download";
  if(!nregaSelected.size){ toast("Pehle kam se kam ek Labour select karein", "error"); return; }
  const { rows, skipped } = buildNregaFormTable();
  if(!rows.length){
    toast("Selected me se koi bhi Labour Active status me nahi hai. Pehle Labour tab me Status check karein.", "error");
    return;
  }

  if(typeof window.jspdf === "undefined" || typeof html2canvas === "undefined"){
    toast("PDF library load nahi hui — Internet check karke dobara try karein", "error"); return;
  }
  toast("PDF taiyar ho raha hai...", "info");

  try{
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("l", "mm", "a4"); // Landscape — wide sarkari table ke liye
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    await renderNregaPdfPages(pdf, rows, 10, pageWidth, pageHeight);

    await finalizePdf(pdf, `NREGA_Form10_${todayISO()}.pdf`, mode);
    if(mode !== "share") toast(skipped > 0 ? `PDF Download ho gaya (${skipped} non-Active Labour skip kiye gaye)` : "PDF Download ho gaya");
  } catch(err){
    console.error("PDF banane me error:", err);
    toast("PDF banane me dikkat hui, dobara try karein", "error");
  }
}

function shareNregaPDF(){ downloadNregaPDF("share"); }

/* ================================================================
   BOOT
================================================================ */
window.addEventListener("DOMContentLoaded", () => {
  const today = todayISO();
  ["demandDate", "onePasteDate", "acDate", "acCreditDate"].forEach(id => {
    const el = $(id);
    if(el) el.value = today;
  });

  if("serviceWorker" in navigator){
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });

    // Naya service worker control lete hi page ko ek baar reload karo,
    // taaki update turant lag jaye aur purana cached app.js kabhi na dikhe
    let swRefreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if(swRefreshed) return;
      swRefreshed = true;
      window.location.reload();
    });
  }
});