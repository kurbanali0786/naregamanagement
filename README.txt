═══════════════════════════════════════════════════════════════
  Labour Job Card System — UPDATED VERSION
  Developed by Kurban Ali
═══════════════════════════════════════════════════════════════

🆕 IS ROUND KE NAYE FEATURE (v33):
───────────────────────────────────
1. ✅ Payment Ledger (Khata) — Labour list me har naam ke saamne ab
   "📒 Khata" button hai. Isme poora hisaab dikhta hai: kis Date ko
   kitna Payment "Aaya" (Bank Credit) aur kis Date ko kitna "Diya"
   (Cash) — sab ek table me, Running Baaki ke saath. Khata se hi
   naya "Diya" entry (Date + Amount) add kar sakte hain — sabse
   purani Baaki Demand se pehle adjust hota hai (FIFO), jaisa
   normal Khata-Bahi me hota hai.

2. ✅ NREGA Form 10 — Auto/Manual Mode — Ab "🤖 Auto" aur
   "✋ Manual" do mode hain. Auto Mode me Dual-Jobcard (2 Naam
   wali Jobcard) ke saamne ek hi ➕/✖️ button hota hai — usse
   dabate hi App khud Baaki Din dekh kar tay kar leta hai ki 1
   Naam bhejna hai ya 2, aur ⭐ Priority wale Naam (jaise Wife) ko
   pehle chunta hai. ⭐ Priority kisi bhi Naam par laga sakte hain.
   Manual Mode me pehle jaisa checkbox se khud selection kar sakte
   hain.

🆕 PICHLE ROUND KE FEATURE (v32):
───────────────────────────────────
1. ✅ Baaki Payment (Partial Payment) — Payment Pending list me
   "Kitna Diya" Amount daal kar 💾 Payment Save kar sakte hain
   (v33 me isi data ko poore Khata/Ledger ke roop me bhi dekh
   sakte hain — 📒 Khata button se).

2. ✅ NREGA Form 10 — 1/2 Naam Suggestion badge (v33 me is
   suggestion ko App khud follow bhi kar sakta hai — Auto Mode
   dekhein).

🔧 PICHLE ROUND KI FIXES:
──────────────────────
1. ✅ Bulk Import (CSV / Excel / PDF) — ab file me agar Sr.No /
   Serial No. jaisa koi column hai, to woh automatically IGNORE
   ho jaata hai (header ke naam se Jobcard No., Name, Aadhar No.,
   Status column khud dhoondhta hai). App khud apna number
   lagata hai, isliye Sr.No column import me kabhi consider
   nahi hota.

2. ✅ PDF se bhi Bulk Import ab possible hai (pehle sirf CSV/Excel
   tha) — text-based PDF ki table se Name / Jobcard / Aadhar /
   Status nikal leta hai. (Scanned/image PDF is se nahi chalega.)

3. ✅ Report PDF ab PORTRAIT mode me banta hai (pehle Landscape
   tha), aur ek page me jitni entries fit ho sakti hain utni
   aati hain — auto multi-page.

4. ✅ Report tab me "Export CSV" hata kar seedha "⬇️ PDF
   Download" button laga diya gaya — ab CSV nahi, asli PDF
   file download hoti hai.

5. ✅ "Developed by Kurban Ali" — Labour List, Report, aur
   NREGA Form 10 — teeno PDF/Print ke neeche pehle se hai,
   aur app footer me bhi hamesha dikhta hai.

6. ✅ Bottom navigation tabs — sirf icon (🏠 👷 🗂️ 🏦 📊 📄),
   koi naam text nahi — icons thoda bada bhi kar diya.

7. ✅ Comment column me har row ke saamne ek 💾 Save button
   add kiya gaya (Past tab ki Demand List me, aur Report tab
   me bhi) — ab type karke seedha usi button se save kar
   sakte hain.

8. ✅ Print / PDF me agar comment khaali hai, to us jagah
   khaali hi rahega — "comment" placeholder word ab print
   nahi hoga.

📁 FILES:
─────────
• app.js               ← UPDATED (v20)
• index.html            ← UPDATED
• service-worker.js     ← UPDATED (cache v18)
• manifest.json
• icon-192.svg
• icon-512.svg

🚀 INSTALL:
───────────
1. Ye sab files apne hosting/server pe upload karein (purani
   files replace karein)
2. Browser me HARD REFRESH: Ctrl+Shift+R
3. Service Worker clear karein (agar update na dikhe):
   F12 → Application → Service Workers → Unregister
4. App kholein

═══════════════════════════════════════════════════════════════
