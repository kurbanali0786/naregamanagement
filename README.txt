🆕 v40 — AC Credit ab 📒 Khata ke andar (Dashboard)
- Alag 🏦 tab hata; Dashboard ke Labour Khata me "🏦 AC Credit Dikhayein" button. Sare feature wahi: Search, Date filter, All Dates, Credited Date, Select All, Bulk AC Credit, Bulk Undo, ek-ek Credit/Undo, Credited Date badalna, Mate Status.
- Purane "AC Credit kholein" links seedha yahin kholte hain.

🆕 v39 — Khata ekdam simple (sirf Baaki Balance + Len-Den)
- Payment Credit hote hi uski entry Khata me judti hai (Baaki badhta hai). Koi "hissa / aadha / poora" nahi.
- Jis payment ke aage Comment likha hai (ya Bulk Diya se likha) uska Mila (credit) APNE-APNE ban jata hai. Jiske aage kuch nahi, uska sirf entry rehti hai.
- MILA ₹ / ADVANCE DIYA ₹ se seedhi entry. Entry par tap -> badlein/delete.
- Bulk Diya: Labour select + Comment + Save -> sabke Khata me Mila.

🆕 FINAL (v38) — Khata ab Khatabook jaisa, payment-wise
- Payment Credit hote hi uska aapka 50% hissa Labour ke Khata me "Baaki juda" (lal) me chadhta hai.
- "MILA ₹" (hara): Labour ne jo diya wo usi payment par lagta hai (aadha/poora). Zyada diya to agle baaki payment par.
- "ADVANCE DIYA ₹" (lal): pehle diya hua, agle baaki se kat jata hai.
- ⏳ icon: Sarkar ne jo payment Credit nahi kiye (Dashboard par sab Labour ke, Labour ke andar sirf usi ke). Wahin se "Credit hua ✔".
- 👥 Bulk Diya (Dashboard Khata): kai Labour select, Aadha/Poora/Fix, Comment, Save -> sabke Khata me chadh jata hai.
- Khata ki Entry par tap -> badlein / delete.
- Diya AC Credit aur Report me sirf dikhta hai; likhna sirf Khata (ya Bulk Diya) se.
- Payment Pending card hata, Khata ke upar ke Baaki cards hata, Form 6 + Form 10 PDF.

🧹 v37: Diya ab sirf Khata ki 🟢 MILE entry se (AC Credit/Report me sirf dikhta hai); Payment Pending card aur Dashboard ka duplicate Mate Share Baaki card hata diya.

🛠 v36: AC Credit / Undo karte hi Khata list turant update hoti hai (pehle refresh ke baad dikhti thi).

🆕 UPDATE 3 (v34)
- NREGA Form 6 (प्रपत्र-6): Form 10 ke chune hue Labour ke Naam + Jobcard auto-fill (5 naam per page, original jaisa); Khata ke upar ke Baaki cards hata diye (v35). Buttons: Form 10 + Form 6 (dono) / Sirf Form 10 / Sirf Form 6 / WhatsApp.

🆕 UPDATE 2 (v33)
- Khata me sirf Len-Den: "Aapko Milenge / Aap Denge" hata diya; sirf DIYE / MILE aur rakam.
- "Comment khali" wali alag list hata di (duplicate tha) — Khata me hi ⏳ Pending dikhta hai; "Sirf Pending" filter.
- Labour Profile History ab Labour Khata ke andar; har Labour ki alag PDF (Khata len-den ke saath) + sabka Khata PDF.

🆕 IS ROUND KE NAYE FEATURE
===========================
1. Dashboard me "📒 Labour Khata" (Khatabook jaisa): har labour ka balance, tap karo to ledger khulta hai.
   - Mate Share (50%) jab AC Credit hota hai to labour ke khate me "Aapko Milenge" me judta hai.
   - Labour ne jo "Diya" diya wo "Aapko Mile" (hara) me ghatta hai.
   - Neeche 🔴 Aapne Diye / 🟢 Aapko Mile se manual entry (amount, details, date).
2. AC Credit tab: Kul ₹ | Mate Share ₹ | Diya ₹ | Mate Status (✅ Mila / ⏳ Pending). Diya sirf Credited row me.
3. Comment sirf Report tab se edit hota hai (Demand List me ab sirf dikhta hai). Bulk comment pehle jaisa.
4. Payment Pending = khata view + "Khata Baaki PDF/WhatsApp". Comment khali wali list neeche.
5. Report: Diya, Baaki, Mate Status, "Sirf Pending", "Sabse Zyada Baaki Pehle", PDF/Print me bhi.
6. NREGA Form 10: Auto/Manual mode + ⭐ Priority (baaki 10-16 = 1 naam, 16 se zyada = 2 naam, 10 se kam = 1 naam + warning).
7. Cache v30 / app.js?v=32 (naya version lene ke liye hard refresh karo).

═══════════════════════════════════════════════════════════════
  Labour Job Card System — UPDATED VERSION
  Developed by Kurban Ali
═══════════════════════════════════════════════════════════════

🔧 IS ROUND KI FIXES:
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

v42: AC Credit popup (Khata se khulta hai) me ab Comment (har row ka 💾) aur Bulk Comment bhi hai — comment likhte hi Khata me Mila entry ban jaati hai. Demand List se Bulk Comment hata diya. Neeche ka "Labour Profile History" hata diya (sab features Labour Khata me hain). Entry edit/delete Labour Khata ke andar pehle jaisa.

v43: AC popup me 3 tab — AC Credit / Demand List / Demand Dates. "Diya" column hata diya. Demand Dates me har date par goli (🟢 sab Credit, 🟠 kuch baaki, ⚪ koi nahi), baaki ginti, us din ka kul ₹, date dabane par highlight aur "🏦 AC" button (us date ka AC Credit khulta hai). Past tab se Demand List / Demand Dates hata diye (popup me aa gaye).
