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
  acCredits: [], // {id, date, labourId, status, diya}
  trash: [],     // {id, type: 'labour'|'demand'|'payment', data, cascade, deletedAt}
  ledger: []     // {id, labourId, date, type:'mile'|'diye', amount, comment, balanceAfter} — Labour Khata
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
    DATA = { labours: [], demands: [], payments: [], acCredits: [], trash: [], ledger: [] };
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
        trash: toArray(val && val.trash),
        ledger: toArray(val && val.ledger)
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
        trash: toArray(parsed.trash),
        ledger: toArray(parsed.ledger)
      };
    } catch(e){ console.warn("LocalStorage parse error", e); }
  } else {
    DATA = { labours: [], demands: [], payments: [], acCredits: [], trash: [], ledger: [] };
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
  DATA.ledger = toArray(DATA.ledger);

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
  migrateV45();
  renderDashboard();
  renderDashboardKhata();
  renderLabourProfileList();
  renderLabours();
  renderDemandLabourList();
  renderDemands();
  renderACList();
  renderTrash();
  renderNregaSearch();
  buildNregaFormTable();
}

/* ================================================================
   📒 LABOUR KHATA / LEDGER (Khatabook jaisa)
   Har Labour ka apna khata. Rows teen jagah se apne-aap bante hain
   (kuch alag se store nahi hota, isliye khata hamesha sahi rehta hai):
     1) "due"  — AC Credited Payment ka Mate Share (50%) = Labour se lena baaki
     2) "mile" — AC Credit / Report tab ke "Diya" column me bhari rakam (Labour ne aapko di)
     3) manual — DATA.ledger me 🟢 Aapko Mile / 🔴 Aapne Diye (khata screen se)
   Balance = due + Aapne Diye − Aapko Mile.   Plus = Aapko Milenge, Minus = Aap Denge.
   Mate Share "Mila / Pending" ka nishan Demand ke COMMENT se aata hai:
   Comment khaali = ⏳ Pending, kuch likha ho = ✅ Mila. Comment sirf 📊 Report tab me edit hota hai.
================================================================ */
const EMPTY_LEDGER = { rows: [], balance: 0, kulAaya: 0, kulMila: 0, kulDiye: 0 };

function round2(n){ return Math.round((Number(n) || 0) * 100) / 100; }

// Har Payment par kitna "Mila" (Labour ne diya): purana AC "Diya" + Khata ki payment-wise 🟢 MILA entries
function getPaidMap(){
  const m = {};
  toArray(DATA.ledger).forEach(e => {
    if(e.type === "mile" && e.paymentId) m[e.paymentId] = (m[e.paymentId] || 0) + (Number(e.amount) || 0);
  });
  return m;
}
function getPaymentPaid(p, paidMap){
  return round2(getPaymentOtherPaid(p, paidMap) + getPaymentMila(p));
}
// v45: "Kitna Mila" — Demand par saved amount (Report / AC popup / Bulk se)
function getPaymentMila(p){
  const d = DATA.demands.find(x => x.date === p.date && x.labourId === p.labourId);
  return d ? (Number(d.mila) || 0) : 0;
}
// Mila ke alawa jo mila (purana Diya + Khata ki payment-wise entries)
function getPaymentOtherPaid(p, paidMap){
  const ac = DATA.acCredits.find(a => a.date === p.date && a.labourId === p.labourId);
  return round2((ac ? (Number(ac.diya) || 0) : 0) + ((paidMap || getPaidMap())[p.id] || 0));
}
function getPaymentLeft(p, paidMap){
  return Math.max(0, round2((Number(p.amount) || 0) * 0.5 - getPaymentPaid(p, paidMap)));
}
// Mate Status: poora mil gaya ya Comment likha = ✅ Mila, baaki sab ⏳ Pending
function paymentMateStatus(p, paidMap){
  return getPaymentLeft(p, paidMap) <= 0 ? "mila" : "pending";
}

function demandCommentStatus(d){ return "pending"; } // v45: comment ab sirf note hai

// Saare Labour ka khata ek hi baar me (onlyLabourId do to sirf us Labour ka)
function computeLedgers(onlyLabourId){
  const acMap = {}, demMap = {};
  DATA.acCredits.forEach(a => { acMap[a.date + "|" + a.labourId] = a; });
  DATA.demands.forEach(d => { demMap[d.date + "|" + d.labourId] = d; });
  const paidMap = getPaidMap();
  const by = {}, wait = {};
  const add = (lid, r) => { (by[lid] = by[lid] || []).push(r); };

  DATA.payments.forEach(p => {
    if(onlyLabourId && p.labourId !== onlyLabourId) return;
    const ac = acMap[p.date + "|" + p.labourId];
    const mate = (Number(p.amount) || 0) * 0.5;
    if(mate <= 0) return;
    if(!ac || ac.status !== "Credited"){
      // Sarkar ne abhi Credit nahi kiya — balance me nahi judta, sirf "Credit baaki" popup me dikhta hai
      (wait[p.labourId] = wait[p.labourId] || []).push({ date: p.date, amount: mate, payment: Number(p.amount) || 0, paymentId: p.id, labourId: p.labourId });
      return;
    }
    const dueDate = ac.creditedDate || ac.date || p.date;
    const dem = demMap[p.date + "|" + p.labourId];
    const paid = getPaymentPaid(p, paidMap);
    const left = Math.max(0, round2(mate - paid));
    add(p.labourId, { kind: "due", date: dueDate, amount: mate, order: 0, paymentId: p.id, paid, left,
      comment: "Payment ₹" + (Number(p.amount) || 0) + " (" + fmtDate(p.date) + ")",
      status: left <= 0 ? "mila" : "pending" });
    // v45: "Kitna Mila" (Demand par saved) -> Khata me Mila (credit) entry. Comment sirf note hai.
    const milaAmt = dem ? Math.min(Number(dem.mila) || 0, mate) : 0;
    if(milaAmt > 0){
      add(p.labourId, { kind: "mile", auto: true, paymentId: p.id, date: dem.milaDate || dueDate, amount: round2(milaAmt), order: 1,
        comment: dem.comment && String(dem.comment).trim() ? String(dem.comment).trim() : "" });
    }
    const diya = Number(ac.diya) || 0;
    if(diya > 0){
      add(p.labourId, { kind: "mile", legacy: true, paymentId: p.id, date: ac.diyaDate || dueDate, amount: diya, order: 1,
        comment: "Diya — Demand " + fmtDate(p.date) });
    }
  });
  // Payment-wise Mila tabhi dikhta hai jab wo payment maujood aur Credited ho (Undo / delete par chhup jata hai, wapas aane par laut aata hai)
  const liveCredited = new Set();
  DATA.payments.forEach(p => { const ac = acMap[p.date + "|" + p.labourId]; if(ac && ac.status === "Credited") liveCredited.add(p.id); });
  toArray(DATA.ledger).forEach(e => {
    if(onlyLabourId && e.labourId !== onlyLabourId) return;
    if(e.paymentId && !liveCredited.has(e.paymentId)) return;
    add(e.labourId, { kind: e.type === "mile" ? "mile" : "adv", id: e.id, manual: true, paymentId: e.paymentId || "",
      date: e.date || "", amount: Number(e.amount) || 0, comment: e.comment || "", order: 2 });
  });

  const out = {};
  Object.keys(by).forEach(lid => {
    const rows = by[lid].slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.order - b.order);
    let bal = 0, kulAaya = 0, kulMila = 0, kulDiye = 0;
    rows.forEach(r => {
      if(r.kind === "due"){ bal += r.amount; kulAaya += r.amount; }
      else if(r.kind === "mile"){ bal -= r.amount; kulMila += r.amount; }
      else { bal -= r.amount; kulDiye += r.amount; } // advance: pehle diya hua, baaki se kat'ta hai
      bal = round2(bal);
      r.balanceAfter = bal;
    });
    out[lid] = { rows, balance: bal, kulAaya, kulMila, kulDiye, waiting: wait[lid] || [] };
  });
  Object.keys(wait).forEach(lid => {
    if(!out[lid]) out[lid] = { rows: [], balance: 0, kulAaya: 0, kulMila: 0, kulDiye: 0, waiting: wait[lid] };
  });
  return out;
}

function getLabourLedger(labourId){ return computeLedgers(labourId)[labourId] || EMPTY_LEDGER; }
function getLabourBalance(labourId){ return getLabourLedger(labourId).balance; }

// Har Labour ke Credited Demand: kitne ka Comment bhara (Mila) aur kitne ka khaali (Pending)
function computeMateStatusMap(){
  const acMap = {};
  DATA.acCredits.forEach(a => { acMap[a.date + "|" + a.labourId] = a; });
  const paidMap = getPaidMap();
  const out = {};
  DATA.payments.forEach(p => {
    const ac = acMap[p.date + "|" + p.labourId];
    if(!ac || ac.status !== "Credited") return;
    const o = out[p.labourId] = out[p.labourId] || { mila: 0, pending: 0 };
    if(paymentMateStatus(p, paidMap) === "mila") o.mila++; else o.pending++;
  });
  return out;
}

// Manual Khata entry (🟢 Aapko Mile / 🔴 Aapne Diye)
// Manual Khata entry: type "mile" (Labour ne diya, paymentId ke saath) | "adv" (aapne pehle diya)
function addManualLedgerEntry(labourId, type, amount, comment, date, paymentId){
  const amt = Number(amount) || 0;
  if(!labourId || amt <= 0){ toast("Sahi Amount daalein", "error"); return false; }
  DATA.ledger = toArray(DATA.ledger);
  const e = { id: makeId(), labourId, date: date || todayISO(), type: type === "mile" ? "mile" : "adv", amount: amt, comment: (comment || "").trim() };
  if(type === "mile" && paymentId) e.paymentId = paymentId;
  DATA.ledger.push(e);
  persist();
  return true;
}

// Labour ne jitna diya use pehle chune hue payment par lagao; zyada ho to agle baaki payments par (purane pehle)
function applyMileToPayments(labourId, paymentId, amount, comment, date){
  let rest = round2(amount);
  const order = DATA.payments.filter(p => p.labourId === labourId && getPaymentLeft(p) > 0 && isPaymentCredited(p))
    .sort((a, b) => (a.id === paymentId ? -1 : b.id === paymentId ? 1 : String(a.date).localeCompare(String(b.date))));
  const pm = getPaidMap();
  for(const p of order){
    if(rest <= 0) break;
    const use = Math.min(rest, getPaymentLeft(p, pm));
    if(use <= 0) continue;
    addManualLedgerEntry(labourId, "mile", use, p.id === paymentId ? comment : ((comment || "diya") + " (agla payment)"), date, p.id);
    pm[p.id] = (pm[p.id] || 0) + use;
    rest = round2(rest - use);
  }
  return round2(amount - rest); // kitna lag gaya
}
function isPaymentCredited(p){
  return DATA.acCredits.some(a => a.date === p.date && a.labourId === p.labourId && a.status === "Credited");
}

/* ---------------------------------------------------------------
   KHATA LIST + SUMMARY — Dashboard aur Past tab ka Payment Pending,
   dono isi shared function se draw hote hain
--------------------------------------------------------------- */
function renderKhataSummaryInto(elId){
  const box = $(elId);
  if(!box) return;
  box.innerHTML = ""; return; // upar ke Baaki cards ab nahi dikhte — sirf Labour ki list
  const all = computeLedgers();
  let milenge = 0, denge = 0, kulMila = 0, pendingLabour = 0;
  Object.keys(all).forEach(lid => {
    const b = all[lid].balance;
    if(b > 0){ milenge += b; pendingLabour++; } else if(b < 0) denge += -b;
    kulMila += all[lid].kulMila;
  });
  box.innerHTML = `
    <div class="sum-card"><div class="v" style="color:#146c33">₹${milenge.toFixed(2)}</div><div class="l">Kul Baaki (Mate Share)</div></div>
    <div class="sum-card"><div class="v" style="color:#b05e0d">${pendingLabour}</div><div class="l">Labour jinka baaki hai</div></div>
    <div class="sum-card"><div class="v">₹${kulMila.toFixed(2)}</div><div class="l">Ab tak Mila</div></div>
    ${denge > 0 ? `<div class="sum-card"><div class="v" style="color:#c0392b">₹${denge.toFixed(2)}</div><div class="l">Zyada Diya (−)</div></div>` : ""}
  `;
}

function renderKhataListInto(elId, term){
  const box = $(elId);
  if(!box) return;
  term = (term || "").trim().toLowerCase();
  const all = computeLedgers();
  const msMap = computeMateStatusMap();
  let list = DATA.labours.slice();
  if(term){
    list = list.filter(l => l.name.toLowerCase().includes(term) || String(l.jobcardNo || "").toLowerCase().includes(term));
  }
  const cb = $(elId.replace("List", "OnlyPending"));
  if(cb && cb.checked) list = list.filter(l => (msMap[l.id] || { pending: 0 }).pending > 0);
  list.sort((a, b) => ((all[b.id] || EMPTY_LEDGER).balance - (all[a.id] || EMPTY_LEDGER).balance) || a.name.localeCompare(b.name));
  if(!list.length){ box.innerHTML = `<div class="empty">Koi Labour nahi mila.</div>`; return; }

  box.innerHTML = list.map(l => {
    const lg = all[l.id] || EMPTY_LEDGER;
    const bal = lg.balance;
    const cls = bal > 0 ? "credited" : (bal < 0 ? "pending" : "inactive");
    const balTxt = "₹" + Math.abs(bal).toFixed(2);
    const sub = bal === 0 ? "Barabar" : (bal > 0 ? "Baaki" : "Zyada Diya");
    const ms = msMap[l.id] || { mila: 0, pending: 0 };
    const msBadge = ms.pending > 0
      ? `<span class="badge pending">⏳ ${ms.pending} Pending</span>`
      : (ms.mila > 0 ? `<span class="badge credited">✅ Mila</span>` : "");
    const last = (lg.rows.length ? fmtDate(lg.rows[lg.rows.length - 1].date) : "Koi entry nahi") + ((lg.waiting && lg.waiting.length) ? ` · <span style="color:#a8620a;font-weight:600">⏳ ${lg.waiting.length} credit baaki</span>` : "");
    return `
      <div class="chk-item" style="cursor:pointer" onclick="openLedgerModal('${l.id}')">
        <div class="lp-avatar">${escapeHtml((l.name || "?").trim().charAt(0).toUpperCase())}</div>
        <div style="flex:1;min-width:0">
          <div><b>${escapeHtml(l.name)}</b></div>
          <div style="font-size:11.5px;color:var(--muted)">${escapeHtml(l.jobcardNo || "")}${l.aadhar ? " · 🆔 " + escapeHtml(l.aadhar) : ""} · ${last}</div>
        </div>
        <div style="text-align:right">
          <div class="badge ${cls}" style="font-size:13px">${balTxt}</div>
          <div style="font-size:10.5px;color:var(--muted);margin-top:2px">${sub}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px;margin-left:6px" onclick="event.stopPropagation()">
          <button class="btn btn-gray btn-sm" style="padding:2px 7px" title="Edit Labour" onclick="editLabourFromKhata('${l.id}')">✏️</button>
          <button class="btn btn-red btn-sm" style="padding:2px 7px" title="Delete Labour" onclick="deleteLabour('${l.id}')">🗑️</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderDashboardKhata(){
  const pb = $("dashPendBtn");
  if(pb){ const n = getWaitingPayments(null).length; pb.innerHTML = "⏳ Credit baaki" + (n ? " (<b>" + n + "</b>)" : ""); }
  renderKhataSummaryInto("dashKhataSummary");
  renderKhataListInto("dashKhataList", $("dashKhataSearch") ? $("dashKhataSearch").value : "");
}

/* ---------------------------------------------------------------
   LEDGER MODAL (Khatabook jaisa full screen khata) — Dashboard aur
   Payment Pending, dono se yahi ek modal khulta hai
--------------------------------------------------------------- */
let currentLedgerLabourId = null;
let ledgerProfileOpen = false;
function toggleLedgerProfile(){ ledgerProfileOpen = !ledgerProfileOpen; renderLedgerModal(); }
function ledgerProfileHtml(labourId){
  const l = DATA.labours.find(x => x.id === labourId);
  const b = { labour: l, ...getLabourProfileRows(labourId, "", "", "All") };
  if(!b.rows.length) return `<div class="empty">Is Labour ki koi Demand history nahi.</div>`;
  return `<div style="max-height:260px;overflow:auto;margin-bottom:8px">${labourProfileBlockHtml(b)}</div>`;
}
// Ek Labour ki poori PDF (Profile history + Khata len-den)
function downloadLabourKhataPDF(labourId, mode){
  const l = DATA.labours.find(x => x.id === labourId);
  if(!l) return;
  const b = { labour: l, ...getLabourProfileRows(labourId, "", "", "All") };
  b.ledgerRows = getLabourLedger(labourId).rows;
  if(!b.rows.length && !b.ledgerRows.length){ toast("Is Labour ka abhi koi data nahi hai", "error"); return; }
  lpLastReport = { blocks: [b], fromDate: "", toDate: "", statusFilter: "All" };
  downloadLabourProfileReportPDF(mode || "download");
}
let ledgerEntryMode = null; // "mile" | "adv" | null (form band)
let ledgerEditKey = null;   // "L:<id>" (Khata entry) | "A:<paymentId>" (purana AC Diya)

function openLedgerModal(labourId){
  currentLedgerLabourId = labourId;
  ledgerEntryMode = null;
  renderLedgerModal();
  $("ledgerModalOverlay").classList.remove("hidden");
}
function closeLedgerModal(){
  ledgerProfileOpen = false;
  ledgerEditKey = null;
  $("ledgerModalOverlay").classList.add("hidden");
  currentLedgerLabourId = null;
  ledgerEntryMode = null;
  renderDashboardKhata();
  renderPaymentPending();
}
function openLedgerEntryForm(type){
  ledgerEntryMode = type;
  ledgerEditKey = null;
  renderLedgerModal();
  setTimeout(() => { const el = $("ledgerEntryAmount"); if(el) el.focus(); }, 60);
}
function cancelLedgerEntryForm(){
  ledgerEntryMode = null;
  renderLedgerModal();
}
function saveLedgerEntry(){
  if(!currentLedgerLabourId || !ledgerEntryMode) return;
  const amt = Number($("ledgerEntryAmount").value) || 0;
  const date = $("ledgerEntryDate").value || todayISO();
  const note = $("ledgerEntryNote").value;
  if(amt <= 0){ toast("Sahi Amount daalein", "error"); return; }
  if(!addManualLedgerEntry(currentLedgerLabourId, ledgerEntryMode === "mile" ? "mile" : "adv", amt, note, date)) return;
  ledgerEntryMode = null;
  renderLedgerModal();
  renderDashboardKhata();
  toast("Entry save ho gayi ✅");
}

function openLedgerEdit(key){
  ledgerEditKey = key;
  ledgerEntryMode = null;
  renderLedgerModal();
}
function cancelLedgerEdit(){ ledgerEditKey = null; renderLedgerModal(); }

function findLedgerEditTarget(){
  if(!ledgerEditKey) return null;
  if(ledgerEditKey.startsWith("L:")){
    const e = toArray(DATA.ledger).find(x => x.id === ledgerEditKey.slice(2));
    return e ? { kind: "ledger", e } : null;
  }
  if(ledgerEditKey.startsWith("M:")){
    const pm = DATA.payments.find(x => x.id === ledgerEditKey.slice(2));
    const dm = pm ? DATA.demands.find(x => x.date === pm.date && x.labourId === pm.labourId) : null;
    return dm ? { kind: "mila", p: pm, d: dm } : null;
  }
  const p = DATA.payments.find(x => x.id === ledgerEditKey.slice(2));
  const ac = p ? DATA.acCredits.find(a => a.date === p.date && a.labourId === p.labourId) : null;
  return ac ? { kind: "legacy", p, ac } : null;
}

function saveLedgerEdit(){
  const t = findLedgerEditTarget();
  if(!t) return;
  const amt = Number($("ledgerEditAmount").value) || 0;
  const date = $("ledgerEditDate").value || todayISO();
  if(amt <= 0){ toast("Sahi Amount daalein", "error"); return; }
  if(t.kind === "ledger"){
    const e = t.e;
    if(e.type === "mile" && e.paymentId){
      const p = DATA.payments.find(x => x.id === e.paymentId);
      if(p){
        const others = getPaymentPaid(p) - (Number(e.amount) || 0);
        const mate = (Number(p.amount) || 0) * 0.5;
        if(others + amt > mate + 0.001){ toast("Itna nahi — is payment ka hissa sirf ₹" + mate + " hai", "error"); return; }
      }
    }
    e.amount = amt; e.date = date; e.comment = ($("ledgerEditNote").value || "").trim();
  } else if(t.kind === "mila"){
    const mate = (Number(t.p.amount) || 0) * 0.5;
    if(amt + getPaymentOtherPaid(t.p) > mate + 0.001){ toast("Itna nahi — is payment ka hissa sirf ₹" + mate + " hai", "error"); return; }
    t.d.mila = amt; t.d.milaDate = date;
  } else {
    const mate = (Number(t.p.amount) || 0) * 0.5;
    const pm = getPaidMap();
    if(amt + (pm[t.p.id] || 0) > mate + 0.001){ toast("Itna nahi — is payment ka hissa sirf ₹" + mate + " hai", "error"); return; }
    t.ac.diya = amt; t.ac.diyaDate = date;
  }
  persist();
  ledgerEditKey = null;
  renderLedgerModal();
  renderDashboardKhata();
  toast("Entry badal gayi ✅");
}

function deleteLedgerEdit(){
  const t = findLedgerEditTarget();
  if(!t) return;
  showConfirm("Ye Khata entry delete karni hai?", () => {
    if(t.kind === "ledger") DATA.ledger = toArray(DATA.ledger).filter(e => e.id !== t.e.id);
    else if(t.kind === "mila"){ t.d.mila = 0; t.d.milaDate = ""; }
    else { t.ac.diya = 0; t.ac.diyaDate = ""; }
    persist();
    ledgerEditKey = null;
    renderLedgerModal();
    renderDashboardKhata();
    toast("Entry delete ho gayi");
  });
}
function deleteLedgerEntry(id){ ledgerEditKey = "L:" + id; deleteLedgerEdit(); }

function renderLedgerModal(){
  const l = DATA.labours.find(x => x.id === currentLedgerLabourId);
  const body = $("ledgerModalBody");
  if(!l || !body) return;
  const lg = getLabourLedger(currentLedgerLabourId);
  const bal = lg.balance;
  const rows = lg.rows.slice().reverse(); // naya upar
  const waitN = lg.waiting.length;
  const balColor = bal > 0 ? "#c0392b" : (bal < 0 ? "#146c33" : "#555");
  const money = n => "₹" + Math.abs(n).toFixed(2);

  let formHtml = "";
  if(ledgerEntryMode){
    formHtml = `
    <div class="lg-form ${ledgerEntryMode === "mile" ? "mile" : "diye"}">
      <div class="lg-form-title">${ledgerEntryMode === "mile" ? escapeHtml(l.name) + " se mila" : escapeHtml(l.name) + " ko advance diya"}</div>
      <div class="row">
        <div class="field grow"><label>Amount ₹</label><input type="number" id="ledgerEntryAmount" min="0" step="any" placeholder="0"></div>
        <div class="field grow"><label>Date</label><input type="date" id="ledgerEntryDate" value="${todayISO()}"></div>
      </div>
      <div class="field"><label>Details (jaise: aadha diya)</label><input type="text" id="ledgerEntryNote" placeholder="Details likhein..."></div>
      <div class="row">
        <button class="btn btn-sm ${ledgerEntryMode === "mile" ? "btn-green" : "btn-red"}" style="flex:1" onclick="saveLedgerEntry()">Save Karein</button>
        <button class="btn btn-gray btn-sm" onclick="cancelLedgerEntryForm()">Cancel</button>
      </div>
    </div>`;
  }

  let editHtml = "";
  const et = ledgerEditKey ? findLedgerEditTarget() : null;
  if(et){
    const amt = et.kind === "ledger" ? et.e.amount : (et.kind === "mila" ? et.d.mila : et.ac.diya);
    const dt = et.kind === "ledger" ? et.e.date : (et.kind === "mila" ? (et.d.milaDate || todayISO()) : (et.ac.diyaDate || todayISO()));
    const nt = et.kind === "ledger" ? (et.e.comment || "") : "";
    editHtml = `
    <div class="lg-form mile">
      <div class="lg-form-title">✏️ Entry badlein</div>
      <div class="row">
        <div class="field grow"><label>Amount ₹</label><input type="number" id="ledgerEditAmount" min="0" step="any" value="${amt}"></div>
        <div class="field grow"><label>Date</label><input type="date" id="ledgerEditDate" value="${dt}"></div>
      </div>
      ${et.kind === "ledger" ? `<div class="field"><label>Details</label><input type="text" id="ledgerEditNote" value="${escapeHtml(nt)}"></div>` : `<input type="hidden" id="ledgerEditNote" value="">`}
      <div class="row">
        <button class="btn btn-red btn-sm" onclick="deleteLedgerEdit()">🗑️ Delete</button>
        <button class="btn btn-green btn-sm" style="flex:1" onclick="saveLedgerEdit()">Save Karein</button>
        <button class="btn btn-gray btn-sm" onclick="cancelLedgerEdit()">Cancel</button>
      </div>
    </div>`;
  }

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding-right:38px">
      <div><h3 style="margin:0 0 2px">📒 ${escapeHtml(l.name)}</h3>
        <div style="font-size:12px;color:var(--muted)">${escapeHtml(l.jobcardNo || "")}</div></div>
      <button class="btn btn-outline btn-sm" onclick="openACPending('${l.id}')" title="Sarkar ne abhi Credit nahi kiye">⏳${waitN ? ` <b>${waitN}</b>` : ""}</button>
    </div>
    <div class="lg-balcard" style="margin-top:8px">
      <div><div style="font-size:12px;color:var(--muted)">${bal < 0 ? "Zyada Diya (−)" : "Baaki"}</div><div class="lg-bal" style="color:${balColor}">${money(bal)}</div></div>
    </div>
    <div class="row" style="margin:8px 0">
      <button class="btn btn-orange btn-sm" onclick="downloadLabourKhataPDF('${l.id}')">📄 PDF</button>
      <button class="btn btn-sm" style="background:#25D366;color:#fff" onclick="downloadLabourKhataPDF('${l.id}','share')">📲 WhatsApp</button>
      <button class="btn btn-gray btn-sm" onclick="toggleLedgerProfile()">${ledgerProfileOpen ? "🙈 Profile Chhupayein" : "👷 Profile History"}</button>
    </div>
    ${ledgerProfileOpen ? ledgerProfileHtml(l.id) : ""}
    ${formHtml}${editHtml}
    <div class="lg-cols"><span>ENTRIES</span><span>BAAKI JUDA</span><span>MILA</span></div>
    <div id="ledgerRows">
      ${rows.length ? rows.map(r => {
        const editKey = r.manual ? "L:" + r.id : (r.legacy ? "A:" + r.paymentId : (r.auto ? "M:" + r.paymentId : ""));
        const tag = "";
        const clickAttr = editKey ? `onclick="openLedgerEdit('${editKey}')" style="cursor:pointer" title="Badalne ke liye tap karein"` : "";
        const label = r.kind === "adv" ? "Advance" : (r.kind === "mile" ? "Mila" : "");
        return `
        <div class="lg-row" ${clickAttr}>
          <div class="lg-main">
            <div class="lg-date">${fmtDate(r.date)} ${tag}</div>
            <span class="lg-chip">Bal. ${r.balanceAfter < 0 ? "−" : ""}₹${Math.abs(r.balanceAfter).toFixed(2)}</span>
            <div class="lg-note">${label ? escapeHtml(label) + (r.comment ? " — " : "") : ""}${r.comment ? escapeHtml(r.comment) : ""}${editKey ? ' <span style="font-size:11px;color:var(--muted)">✏️</span>' : ""}</div>
          </div>
          <div class="lg-amt diye">${r.kind === "due" ? "₹" + r.amount.toFixed(2) : ""}</div>
          <div class="lg-amt mile">${r.kind !== "due" ? "₹" + r.amount.toFixed(2) : ""}</div>
        </div>`;
      }).join("") : `<div class="empty">Abhi koi entry nahi — Payment Credit hote hi uska hissa yahan chadh jayega.</div>`}
    </div>
    ${(ledgerEntryMode || et) ? "" : `
    <div class="lg-footer">
      <button class="lg-btn diye" onclick="openLedgerEntryForm('adv')">ADVANCE DIYA ₹</button>
      <button class="lg-btn mile" onclick="openLedgerEntryForm('mile')">MILA ₹</button>
    </div>`}
  `;
}
/* ---------------------------------------------------------------
   ⏳ SARKAR CREDIT BAAKI — popup (labourId do to sirf us Labour ke, null = sab Labour)
--------------------------------------------------------------- */
let pendingPopupLabourId = null;
function openPendingPopup(labourId){
  pendingPopupLabourId = labourId || null;
  renderPendingPopup();
  $("pendingModalOverlay").classList.remove("hidden");
}
function closePendingPopup(){ $("pendingModalOverlay").classList.add("hidden"); }
function getWaitingPayments(labourId){
  const all = computeLedgers(labourId || undefined);
  const out = [];
  Object.keys(all).forEach(lid => all[lid].waiting.forEach(w => out.push(w)));
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
function renderPendingPopup(){
  const list = getWaitingPayments(pendingPopupLabourId);
  const nm = id => (DATA.labours.find(x => x.id === id) || {}).name || "—";
  const title = pendingPopupLabourId ? "⏳ " + escapeHtml(nm(pendingPopupLabourId)) + " — Credit baaki" : "⏳ Sarkar Credit baaki — sab Labour";
  $("pendingModalBody").innerHTML = `
    <h3 style="margin-bottom:4px">${title}</h3>
    <p style="font-size:12px;color:var(--muted);margin:0 0 8px">Ye payments abhi Khata me nahi judte. Credit hote hi apne-aap entry ban jayegi.</p>
    ${list.length ? list.map(w => `
      <div class="lg-row" style="grid-template-columns:1fr auto;align-items:center">
        <div class="lg-main"><div class="lg-date"><b>${pendingPopupLabourId ? "" : escapeHtml(nm(w.labourId)) + " · "}${fmtDate(w.date)}</b></div>
          <div class="lg-note">Payment ₹${w.payment} · credit hone par baaki me judega ₹${w.amount.toFixed(2)}</div></div>
        <button class="btn btn-green btn-sm" onclick="creditFromPopup('${w.paymentId}')">Credit hua ✔</button>
      </div>`).join("") : `<div class="empty">Koi payment baaki nahi 🎉</div>`}
    <div class="row mt"><button class="btn btn-gray btn-sm" style="flex:1" onclick="closePendingPopup()">Band karein</button></div>`;
}
function creditFromPopup(paymentId){
  creditAC(paymentId);
  renderPendingPopup();
  if(currentLedgerLabourId) renderLedgerModal();
}

/* ---------------------------------------------------------------
   👥 BULK DIYA — kai Labour ne ek saath diya (poora / aadha / fix rakam) + Comment
   Save karte hi sabke Khata me payment-wise "Mila" chadh jata hai
--------------------------------------------------------------- */
let bulkSel = {};
function openBulkDiya(){
  bulkSel = {};
  $("bulkNote").value = "diya";
  $("bulkPayDate").value = "";
  renderBulkDiya();
  $("bulkModalOverlay").classList.remove("hidden");
}
function closeBulkDiya(){ $("bulkModalOverlay").classList.add("hidden"); }
// Credited payment jinka Comment abhi khaali hai (matlab paisa abhi nahi mila)
function getBulkEligible(){
  const f = $("bulkPayDate") ? $("bulkPayDate").value : "";
  const nm = id => (DATA.labours.find(x => x.id === id) || {}).name || "";
  return DATA.payments.filter(p => {
    if(!isPaymentCredited(p) || (f && p.date !== f)) return false;
    const d = DATA.demands.find(x => x.date === p.date && x.labourId === p.labourId);
    return d && getPaymentLeft(p) > 0;
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)) || nm(a.labourId).localeCompare(nm(b.labourId)));
}
function renderBulkDiya(){
  const sel = $("bulkPayDate"), cur = sel.value;
  const dates = Array.from(new Set((function(){ const f = sel.value; sel.value = ""; const l = getBulkEligible(); sel.value = f; return l; })().map(p => p.date))).sort().reverse();
  sel.innerHTML = `<option value="">Sabhi dates</option>` + dates.map(d => `<option value="${d}" ${d === cur ? "selected" : ""}>${fmtDate(d)}</option>`).join("");
  const list = getBulkEligible();
  const nm = id => (DATA.labours.find(x => x.id === id) || {}).name || "—";
  let n = 0;
  $("bulkRows").innerHTML = list.length ? list.map(p => {
    const on = !!bulkSel[p.id]; if(on) n++;
    return `<label class="chk-item" style="cursor:pointer"><input type="checkbox" ${on ? "checked" : ""} onchange="toggleBulkSel('${p.id}', this.checked)">
      <div style="flex:1"><b>${escapeHtml(nm(p.labourId))}</b><div style="font-size:11.5px;color:var(--muted)">${fmtDate(p.date)} · Payment ₹${Number(p.amount) || 0}</div></div>
      <div style="font-weight:700;color:#c0392b">₹${((Number(p.amount) || 0) * 0.5).toFixed(2)}</div></label>`;
  }).join("") : `<div class="empty">Koi baaki payment nahi — sab ka Comment/Mila ho chuka hai.</div>`;
  $("bulkCnt").textContent = n + " select";
  $("bulkAll").checked = list.length > 0 && n === list.length;
}
function toggleBulkSel(id, on){ bulkSel[id] = on; renderBulkDiya(); }
function toggleBulkAll(on){ getBulkEligible().forEach(p => { bulkSel[p.id] = on; }); renderBulkDiya(); }
// Save: chune hue sabhi payments ke Demand par Comment likh deta hai -> Khata me apne-aap "Mila" (credit) ban jata hai
function saveBulkDiya(){
  const note = ($("bulkNote").value || "").trim();
  let c = 0, tot = 0;
  getBulkEligible().forEach(p => {
    if(!bulkSel[p.id]) return;
    const dem = DATA.demands.find(d => d.date === p.date && d.labourId === p.labourId);
    if(!dem) return;
    const left = getPaymentLeft(p);
    dem.mila = round2((Number(dem.mila) || 0) + left); dem.milaDate = todayISO();
    if(note) dem.comment = note;
    c++; tot += left;
  });
  if(!c){ toast("Pehle Labour select karein", "error"); return; }
  persist();
  bulkSel = {};
  closeBulkDiya();
  refreshPaymentViews();
  toast(c + " Labour ke khata me ₹" + tot.toFixed(2) + " Mila ho gaya ✅");
}

$("ledgerModalOverlay").addEventListener("click", e => {
  if(e.target.id === "ledgerModalOverlay") closeLedgerModal();
});

/* ---------------------------------------------------------------
   KHATA BAAKI REPORT — sabka outstanding Mate Share ek PDF me
--------------------------------------------------------------- */
function getKhataBaakiRows(){
  const all = computeLedgers();
  const rows = [];
  DATA.labours.forEach(l => {
    const lg = all[l.id];
    if(lg && Math.abs(lg.balance) >= 0.005) rows.push({ labour: l, lg });
  });
  rows.sort((a, b) => b.lg.balance - a.lg.balance);
  return rows;
}

function khataPdfHtml(rows){
  const cell = "border:1px solid #000;padding:4px;font-size:10.5px";
  let total = 0;
  rows.forEach(r => { total += r.lg.balance; });
  return `
    <div style="font-family:'Hind',Arial,sans-serif;color:#000;background:#fff;padding:8px;border:1px solid #000">
      <h2 style="text-align:center;font-size:15px;margin:0 0 4px">📒 Mate Share — Baaki Report</h2>
      <p style="text-align:center;font-size:10px;margin:0 0 8px">Labour Job Card System — ${fmtDate(todayISO())}</p>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="${cell};background:#f0f0f0">#</th><th style="${cell};background:#f0f0f0">Naam</th><th style="${cell};background:#f0f0f0">Jobcard</th>
          <th style="${cell};background:#f0f0f0">Kul Mate Share ₹</th><th style="${cell};background:#f0f0f0">Mile ₹</th>
          <th style="${cell};background:#f0f0f0">Diye ₹</th><th style="${cell};background:#f0f0f0">Baaki ₹</th>
        </tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr>
            <td style="${cell};text-align:center">${i + 1}</td>
            <td style="${cell}">${escapeHtml(r.labour.name)}</td>
            <td style="${cell}">${escapeHtml(r.labour.jobcardNo || "")}</td>
            <td style="${cell};text-align:right">${r.lg.kulAaya.toFixed(2)}</td>
            <td style="${cell};text-align:right">${r.lg.kulMila.toFixed(2)}</td>
            <td style="${cell};text-align:right">${r.lg.kulDiye.toFixed(2)}</td>
            <td style="${cell};text-align:right;font-weight:700">${r.lg.balance < 0 ? "−" : ""}${Math.abs(r.lg.balance).toFixed(2)}</td>
          </tr>`).join("")}</tbody>
      </table>
      <div style="background:#9c3b2e;color:#fff;text-align:center;padding:8px;border-radius:6px;margin-top:8px">
        <div style="font-size:15px;font-weight:700">₹${total.toFixed(2)}</div>
        <div style="font-size:10.5px">Kul Baaki — ${rows.length} Labour</div>
      </div>
      <p style="text-align:right;font-size:9.5px;color:#444;margin-top:8px;border-top:1px solid #999;padding-top:4px">Developed by Kurban Ali</p>
    </div>`;
}

async function downloadKhataPDF(mode){
  mode = mode || "download";
  const rows = getKhataBaakiRows();
  if(!rows.length){ toast("Abhi kisi Labour ka Khata baaki nahi hai", "error"); return; }
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
    const PER_PAGE = 36;
    const chunks = [];
    for(let i = 0; i < rows.length; i += PER_PAGE) chunks.push(rows.slice(i, i + PER_PAGE));
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:700px;background:#fff";
    document.body.appendChild(container);
    try{
      for(let p = 0; p < chunks.length; p++){
        container.innerHTML = khataPdfHtml(chunks[p]);
        await new Promise(r => setTimeout(r, 60));
        const canvas = await html2canvas(container.firstElementChild, { scale: 2, backgroundColor: "#ffffff", logging: false });
        if(!canvas || !canvas.width) throw new Error("blank canvas");
        const imgWidth = pageWidth - margin * 2;
        const imgHeight = Math.min((canvas.height * imgWidth) / canvas.width, pageHeight - margin * 2);
        if(p > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/png", 1.0), "PNG", margin, margin, imgWidth, imgHeight);
      }
    } finally { document.body.removeChild(container); }
    await finalizePdf(pdf, `Khata_Baaki_${todayISO()}.pdf`, mode);
    if(mode !== "share") toast("PDF Download ho gaya");
  }catch(err){
    console.error("Khata PDF error:", err);
    toast("PDF banane me dikkat hui, dobara try karein", "error");
  }
}
function shareKhataPDF(){ downloadKhataPDF("share"); }


/* ---------------------------------------------------------------
   TABS
--------------------------------------------------------------- */
const TAB_ORDER = ["dashboard", "report", "nrega"];

// AC Credit ab Dashboard ke 📒 Khata ke andar hai — purane links yahin kholte hain
function openACInKhata(){
  switchTab("dashboard");
  if($("acOnlyPending")) $("acOnlyPending").checked = false;
  renderACList();
  $("acModalOverlay").classList.remove("hidden");
}
function closeACModal(){
  $("acModalOverlay").classList.add("hidden");
  renderDashboardKhata();
}

function switchTab(name){
  if(name === "accredit"){ openACInKhata(); return; }
  if(name === "labour"){ switchTab("dashboard"); openLabourModal(1); return; }
  if(name === "past"){ switchTab("dashboard"); openDemandModal(1); return; }
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
  if(name === "dashboard"){ renderDashboard(); renderDashboardKhata(); renderLabourProfileList(); renderACList(); }
  if(name === "labour"){ renderLabours(); renderDashboardKhata(); }
  if(name === "past"){
    if($("onePasteDate") && !$("onePasteDate").value) $("onePasteDate").value = todayISO();
    if($("demandDate") && !$("demandDate").value) $("demandDate").value = todayISO();
    renderDemandLabourList();
    renderDemands();
  }
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

  let mateBaakiTotal = 0;
  const ledgers = computeLedgers();
  Object.keys(ledgers).forEach(lid => { if(ledgers[lid].balance > 0) mateBaakiTotal += ledgers[lid].balance; });

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
        <span>Khata Baaki: <b>₹${getLabourBalance(b.labour.id).toFixed(2)}</b></span>
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
        ${(() => { const lg = getLabourLedger(b.labour.id); return ` &nbsp;|&nbsp; Khata: Mate Share <b>₹${lg.kulAaya.toFixed(2)}</b>, Mile <b>₹${lg.kulMila.toFixed(2)}</b>, Diye <b>₹${lg.kulDiye.toFixed(2)}</b>, Baaki <b>₹${lg.balance.toFixed(2)}</b>`; })()}
      </div>
      ${b.ledgerRows && b.ledgerRows.length ? `
      <div style="margin-top:6px;font-size:11px;font-weight:700">Khata (Len-Den)</div>
      <table style="width:100%;border-collapse:collapse;font-size:10.5px;margin-top:3px">
        <thead><tr>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Date</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Details</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Diye ₹</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Mile ₹</th>
          <th style="border:1px solid #000;padding:4px;background:#f0f0f0">Baaki ₹</th>
        </tr></thead>
        <tbody>${b.ledgerRows.map(r => `<tr>
          <td style="border:1px solid #000;padding:4px;text-align:center">${fmtDate(r.date)}</td>
          <td style="border:1px solid #000;padding:4px">${r.kind === "due" ? "Mate Share" : ""} ${r.comment ? escapeHtml(r.comment) : ""}</td>
          <td style="border:1px solid #000;padding:4px;text-align:right">${r.kind === "mile" ? "" : r.amount.toFixed(2)}</td>
          <td style="border:1px solid #000;padding:4px;text-align:right">${r.kind === "mile" ? r.amount.toFixed(2) : ""}</td>
          <td style="border:1px solid #000;padding:4px;text-align:right">${r.balanceAfter.toFixed(2)}</td>
        </tr>`).join("")}</tbody>
      </table>` : ""}
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
            ledgerRows: i === total - 1 ? b.ledgerRows : null,
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
          trash: toArray(parsed.trash),
          ledger: toArray(parsed.ledger)
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
    if(idx > -1) DATA.labours[idx] = { ...DATA.labours[idx], id: editingLabourId, jobcardNo, name, aadhar, status };
    toast("Labour update ho gaya");
    cancelLabourEdit();
  } else {
    DATA.labours.push({ id: makeId(), jobcardNo, name, aadhar, status, form10Priority: false });
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
let ddSelDate = null;
function renderDemandDates(){
  const box = $("demandDatesList");
  if(!box) return;
  const dates = [...new Set(DATA.demands.map(d => d.date))].sort().reverse();
  if(!dates.length){ box.innerHTML = `<div class="empty">Koi Demand nahi hai.</div>`; return; }
  box.innerHTML = dates.map((dt, i) => {
    const entries = DATA.demands.filter(d => d.date === dt);
    let cred = 0, total = 0;
    const itemsHtml = entries.map(e => {
      const l = DATA.labours.find(x => x.id === e.labourId) || {};
      const p = DATA.payments.find(x => x.date === dt && x.labourId === e.labourId);
      const ac = DATA.acCredits.find(x => x.date === dt && x.labourId === e.labourId);
      const isC = ac && ac.status === "Credited";
      if(isC) cred++;
      total += p ? (Number(p.amount) || 0) : 0;
      const hasComment = e.comment && String(e.comment).trim();
      return `
        <div class="dd-item">
          <span>${isC ? "🟢" : "⚪"} ${escapeHtml(l.name || "—")} — ${e.kulDin || 0} Din</span>
          <span>₹${p ? p.amount : 0} ${hasComment ? `<span class="badge active">${escapeHtml(e.comment)}</span>` : `<span class="badge pending">Khaali</span>`}</span>
        </div>`;
    }).join("");
    const n = entries.length, left = n - cred;
    const cls = cred === n ? "all" : (cred > 0 ? "part" : "");
    const sel = ddSelDate === dt;
    return `
      <div class="dd-date-row ${sel ? "sel" : ""}" onclick="toggleDemandDate(${i}, '${dt}')">
        <span style="display:flex;align-items:center;gap:8px"><span class="dd-dot ${cls}"></span>${fmtDate(dt)}</span>
        <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <span class="dd-count">${n} Labour${left > 0 ? " · " + left + " baaki" : ""}</span>
          <span class="dd-count" style="background:#eef0ee;color:#333">₹${total}</span>
          <button class="btn btn-blue btn-sm" style="padding:2px 8px;font-size:11px" onclick="event.stopPropagation();openACForDate('${dt}')">🏦 AC</button>
        </span>
      </div>
      <div class="dd-detail ${sel ? "open" : ""}" id="ddDetail-${i}">${itemsHtml}</div>
    `;
  }).join("");
}
// Demand Dates ki ek date ko AC Credit me kholo (us date ka filter lag jata hai)
function openACForDate(dt){
  $("acDate").value = dt;
  acTab(1);
  renderACList();
}
function acTab(n){
  [1,2,3].forEach(i => {
    $("acPane" + i).classList.toggle("hidden", i !== n);
    const b = $("acTabBtn" + i);
    b.classList.toggle("btn-green", i === n);
    b.classList.toggle("btn-gray", i !== n);
  });
  if(n === 2) renderDemands();
  if(n === 3) renderDemandDates();
}
function toggleDemandDate(i, dt){
  ddSelDate = (ddSelDate === dt) ? null : dt;
  renderDemandDates();
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
  // Upar: Khata (Mate Share baaki) — Dashboard wali list isi shared function se banti hai
  renderKhataSummaryInto("paymentKhataSummary");
  renderKhataListInto("paymentKhataList", $("paymentKhataSearch") ? $("paymentKhataSearch").value : "");

}

// Payment Pending list se seedha comment likh kar Save karne ke liye


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

  $("demandCount").textContent = "(" + list.length + ")"; if($("demandCountX")) $("demandCountX").textContent = list.length + " Demand";

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
        <td>${d.comment && String(d.comment).trim() ? `<span class="badge active">${escapeHtml(d.comment)}</span>` : `<span class="badge pending">Khaali</span>`}</td>
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

  const labMap = {}, acMap = {}, demMap = {};
  DATA.labours.forEach(l => { labMap[l.id] = l; });
  DATA.acCredits.forEach(a => { acMap[a.date + "|" + a.labourId] = a; });
  DATA.demands.forEach(d => { demMap[d.date + "|" + d.labourId] = d; });

  if(term){
    list = list.filter(p => {
      const l = labMap[p.labourId] || {};
      return (l.name || "").toLowerCase().includes(term) || String(l.jobcardNo || "").toLowerCase().includes(term);
    });
  }
  if($("acOnlyPending") && $("acOnlyPending").checked){
    list = list.filter(p => { const a = acMap[p.date + "|" + p.labourId]; return !(a && a.status === "Credited"); });
  }

  $("acCount").textContent = "(" + list.length + " Entries)";

  $("acTableBody").innerHTML = list.map((p, i) => {
    const l = labMap[p.labourId] || {};
    const ac = acMap[p.date + "|" + p.labourId];
    const status = ac ? ac.status : "Pending";
    const credited = status === "Credited";
    const creditedDate = ac ? (ac.creditedDate || ac.date) : "";
    const mate = (Number(p.amount) || 0) * 0.5;
    const mStatus = credited ? paymentMateStatus(p) : null;
    const dem = demMap[p.date + "|" + p.labourId];
    return `
      <tr>
        <td><input type="checkbox" class="ac-row-chk" value="${p.id}"></td>
        <td>${i + 1}</td>
        <td>${fmtDate(p.date)}</td>
        <td>${escapeHtml(l.jobcardNo || "—")}</td>
        <td>${escapeHtml(l.name || "—")}</td>
        <td>₹${p.amount}</td>
        <td>₹${mate.toFixed(2)}</td>
        <td style="min-width:140px">${credited && dem
          ? `<div style="display:flex;gap:3px;align-items:center"><input type="number" min="0" step="any" id="mila-${p.id}" value="${getPaymentMila(p) || ""}" placeholder="${mate.toFixed(0)}" style="width:72px;font-size:12px;padding:4px 5px" onchange="setMilaFromInput('${p.id}')"><button class="btn btn-green btn-sm" style="padding:3px 7px" title="Poora Mila" onclick="tickMila('${p.id}')">✅</button></div>${getPaymentLeft(p) > 0 ? `<div style="font-size:11px;color:#c0392b">baaki ₹${getPaymentLeft(p).toFixed(2)}</div>` : ""}`
          : `<span style="color:var(--muted);font-size:12px">—</span>`}</td>
        <td>${credited
          ? (mStatus === "mila" ? `<span class="badge credited">✅ Mila</span>` : `<span class="badge pending">⏳ Pending</span>`)
          : `<span style="color:var(--muted);font-size:12px">—</span>`}</td>
        <td>
          <span class="badge ${status.toLowerCase()}">${status}</span>
          ${credited ? `<div class="mt" style="display:flex;align-items:center;gap:4px">
            <input type="date" class="ac-date-edit" value="${creditedDate}" style="width:132px;font-size:11.5px;padding:4px 5px" onchange="updateACCreditedDate('${p.id}', this.value)">
          </div>` : ""}
        </td>
        <td style="min-width:150px">${dem
          ? `<div style="display:flex;gap:4px"><input type="text" id="acc-${dem.id}" value="${escapeHtml(dem.comment || "")}" placeholder="comment..." style="min-width:100px;font-size:12px;padding:4px 6px" onkeydown="if(event.key==='Enter')saveACComment('${dem.id}')"><button class="btn btn-gray btn-sm" title="Save" onclick="saveACComment('${dem.id}')">💾</button></div>`
          : `<span style="color:var(--muted);font-size:12px">—</span>`}</td>
        <td>
          ${credited
            ? `<button class="btn btn-orange btn-sm" onclick="undoACCredit('${p.id}')">Undo</button>`
            : `<button class="btn btn-green btn-sm" onclick="creditAC('${p.id}')">Credit</button>`}
        </td>
      </tr>
    `;
  }).join("");
  $("acEmpty").classList.toggle("hidden", list.length > 0);
  $("acSelectAll").checked = false;
}

// Comment (AC popup) — ek row ka comment save; Khata me apne-aap Mila/Pending update
function saveACComment(demandId){
  const input = $("acc-" + demandId);
  if(!input) return;
  updateDemandField(demandId, "comment", input.value);
  refreshPaymentViews();
  toast("Comment save ho gaya", "success");
}
// Bulk Comment (AC popup) — chune hue payments ke Demand par ek saath comment
function bulkACComment(){
  const text = (($("acBulkComment") && $("acBulkComment").value) || "").trim();
  const ids = Array.from(document.querySelectorAll(".ac-row-chk:checked")).map(c => c.value);
  if(!ids.length){ toast("Pehle list se kam se kam ek entry select karein", "error"); return; }
  if(!text){ toast("Comment box khaali hai — pehle comment likhein", "error"); return; }
  let c = 0;
  ids.forEach(id => {
    const p = DATA.payments.find(x => x.id === id); if(!p) return;
    const d = DATA.demands.find(x => x.date === p.date && x.labourId === p.labourId);
    if(d){ d.comment = text; c++; }
  });
  if(!c){ toast("Chune hue payments ki Demand nahi mili", "error"); return; }
  persist();
  refreshPaymentViews();
  toast(c + " entry pe comment lag gaya", "success");
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
// Credit karte waqt "Credited Date" field se date liya jata hai (agar khaali hai to aaj ki date) —
// yeh Demand Date se alag hoti hai, kyunki paisa aksar Demand ke kai din baad Account me credit hota hai.
// Pehle se bhari hui Diya (agar ho) bani rehti hai.
function creditACRecord(paymentId){
  const p = DATA.payments.find(x => x.id === paymentId);
  if(!p) return;
  const chosenDate = ($("acCreditDate") && $("acCreditDate").value) || todayISO();
  const idx = DATA.acCredits.findIndex(a => a.date === p.date && a.labourId === p.labourId);
  const prev = idx > -1 ? DATA.acCredits[idx] : {};
  const record = { ...prev, id: prev.id || makeId(), date: p.date, labourId: p.labourId, status: "Credited", creditedDate: chosenDate };
  if(idx > -1) DATA.acCredits[idx] = record; else DATA.acCredits.push(record);
}

// "Diya" — Labour ne Mate Share me se kitna aapko diya (AC Credit aur Report dono tab yahi function use karte hain).
// Khaali ya 0 = abhi nahi mila. Amount Khata me "Aapko Mile" ban kar chadh jata hai.
function updateACDiya(paymentId, value){
  const p = DATA.payments.find(x => x.id === paymentId);
  if(!p) return;
  const idx = DATA.acCredits.findIndex(a => a.date === p.date && a.labourId === p.labourId);
  if(idx === -1 || DATA.acCredits[idx].status !== "Credited"){
    toast("Pehle AC Credit karein, phir Diya bharein", "error");
    refreshPaymentViews();
    return;
  }
  const mate = (Number(p.amount) || 0) * 0.5;
  const amt = (value === "" || value === null) ? 0 : parseFloat(value);
  if(isNaN(amt) || amt < 0){ toast("Sahi Amount daalein", "error"); refreshPaymentViews(); return; }
  if(amt > mate + 0.009){
    toast("Diya Mate Share (₹" + mate.toFixed(2) + ") se zyada nahi ho sakta", "error");
    refreshPaymentViews();
    return;
  }
  const ac = DATA.acCredits[idx];
  if(amt === (Number(ac.diya) || 0)) return;
  ac.diya = amt;
  ac.diyaDate = amt > 0 ? todayISO() : "";
  persist();
  refreshPaymentViews();
  toast(amt > 0 ? "Diya save ho gaya — Khata me chadh gaya" : "Diya 0 kar diya");
}

function refreshPaymentViews(){
  if(currentLedgerLabourId) renderLedgerModal();
  renderACList();
  if($("acPane3") && !$("acPane3").classList.contains("hidden")) renderDemandDates();
  generateReport();
  renderDashboard();
  renderDashboardKhata();
  renderPaymentPending();
}

function creditAC(paymentId){
  creditACRecord(paymentId);
  persist();
  renderACList();
  renderDemands();
  refreshPaymentViews(); // Khata, Report, Dashboard bhi turant update
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
  refreshPaymentViews(); // Khata, Report, Dashboard bhi turant update
  toast("AC Credit wapas Pending kar diya");
}

function bulkACCredit(){
  const checked = Array.from(document.querySelectorAll(".ac-row-chk:checked")).map(c => c.value);
  if(!checked.length){ toast("Pehle Payment select karein", "error"); return; }
  checked.forEach(pid => creditACRecord(pid));
  persist();
  renderACList();
  renderDemands();
  refreshPaymentViews(); // Khata, Report, Dashboard bhi turant update
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
  refreshPaymentViews(); // Khata, Report, Dashboard bhi turant update
  toast(`${checked.length} AC Credit wapas Pending kar diya`);
}

/* ================================================================
   TAB 5: REPORT
================================================================ */
// Report ki rows — screen, Print aur PDF teeno isi ek function se banti hain (filter/sort ek jaisa lage)
function getReportRows(){
  const date = $("reportDate") ? $("reportDate").value : "";
  const onlyCredited = $("reportOnlyCredited") ? $("reportOnlyCredited").checked : false;
  const onlyPending = $("reportOnlyPending") ? $("reportOnlyPending").checked : false;
  const sortBaaki = $("reportSortBaaki") ? $("reportSortBaaki").checked : false;

  DATA.demands = toArray(DATA.demands);
  DATA.labours = toArray(DATA.labours);
  DATA.payments = toArray(DATA.payments);
  DATA.acCredits = toArray(DATA.acCredits);

  const labMap = {}, payMap = {}, acMap = {};
  DATA.labours.forEach(l => { labMap[l.id] = l; });
  DATA.payments.forEach(p => { payMap[p.date + "|" + p.labourId] = p; });
  DATA.acCredits.forEach(a => { acMap[a.date + "|" + a.labourId] = a; });

  let demandList = date ? DATA.demands.filter(d => d.date === date) : DATA.demands.slice();
  demandList.sort((a, b) => b.date.localeCompare(a.date));

  let rows = demandList.map(d => {
    const l = labMap[d.labourId] || {};
    const p = payMap[d.date + "|" + d.labourId];
    const ac = acMap[d.date + "|" + d.labourId];
    const acStatus = ac ? ac.status : (p ? "Pending" : "—");
    const credited = acStatus === "Credited";
    const amount = p ? (Number(p.amount) || 0) : 0;
    const mate = amount * 0.5;
    const diya = p ? getPaymentPaid(p) : 0;
    return {
      d, l, p, ac, acStatus, credited, amount, mate, diya,
      baaki: credited ? Math.max(0, mate - diya) : 0,
      mateStatus: credited ? (p ? paymentMateStatus(p) : demandCommentStatus(d)) : null,
      creditDate: ac ? fmtDate(ac.creditedDate || ac.date) : ""
    };
  });

  if(onlyCredited) rows = rows.filter(r => r.credited);
  // "Sirf Pending" = Credited ho chuka par Comment abhi khaali (Mate Share Pending)
  if(onlyPending) rows = rows.filter(r => r.mateStatus === "pending");
  if(sortBaaki) rows.sort((a, b) => b.baaki - a.baaki || b.d.date.localeCompare(a.d.date));
  return rows;
}

function generateReport(){
  const date = $("reportDate") ? $("reportDate").value : "";
  const rows = getReportRows();

  const emptyBox = $("reportEmpty");
  const titleBox = $("reportTitle");
  const summaryBox = $("reportSummary");
  const bodyBox = $("reportTableBody");

  if(!rows.length){
    if(bodyBox) bodyBox.innerHTML = "";
    if(summaryBox) summaryBox.innerHTML = "";
    if(titleBox) titleBox.textContent = "📊 Report";
    if(emptyBox) emptyBox.classList.remove("hidden");
    return;
  }
  if(emptyBox) emptyBox.classList.add("hidden");
  if(titleBox) titleBox.textContent = date ? `📊 Report — ${fmtDate(date)}` : "📊 Report — Sabhi Dates";

  let totalPayment = 0, totalMate = 0, totalLabour = 0, creditedCount = 0, totalDiya = 0, totalBaaki = 0;
  const rowsHtml = rows.map((r, i) => {
    if(r.p){ totalPayment += r.amount; totalMate += r.mate; totalLabour += r.amount * 0.5; }
    if(r.credited){ creditedCount++; totalDiya += r.diya; totalBaaki += r.baaki; }
    const d = r.d, l = r.l, p = r.p;
    return `
      <tr>
        <td class="nw no-print">${p ? `<input type="checkbox" class="rep-row-chk" value="${p.id}">` : ""}</td>
        <td class="nw">${i + 1}</td>
        <td>${escapeHtml(l.name || "—")}</td>
        <td>${escapeHtml(l.jobcardNo || "—")}</td>
        <td class="nw">${d.kulDin ?? ""}</td>
        <td class="nw">${d.pratidin ?? ""}</td>
        <td class="nw">${p ? "₹" + p.amount : "—"}</td>
        <td class="nw">${p ? "₹" + r.mate.toFixed(2) : "—"}</td>
        <td class="nw">${r.credited && p
          ? `<div style="display:flex;gap:3px;align-items:center"><input type="number" min="0" step="any" id="rmila-${p.id}" value="${getPaymentMila(p) || ""}" placeholder="${r.mate.toFixed(0)}" style="width:70px;font-size:12px;padding:4px 5px" onchange="setMilaFromInput('${p.id}', 'rmila-')"><button class="btn btn-green btn-sm" style="padding:3px 7px" title="Poora Mila" onclick="tickMila('${p.id}')">✅</button></div>${r.diya && r.diya !== getPaymentMila(p) ? `<div style="font-size:11px;color:var(--muted)">kul ₹${r.diya}</div>` : ""}`
          : "—"}</td>
        <td class="nw" style="font-weight:700;color:${r.baaki > 0 ? "#c0392b" : "#146c33"}">${r.credited ? (r.baaki > 0 ? "₹" + r.baaki.toFixed(2) : "✅") : "—"}</td>
        <td class="nw">${r.mateStatus === "mila" ? `<span class="badge credited">✅ Mila</span>` : (r.mateStatus === "pending" ? `<span class="badge pending">⏳ Pending</span>` : "—")}</td>
        <td class="nw"><span class="badge ${r.acStatus === "Credited" ? "credited" : r.acStatus === "Pending" ? "pending" : ""}">${r.acStatus}</span></td>
        <td class="nw">${r.creditDate || "—"}</td>
        <td class="c-comment">
          <div style="display:flex;gap:4px;align-items:center">
            <input type="text" class="rep-comment" id="rcmt-${d.id}" value="${escapeHtml(d.comment || "")}" placeholder="...">
            <button class="btn btn-blue btn-sm" style="padding:5px 8px" onclick="saveReportComment('${d.id}')" title="Comment Save karein">💾</button>
          </div>
        </td>
      </tr>
    `;
  });

  if(bodyBox) bodyBox.innerHTML = rowsHtml.join("");
  if(summaryBox){
    summaryBox.innerHTML = `
      <div class="sum-card"><div class="v">${rows.length}</div><div class="l">Total Records</div></div>
      <div class="sum-card"><div class="v">₹${totalPayment.toFixed(2)}</div><div class="l">Total Payment</div></div>
      <div class="sum-card"><div class="v">₹${totalMate.toFixed(2)}</div><div class="l">Mate Share</div></div>
      <div class="sum-card"><div class="v">₹${totalLabour.toFixed(2)}</div><div class="l">Labour Share</div></div>
      <div class="sum-card"><div class="v">${creditedCount}/${rows.length}</div><div class="l">AC Credited</div></div>
      <div class="sum-card"><div class="v" style="color:#146c33">₹${totalDiya.toFixed(2)}</div><div class="l">Diya (Mila)</div></div>
      <div class="sum-card"><div class="v" style="color:#c0392b">₹${totalBaaki.toFixed(2)}</div><div class="l">Mate Baaki</div></div>
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
  return getReportRows().map(r => ({
    name: r.l.name || "—",
    jobcardNo: r.l.jobcardNo || "—",
    kulDin: r.d.kulDin ?? "",
    pratidin: r.d.pratidin ?? "",
    amount: r.p ? "₹" + r.p.amount : "—",
    mate: r.p ? r.mate.toFixed(2) : "—",
    diya: r.credited ? (r.diya ? r.diya.toFixed(2) : "0") : "—",
    baaki: r.credited ? (r.baaki > 0 ? r.baaki.toFixed(2) : "0") : "—",
    status: r.acStatus,
    credit: r.creditDate || "—",
    // Comment khaali hai to yahan bilkul khaali string hi jaayegi —
    // koi placeholder/"comment" word print nahi hoga
    comment: r.d.comment ? String(r.d.comment).trim() : ""
  }));
}

function reportPrintDocHtml(pageRows, dateLabel, pageNum, totalPages, startIndex){
  const nw = "white-space:nowrap;width:1%"; // content jitni hi chaudi, wrap nahi
  const cell = "border:1px solid #000;padding:4px";
  const rows = pageRows.map((r, i) => `
    <tr>
      <td style="${cell};text-align:center;${nw}">${startIndex + i + 1}</td>
      <td style="${cell}">${escapeHtml(r.name)}</td>
      <td style="${cell};${nw}">${escapeHtml(r.jobcardNo)}</td>
      <td style="${cell};text-align:center;${nw}">${escapeHtml(String(r.kulDin))}</td>
      <td style="${cell};text-align:center;${nw}">${escapeHtml(String(r.pratidin))}</td>
      <td style="${cell};text-align:center;${nw}">${escapeHtml(r.amount)}</td>
      <td style="${cell};text-align:center;${nw}">${escapeHtml(r.mate)}</td>
      <td style="${cell};text-align:center;${nw}">${escapeHtml(r.diya)}</td>
      <td style="${cell};text-align:center;font-weight:700;${nw}">${escapeHtml(r.baaki)}</td>
      <td style="${cell};text-align:center;${nw}">${escapeHtml(r.status)}</td>
      <td style="${cell};text-align:center;${nw}">${escapeHtml(r.credit)}</td>
      <td style="${cell}">${escapeHtml(r.comment)}</td>
    </tr>`).join("");
  const th = `border:1px solid #000;padding:4px;background:#f0f0f0`;
  return `
    <div style="font-family:'Hind',Arial,sans-serif;color:#000;background:#fff;padding:6px;border:1px solid #000">
      <h2 style="text-align:center;font-size:16px;margin:0">📊 Report${dateLabel ? " — " + dateLabel : " — Sabhi Dates"}</h2>
      <p style="text-align:center;font-size:10.5px;margin:4px 0 10px">Labour Job Card System — ${fmtDate(todayISO())}${totalPages > 1 ? ` — Page ${pageNum}/${totalPages}` : ""}</p>
      <table style="width:100%;border-collapse:collapse;font-size:9.5px">
        <thead><tr>
          <th style="${th};${nw}">#</th>
          <th style="${th}">Name</th>
          <th style="${th};${nw}">Jobcard No.</th>
          <th style="${th};${nw}">Din</th>
          <th style="${th};${nw}">Dar ₹</th>
          <th style="${th};${nw}">Kul ₹</th>
          <th style="${th};${nw}">Mate ₹</th>
          <th style="${th};${nw}">Diya ₹</th>
          <th style="${th};${nw}">Baaki ₹</th>
          <th style="${th};${nw}">Status</th>
          <th style="${th};${nw}">Credit</th>
          <th style="${th}">Comment</th>
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

/* ---------------------------------------------------------------
   FORM 10 — AUTO / MANUAL mode + ⭐ Priority
   Ek Jobcard par 2 naam (pati-patni) ho to Jobcard ke BAAKI din dekh kar
   app khud decide karta hai: 1 naam aaye ya 2.
     baaki 0 ya kam  -> din khatam
     10 se kam       -> 1 naam (⚠️ jaldi khatam)
     10 se 16        -> sirf 1 naam
     16 se zyada     -> 2 naam
   Jab sirf 1 naam chahiye to ⭐ Priority wala naam (aksar patni) chuna jata hai.
   Manual mode me app kuch decide nahi karta, aap khud chunte ho.
--------------------------------------------------------------- */
let nregaAutoMode = true;

function getJobcardNameSuggestion(baaki){
  if(baaki <= 0) return null;
  if(baaki < 10) return "warn";
  if(baaki <= JOBCARD_LOW_WARNING) return "one";
  return "two";
}

function getActiveJobcardMembers(jobcardNo){
  return DATA.labours.filter(x => x.jobcardNo === jobcardNo && x.status === "Active");
}

function autoSyncJobcardSelection(labourId, wantSelected){
  const l = DATA.labours.find(x => x.id === labourId);
  if(!l) return;
  const members = getActiveJobcardMembers(l.jobcardNo);
  if(members.length < 2){
    if(wantSelected) nregaSelected.add(labourId); else nregaSelected.delete(labourId);
    return;
  }
  if(!wantSelected){ members.forEach(m => nregaSelected.delete(m.id)); return; }

  const sugg = getJobcardNameSuggestion(getJobcardBaaki(l.jobcardNo));
  if(sugg === "two"){ members.forEach(m => nregaSelected.add(m.id)); return; }

  // 1 naam: ⭐ Priority wala, nahi to jise aapne dabaya
  const keep = members.find(m => m.form10Priority) || l;
  members.forEach(m => { if(m.id === keep.id) nregaSelected.add(m.id); else nregaSelected.delete(m.id); });
  if(!sugg) toast("Is Jobcard me ek bhi din baaki nahi hai", "info");
}

function setNregaMode(mode){
  nregaAutoMode = (mode === "auto");
  const a = $("btnNregaAuto"), m = $("btnNregaManual");
  if(a) a.className = "btn btn-sm " + (nregaAutoMode ? "btn-green" : "btn-outline");
  if(m) m.className = "btn btn-sm " + (!nregaAutoMode ? "btn-green" : "btn-outline");
  if(nregaAutoMode){
    const seen = new Set();
    Array.from(nregaSelected).forEach(id => {
      const l = DATA.labours.find(x => x.id === id);
      if(!l || seen.has(l.jobcardNo)) return;
      seen.add(l.jobcardNo);
      autoSyncJobcardSelection(id, true);
    });
  }
  renderNregaSearch();
}

function toggleForm10Priority(id){
  const l = DATA.labours.find(x => x.id === id);
  if(!l) return;
  const willSet = !l.form10Priority;
  // Ek Jobcard par ek hi ⭐
  DATA.labours.forEach(x => { if(x.jobcardNo === l.jobcardNo) x.form10Priority = false; });
  l.form10Priority = willSet;
  persist();
  if(nregaAutoMode){
    const sel = getActiveJobcardMembers(l.jobcardNo).find(m => nregaSelected.has(m.id));
    if(sel) autoSyncJobcardSelection(sel.id, true);
  }
  renderNregaSearch();
}

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
    const jcMembers = getActiveJobcardMembers(l.jobcardNo);
    const isDual = jcMembers.length > 1;
    const isSel = nregaSelected.has(l.id);
    const sugg = getJobcardNameSuggestion(baaki);
    const partnerSelected = isDual && !isSel && jcMembers.some(m => m.id !== l.id && nregaSelected.has(m.id));
    let suggBadge = "";
    if(isDual){
      if(sugg === "two") suggBadge = ' <span class="badge active">2 naam</span>';
      else if(sugg === "one") suggBadge = ' <span class="badge pending">1 naam</span>';
      else if(sugg === "warn") suggBadge = ' <span class="badge pending">1 naam ⚠️ kam din</span>';
      else suggBadge = ' <span class="badge inactive">din khatam</span>';
    }
    const partnerChip = (partnerSelected && !nregaAutoMode) ? ' <span class="badge" style="background:#ffe4b3;color:#8a5300">Jodidaar select, ye baaki</span>' : "";
    return `
    <div class="chk-item">
      <input type="checkbox" class="nrega-chk" value="${l.id}" ${isSel ? "checked" : ""} onchange="toggleNregaSelect('${l.id}', this.checked)">
      <div style="flex:1">${escapeHtml(l.name)} <span style="font-size:12px;color:var(--muted)">(Jobcard: ${escapeHtml(l.jobcardNo)})</span>${low ? ' <span class="badge" style="background:#ffe4b3;color:#8a5300">⚠️ Kam Din</span>' : ""}${suggBadge}${partnerChip}</div>
      ${isDual ? `<button class="star-btn ${l.form10Priority ? "active" : ""}" onclick="toggleForm10Priority('${l.id}')" title="Priority: sirf 1 naam chahiye to ye pehle aayega">★</button>` : ""}
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
  if(nregaAutoMode){
    autoSyncJobcardSelection(id, checked);
    renderNregaSearch();
    return;
  }
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
  if(nregaAutoMode && checked){
    const seen = new Set();
    Array.from(nregaSelected).forEach(id => {
      const l = DATA.labours.find(x => x.id === id);
      if(!l || seen.has(l.jobcardNo)) return;
      seen.add(l.jobcardNo);
      autoSyncJobcardSelection(id, true);
    });
  }
  renderNregaSearch();
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
    const oneNameOk = nregaAutoMode && getJobcardNameSuggestion(getJobcardBaaki(l.jobcardNo)) !== "two" && members.some(id => nregaSelected.has(id));
    const allMembersSelected = members.every(id => nregaSelected.has(id)) || oneNameOk;
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

/* ================================================================
   FORM 6 (प्रपत्र-6 — कार्य के लिए आवेदन पत्र) — Form 10 ke chune hue Labour ke naam
   aur Jobcard number auto-fill hote hain (ek page par 5 naam — original Form 6 ki tarah).
   Mukhiya ka naam, pakhwada ke tick, tareekh, sign — haath se bharne ke liye khaali.
================================================================ */
function nregaForm6Html(chunk){
  const fy = (typeof getCurrentFYRange === "function") ? getCurrentFYRange() : null;
  const fyLabel = fy ? (fy.start.slice(0, 4) + "-" + String(Number(fy.start.slice(0, 4)) + 1).slice(2)) : "";
  const N = 5;
  const padded = chunk.slice();
  while(padded.length < N) padded.push(null);
  const cell = "border:1px solid #000;padding:2px 5px;height:19px";
  const th = "border:1px solid #000;padding:2px;background:#fff;font-weight:700";
  const nameRows = padded.map((l, i) => `<tr>
      <td style="${cell};text-align:center;width:34px">${i + 1}</td>
      <td style="${cell}">${l ? escapeHtml(l.name) : ""}</td>
      <td style="${cell};width:24%"></td>
      <td style="${cell};width:24%">${l ? escapeHtml(l.jobcardNo) : ""}</td></tr>`).join("");
  const recRows = padded.map((l, i) => `<tr>
      <td style="${cell};text-align:center;width:34px">${i + 1}</td>
      <td style="${cell}">${l ? escapeHtml(l.name) : ""}</td>
      <td style="${cell};width:38%">${l ? escapeHtml(l.jobcardNo) : ""}</td></tr>`).join("");
  const mc = "border:1px solid #000;padding:2px;height:15px;font-size:10.5px";
  const monthTbl = (months) => `<table style="border-collapse:collapse;font-size:10.5px;flex:1">
      <thead><tr><th rowspan="2" style="${th}">माह</th><th colspan="2" style="${th}">पखवाड़ा</th></tr>
      <tr><th style="${th}">प्रथम</th><th style="${th}">द्वितीय</th></tr></thead>
      <tbody>${months.map(m => `<tr><td style="${mc}">${m}</td><td style="${mc};width:60px"></td><td style="${mc};width:60px"></td></tr>`).join("")}</tbody></table>`;
  const m1 = ["अप्रेल","मई","जून","जुलाई"], m2 = ["अगस्त","सितम्बर","अक्टूबर","नवम्बर"], m3 = ["दिसम्बर","जनवरी","फरवरी","मार्च"];
  const dots = (w) => `<span style="display:inline-block;border-bottom:1px dotted #000;min-width:${w}px">&nbsp;</span>`;
  return `
  <div style="width:760px;background:#fff;color:#000;font-family:'Hind',Arial,sans-serif;padding:14px 18px;font-size:12px;line-height:1.4;position:relative">
    <div style="position:absolute;right:18px;top:12px;border:2px solid #000;padding:2px 10px;font-weight:700;font-size:14px">प्रपत्र - 6</div>
    <div style="text-align:center;font-weight:700;font-size:15px;margin:0 90px">महात्मा गांधी राष्ट्रीय ग्रामीण रोजगार गारण्टी योजना, राजस्थान</div>
    <div style="text-align:center;font-weight:700;font-size:14px;margin-top:2px">कार्य के लिए आवेदन पत्र वित्तीय वर्ष ${fyLabel || dots(80)}</div>
    <div style="text-align:center;font-size:12px;margin-bottom:6px">( 100 दिवस के लिए व्यक्तिगत/समूह आवेदन पत्र )</div>
    <div style="margin-bottom:4px">जिला <b>जैसलमेर</b> &nbsp; पंचायत समिति <b>जैसलमेर</b> &nbsp; ग्राम पंचायत ${dots(110)} &nbsp; ग्राम ${dots(90)}</div>
    <div style="font-weight:600;margin-bottom:2px">व्यक्तिगत/समूह आवेदन :</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr><th style="${th}">क्र.<br>सं.</th><th style="${th}">व्यक्तिगत/समूह में कार्य मांगने वाले<br>व्यक्तियों के नाम</th><th style="${th}">मुखिया का नाम</th><th style="${th}">जॉबकार्ड नं.</th></tr></thead>
      <tbody>${nameRows}</tbody></table>
    <div style="font-weight:600;margin:6px 0 2px">कार्य मांगने की अवधि :</div>
    <div style="display:flex;gap:8px">${monthTbl(m1)}${monthTbl(m2)}${monthTbl(m3)}</div>
    <div style="display:flex;justify-content:space-between;margin-top:14px;font-size:11.5px">
      <div>दिनांक :- ${dots(70)}</div>
      <div>हस्ताक्षर/अंगूठा निशानी आवेदक ${dots(100)}<br>नाम ${dots(150)}</div>
      <div style="text-align:center">हस्ताक्षर सरपंच/ग्रा. वि. अधिकारी/<br>ग्रा. रो. सहायक/क. सहायक/वार्ड पंच</div>
    </div>
    <div style="font-size:11px;margin-top:6px">नोट :- 1. संबद्ध कॉलम में ( ✓ ) अंकित करें। यदि किसी भिन्न तिथि को कार्य चाहते है, तो उसमें तिथि अंकित कर दें।<br>
      &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;2. वर्ष में 100 दिन कार्य हेतु कम से कम 8 पखवाड़े तक काम की माँग करें।</div>
    <div style="border-top:1px dotted #000;margin:8px 0 4px"></div>
    <div style="text-align:center;font-weight:700;font-size:13px;margin-bottom:3px">रसीद</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr><th style="${th}">क्र.<br>सं.</th><th style="${th}">व्यक्तिगत/समूह में कार्य मांगने वाले<br>व्यक्तियों के नाम</th><th style="${th}">जॉबकार्ड नं.</th></tr></thead>
      <tbody>${recRows}</tbody></table>
    <div style="font-size:11.5px;margin:6px 0 4px">निम्न व्यक्ति/समूह का महात्मा गांधी नरेगा योजनान्तर्गत रोजगार मांगने का निम्नांकित पखवाडा अवधि/दिन ${dots(110)} का आवेदन पत्र ( प्रपत्र 6 ) दिनांक ${dots(80)} को प्राप्त हुआ।</div>
    <div style="display:flex;gap:6px">${monthTbl(["अप्रेल","मई","जून"])}${monthTbl(["जुलाई","अगस्त","सितम्बर"])}${monthTbl(["अक्टूबर","नवम्बर","दिसम्बर"])}${monthTbl(["जनवरी","फरवरी","मार्च"])}</div>
    <div style="text-align:right;font-size:11.5px;margin-top:8px">हस्ताक्षर सरपंच/ग्रा. वि. अधिकारी/<br>ग्रा. रो. सहायक/क. सहायक/वार्ड पंच</div>
    <div style="text-align:right;font-size:9px;color:#555;margin-top:2px">Developed by Kurban Ali</div>
  </div>`;
}

// which: "10" = sirf Form 10, "6" = sirf Form 6, "both" = har 10 naam ka Form 10 + uske peeche Form 6
async function downloadNregaFormsPDF(which, mode){
  mode = mode || "download";
  if(!nregaSelected.size){ toast("Pehle kam se kam ek Labour select karein", "error"); return; }
  const { rows, skipped } = buildNregaFormTable();
  if(!rows.length){ toast("Selected me se koi bhi Labour Active status me nahi hai.", "error"); return; }
  if(typeof window.jspdf === "undefined" || typeof html2canvas === "undefined"){
    toast("PDF library load nahi hui — Internet check karke dobara try karein", "error"); return;
  }
  toast("PDF taiyar ho raha hai...", "info");
  const PER = 10;
  const chunks = [];
  for(let i = 0; i < rows.length; i += PER) chunks.push(rows.slice(i, i + PER));
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:-10000px;top:0;background:#fff";
  document.body.appendChild(container);
  try{
    const { jsPDF } = window.jspdf;
    let pdf = null;
    const addImg = async (html, width, orient) => {
      container.style.width = width + "px";
      container.innerHTML = html;
      await new Promise(r => setTimeout(r, 60));
      const canvas = await html2canvas(container.firstElementChild, { scale: 2, backgroundColor: "#ffffff", logging: false });
      if(!canvas || !canvas.width) throw new Error("blank canvas");
      if(!pdf) pdf = new jsPDF(orient, "mm", "a4"); else pdf.addPage("a4", orient);
      const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight(), m = 8;
      let w = pw - m * 2, hgt = canvas.height * w / canvas.width;
      if(hgt > ph - m * 2){ hgt = ph - m * 2; w = canvas.width * hgt / canvas.height; }
      pdf.addImage(canvas.toDataURL("image/png", 1.0), "PNG", (pw - w) / 2, m, w, hgt);
    };
    for(let p = 0; p < chunks.length; p++){
      const chunk = chunks[p];
      if(which === "10" || which === "both"){
        const rowsHtml = chunk.map((l, i) => `
          <tr><td>${p * PER + i + 1}</td><td></td><td>${escapeHtml(l.jobcardNo)}</td><td>${escapeHtml(l.name)}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`).join("");
        await addImg(nregaLetterHtml(rowsHtml, p === chunks.length - 1, p + 1, chunks.length), 1080, "l");
      }
      if(which === "6" || which === "both"){
        for(let k = 0; k < chunk.length; k += 5) await addImg(nregaForm6Html(chunk.slice(k, k + 5)), 760, "p");
      }
    }
    const nm = which === "6" ? "Form6" : (which === "both" ? "Form10_Form6" : "Form10");
    await finalizePdf(pdf, `NREGA_${nm}_${todayISO()}.pdf`, mode);
    if(mode !== "share") toast(skipped > 0 ? `PDF Download ho gaya (${skipped} non-Active Labour skip kiye gaye)` : "PDF Download ho gaya");
  }catch(err){
    console.error("Form PDF error:", err);
    toast("PDF banane me dikkat hui, dobara try karein", "error");
  } finally { document.body.removeChild(container); }
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

/* ===============================================================
   v44 — Entry tab sub-tabs, Password popup, Calendar (Demand dates highlight)
================================================================ */
// ---- v45: Khata ke andar Labour / Demand popup ----
function openLabourModal(n){ $("labourModalOverlay").classList.remove("hidden"); labTab(n || 1); }
function closeLabourModal(){ $("labourModalOverlay").classList.add("hidden"); renderAll(); }
function labTab(n){
  [1, 2, 3].forEach(i => {
    const p = $("labPane" + i), b = $("labTabBtn" + i);
    if(p) p.classList.toggle("hidden", i !== n);
    if(b) b.classList.toggle("active", i === n);
  });
  if(n === 3) renderLabours();
}
function editLabourFromKhata(id){ openLabourModal(1); editLabour(id); }
function openDemandModal(n){
  $("demandModalOverlay").classList.remove("hidden");
  if($("onePasteDate") && !$("onePasteDate").value) $("onePasteDate").value = todayISO();
  if($("demandDate") && !$("demandDate").value) $("demandDate").value = todayISO();
  demTab(n || 1);
}
function closeDemandModal(){ $("demandModalOverlay").classList.add("hidden"); renderAll(); }
function demTab(n){
  [1, 2].forEach(i => {
    const p = $("demPane" + i), b = $("demTabBtn" + i);
    if(p) p.classList.toggle("hidden", i !== n);
    if(b) b.classList.toggle("active", i === n);
  });
  if(n === 2) renderDemandLabourList();
}
// Saare Labour ki list file me (Excel me khulti hai): Naam, Jobcard, Aadhar, Status
function downloadLabourCSV(){
  const rows = DATA.labours.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if(!rows.length){ toast("Abhi koi Labour nahi hai", "error"); return; }
  const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const csv = "\uFEFF" + ["Sr No", "Jobcard No", "Name", "Aadhar No", "Status"].map(q).join(",") + "\r\n" +
    rows.map((l, i) => [i + 1, l.jobcardNo, l.name, l.aadhar, l.status].map(q).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "labour-list-" + todayISO() + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(rows.length + " Labour ki list download ho gayi", "success");
}

// ---- v45: Kitna Mila ----
function mateOf(p){ return round2((Number(p.amount) || 0) * 0.5); }
function setMila(paymentId, amt, quiet){
  const p = DATA.payments.find(x => x.id === paymentId);
  const d = p ? DATA.demands.find(x => x.date === p.date && x.labourId === p.labourId) : null;
  if(!p || !d){ if(!quiet) toast("Is payment ki Demand nahi mili", "error"); return false; }
  if(!isPaymentCredited(p)){ if(!quiet) toast("Pehle AC Credit karein, phir Mila likhein", "error"); return false; }
  amt = round2(amt);
  if(isNaN(amt) || amt < 0){ if(!quiet) toast("Sahi Amount daalein", "error"); return false; }
  const room = round2(mateOf(p) - getPaymentOtherPaid(p));
  if(amt > room + 0.009){ if(!quiet) toast("Itna nahi — is payment me max ₹" + Math.max(0, room).toFixed(2) + " mil sakta hai", "error"); return false; }
  d.mila = amt; d.milaDate = amt > 0 ? todayISO() : "";
  return true;
}
function setMilaFromInput(paymentId, prefix){
  const el = $((prefix || "mila-") + paymentId);
  if(!el) return;
  const ok = setMila(paymentId, el.value === "" ? 0 : parseFloat(el.value));
  if(ok){ persist(); toast("Mila save ho gaya ✅", "success"); }
  refreshPaymentViews();
}
function tickMila(paymentId){
  const p = DATA.payments.find(x => x.id === paymentId); if(!p) return;
  const room = Math.max(0, round2(mateOf(p) - getPaymentOtherPaid(p)));
  if(setMila(paymentId, room)){ persist(); toast("Poora Mila ✅ (₹" + room.toFixed(2) + ")", "success"); }
  refreshPaymentViews();
}
function bulkMilaFull(cls){
  const ids = Array.from(document.querySelectorAll("." + (cls || "ac-row-chk") + ":checked")).map(c => c.value);
  if(!ids.length){ toast("Pehle list se entry select karein", "error"); return; }
  let c = 0, skip = 0;
  ids.forEach(id => {
    const p = DATA.payments.find(x => x.id === id); if(!p) return;
    const room = Math.max(0, round2(mateOf(p) - getPaymentOtherPaid(p)));
    if(setMila(id, room, true)) c++; else skip++;
  });
  persist(); refreshPaymentViews();
  toast(c + " entry me Poora Mila ✅" + (skip ? " (" + skip + " skip — Credit nahi hui)" : ""), c ? "success" : "error");
}
function bulkMilaAmount(){
  const v = $("acBulkMila") ? $("acBulkMila").value : "";
  const amt = parseFloat(v);
  const ids = Array.from(document.querySelectorAll(".ac-row-chk:checked")).map(c => c.value);
  if(!ids.length){ toast("Pehle list se entry select karein", "error"); return; }
  if(v === "" || isNaN(amt) || amt < 0){ toast("Kitna Mila amount likhein", "error"); return; }
  let c = 0, skip = 0;
  ids.forEach(id => { if(setMila(id, amt, true)) c++; else skip++; });
  persist(); refreshPaymentViews();
  toast(c + " entry me ₹" + amt + " Mila" + (skip ? " (" + skip + " skip — Credit nahi / amount zyada)" : ""), c ? "success" : "error");
}
// Comment + Kitna Mila ek saath (chune hue rows). Jo khana khaali ho use chhua nahi jata.
function applyBulkBoth(ids, cText, aText){
  const comment = (cText || "").trim();
  const hasAmt = String(aText).trim() !== "";
  const amt = parseFloat(aText);
  if(!ids.length){ toast("Pehle table se entry select karein", "error"); return false; }
  if(!comment && !hasAmt){ toast("Comment ya Kitna Mila — kam se kam ek bharein", "error"); return false; }
  if(hasAmt && (isNaN(amt) || amt < 0)){ toast("Kitna Mila sahi amount likhein", "error"); return false; }
  let cc = 0, ca = 0, skip = 0;
  ids.forEach(id => {
    const p = DATA.payments.find(x => x.id === id); if(!p) return;
    const d = DATA.demands.find(x => x.date === p.date && x.labourId === p.labourId);
    if(comment && d){ d.comment = comment; cc++; }
    if(hasAmt){ if(setMila(id, amt, true)) ca++; else skip++; }
  });
  persist(); refreshPaymentViews();
  const msg = [];
  if(cc) msg.push(cc + " me comment");
  if(ca) msg.push(ca + " me ₹" + amt + " Mila");
  if(skip) msg.push(skip + " skip (Credit nahi / amount zyada)");
  toast(msg.join(" · ") || "Kuch nahi laga", (cc || ca) ? "success" : "error");
  return true;
}
function bulkApplyAC(){
  const ids = Array.from(document.querySelectorAll(".ac-row-chk:checked")).map(c => c.value);
  if(applyBulkBoth(ids, $("acBulkComment").value, $("acBulkMila").value)){ $("acBulkComment").value = ""; $("acBulkMila").value = ""; }
}
function bulkApplyReport(){
  const ids = Array.from(document.querySelectorAll(".rep-row-chk:checked")).map(c => c.value);
  if(applyBulkBoth(ids, $("repBulkComment").value, $("repBulkMila").value)){ $("repBulkComment").value = ""; $("repBulkMila").value = ""; }
}
function toggleRepSelectAll(on){ document.querySelectorAll(".rep-row-chk").forEach(c => c.checked = on); }
// ⏳ Credit baaki — seedha AC popup (sirf jo Credit nahi hue); labourId do to sirf us Labour ke
function openACPending(labourId){
  switchTab("dashboard");
  const l = labourId ? DATA.labours.find(x => x.id === labourId) : null;
  $("acSearch").value = l ? l.name : "";
  $("acDate").value = "";
  $("acOnlyPending").checked = true;
  acTab(1);
  renderACList();
  closeLedgerModal();
  $("acModalOverlay").classList.remove("hidden");
}

// Purane data ke liye ek baar: jin Demand par comment tha (= mila maana jata tha) unka Mila amount bhar do
function migrateV45(){
  if(DATA.migMilaV45) return;
  DATA.migMilaV45 = true;
  let n = 0;
  DATA.payments.forEach(p => {
    const d = DATA.demands.find(x => x.date === p.date && x.labourId === p.labourId);
    if(!d || d.mila !== undefined) return;
    if(d.comment && String(d.comment).trim()){
      const room = Math.max(0, round2(mateOf(p) - getPaymentOtherPaid(p)));
      d.mila = room; d.milaDate = ""; n++;
    }
  });
  persist();
}
function openPwModal(){ $("pwModalOverlay").classList.remove("hidden"); }
function closePwModal(){ $("pwModalOverlay").classList.add("hidden"); }

// ---- Calendar ----
let calState = null;
const CAL_MONTHS = ["Janvari","Farvari","March","April","May","June","July","August","September","October","November","December"];
function calDemandMap(){
  const map = {};
  DATA.demands.forEach(d => {
    const m = map[d.date] || (map[d.date] = { n: 0, cred: 0, labs: new Set() });
    m.n++; m.labs.add(d.labourId);
    const ac = DATA.acCredits.find(a => a.date === d.date && a.labourId === d.labourId);
    if(ac && ac.status === "Credited") m.cred++;
  });
  return map;
}
function openCal(el){
  const cur = el.value || todayISO();
  const [y, m] = cur.split("-").map(Number);
  calState = { el, y, m: m - 1 };
  renderCal();
  $("calOverlay").classList.remove("hidden");
}
function closeCal(){ $("calOverlay").classList.add("hidden"); calState = null; }
function calNav(d){
  calState.m += d;
  if(calState.m < 0){ calState.m = 11; calState.y--; }
  if(calState.m > 11){ calState.m = 0; calState.y++; }
  renderCal();
}
function renderCal(){
  const { el, y, m } = calState;
  const mode = el.getAttribute("data-calmode") || "all";
  const map = mode === "none" ? {} : calDemandMap();
  const sel = Array.from(typeof demandSelected !== "undefined" ? demandSelected : []);
  const useMine = mode === "labour" && sel.length > 0;
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const today = todayISO();
  let cells = ["Ra","So","Ma","Bu","Gu","Shu","Sha"].map(x => `<div class="cal-dow">${x}</div>`).join("");
  for(let i = 0; i < first; i++) cells += `<div class="cal-d empty"></div>`;
  for(let d = 1; d <= days; d++){
    const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const info = map[iso];
    let cls = "cal-d", dot = "", title = "";
    if(info){
      cls += " has" + (info.cred === info.n ? " all" : "");
      dot = info.cred === info.n ? "🟢" : (info.cred > 0 ? "🟠" : "⚪");
      title = info.n + " demand";
      if(useMine && sel.some(id => info.labs.has(id))) cls += " mine";
    }
    if(iso === today) cls += " today";
    if(iso === el.value) cls += " sel";
    cells += `<button type="button" class="${cls}" title="${title}" onclick="calPick('${iso}')">${d}${dot ? `<span class="cdot">${dot}</span>` : ""}</button>`;
  }
  const legend = mode === "none" ? "" :
    `<div class="cal-legend">🟢 Demand + sab Credit &nbsp; 🟠 Demand, kuch baaki &nbsp; ⚪ Demand, Credit nahi${useMine ? "<br>▣ Mote kinare = chune hue Labour ki Demand" : ""}</div>`;
  $("calBox").innerHTML = `
    <div class="cal-head"><button type="button" onclick="calNav(-1)">◀</button><span>${CAL_MONTHS[m]} ${y}</span><button type="button" onclick="calNav(1)">▶</button></div>
    <div class="cal-grid">${cells}</div>${legend}
    <div class="cal-foot">
      <button type="button" class="btn btn-gray btn-sm" onclick="calPick('')">✖️ Clear</button>
      <button type="button" class="btn btn-blue btn-sm" onclick="calPick('${today}')">Aaj</button>
      <button type="button" class="btn btn-gray btn-sm" onclick="closeCal()">Band</button>
    </div>`;
}
function calPick(iso){
  if(!calState) return;
  const el = calState.el;
  el.value = iso;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  closeCal();
}
function enhanceDates(){
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  [["onePasteDate","all"],["demandDate","labour"],["reportDate","all"],["acDate","all"],["acCreditDate","none"],["demandFilterDate","all"]].forEach(([id, mode]) => {
    const el = $(id);
    if(!el || el.dataset.calOn) return;
    let iso = el.value || "";
    el.type = "text"; el.readOnly = true; el.placeholder = "dd-mm-yyyy";
    el.classList.add("cal-input");
    el.setAttribute("data-calmode", mode);
    el.dataset.calOn = "1";
    Object.defineProperty(el, "value", {
      configurable: true,
      get(){ return iso; },
      set(v){ iso = v || ""; proto.set.call(el, iso ? fmtDate(iso) : ""); }
    });
    el.value = iso;
    el.addEventListener("click", () => openCal(el));
  });
}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhanceDates); else enhanceDates();
