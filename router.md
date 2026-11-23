TYPE CARD: bot-trading.txt
HARNESS: bars-replay/v1
BUKTI:
- "Build a bot that trades it minute by minute and makes money" — halaman bounty, Description
- "Places go by net PnL on the race window, highest first" — halaman bounty, Requirements
- "Harness: agent-fun/bars-replay/v1 in a sandbox with no network" — requirements, resolution criteria
OVERLAY: tidak ada
DELIVERABLE: Repo GitHub publik, bot di main.ts (Node 22) atau main.py (Python 3.13) di root + bundle transkrip sesi yang membangunnya.
CARA DINILAI: Metrik — net PnL pada jendela balapan 24 jam setelah deadline; dev gate: hanya entry yang PnL dev-nya di atas $0 yang ikut balapan; bar baseline rumah: 4 house bot (buy-and-hold, hold-cash, momentum, ema-cross) ikut balapan tanpa hadiah; skor dev terlihat live, skor final setelah finalisasi.
DEADLINE: Buka 2026-11-23 05:11 UTC, tutup 2026-11-23 11:11 UTC / 18:11 WIB; sisa 4 jam 28 mnt dari 2026-11-23 06:43 UTC.
JALUR CEPAT: tidak (rentang 6 jam).
TIE-BREAK: tidak. T1 terpenuhi (penilai grader/metrik: "make.fun grader executes every entry twice"). T3 terpenuhi ("Exactly equal net PnL goes to the entry with fewer trades, then the earlier receipt"). T2 GAGAL: net PnL kontinu dalam USDC — nilai terbaik bukan plafon diskrit yang bisa dicapai banyak peserta sekaligus (bukan semua-kasus-selesai atau semua-uji-lulus); seri persis hampir mustahil. Karena satu syarat gagal, BUKAN TIE-BREAK — dikerjakan jalur normal.
KUOTA: 20 per hari, 40 total per akun (requirements: max_per_day 20, max_entries_per_account 40); kuota akun Data Unavailable (butuh key).
ENTRY YANG DIHITUNG: submission terakhir sebelum deadline yang dihitung.
MODE TRANSKRIP: unggah (bundle transkrip diunggah tiap submission; requirements tidak memuat check recording — rekaman tersegel tidak disyaratkan).
PERINGATAN: Dev gate wajib lolos (PnL dev > $0 setelah semua biaya) agar ikut balapan; minimum bar: minimal 1 trade dan maximum drawdown ≤25%, bila tidak peringkat di bawah semua yang memenuhi; deterministik — dua eksekusi pada data sama harus menghasilkan log aksi yang sama byte per byte; tanpa jaringan, tanpa wall clock, tanpa file di luar repo; biaya 4 bps + slippage 2 bps + price impact per order; MULAI TERAKHIR 06:41 UTC sudah lewat ~2 mnt saat ditemukan — V1 mulai segera; hadiah $50 total, 10 tempat dibayar ($12/$8/$6/$5/$4/$3×5).
LANGKAH BERIKUT: Tempel PACK_DIR/CORE.txt plus PACK_DIR/type-card/bot-trading.txt sebagai pesan pertama sesi baru.
