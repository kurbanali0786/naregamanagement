═══════════════════════════════════════════════════════════════
  Labour Job Card System — UPDATED VERSION
  Developed by Kurban Ali
═══════════════════════════════════════════════════════════════

🆕 IS ROUND KE NAYE FEATURE (v32):
───────────────────────────────────
1. ✅ Baaki Payment (Partial Payment) — Payment Pending list me ab
   "Kitna Diya" Amount daal kar 💾 Payment Save kar sakte hain.
   Agar poora paisa ek saath nahi diya (jaise aadha abhi, aadha
   agle hafte), to Baaki Amount apne aap dikhta rahega aur jab
   tak Poora Payment na ho jaaye, entry list se hategi nahi.
   (Purana tareeka — sirf Comment likh kar list se hataana —
   waisa hi chalu hai, kuch nahi tuta.)

2. ✅ NREGA Form 10 — 1 ya 2 Naam Suggestion — Dual-Jobcard
   (Pati-Patni jaisi 2 naam wali Jobcard) list me ab
   💡 "1 Naam Kaafi" ya 💡 "2 Naam Ban Sakte Hain" badge dikhta
   hai — Jobcard ke Baaki Din (125 me se) ke hisaab se: 10-16
   Baaki = 1 Naam, 16+ Baaki = 2 Naam. Form 10 Preview table ke
   last column ("कुल दिवस") me Din khud-ba-khud bhar jaate hain
   (2 Naam ho to aadha-aadha baant kar) — chahe to hath se bhi
   badal sakte hain, PDF me wahi final value jaayegi.

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
