'use strict';

/* ---------- util ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function getJSON(url, params) {
  const u = new URL(url, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== '' && v !== null && v !== undefined) u.searchParams.set(k, v);
  }
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Permintaan gagal (HTTP ${r.status})`);
  return r.json();
}

const fmtDT = (iso) =>
  iso
    ? new Date(iso).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })
    : '–';
const fmtShort = (iso) =>
  iso ? new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '–';
const fmtPct = (v) => (v === null || v === undefined ? '–' : `${Number(v).toFixed(1)}%`);
const fmtNum = (v, d = 0) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('id-ID', { maximumFractionDigits: d }));
const fmtBytes = (b) => (b == null ? '–' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

/* ---------- level -> warna ---------- */
function levelTone(level) {
  const l = String(level || '').toLowerCase();
  if (['overload', 'critical', 'danger', 'over'].includes(l)) return 'over';
  if (['warning', 'warn', 'high', 'medium', 'crowded', 'busy'].includes(l)) return 'warn';
  if (['normal', 'ok', 'low', 'safe', 'clear', 'empty'].includes(l)) return 'ok';
  return 'none';
}
const TONE_COLOR = { ok: '#2f7d5b', warn: '#c98a12', over: '#c23a22', none: '#8a96a3' };
const levelLabel = (l) => (l ? String(l).charAt(0).toUpperCase() + String(l).slice(1) : '–');
const levelChip = (l) => (l ? `<span class="chip ${levelTone(l)}">${esc(levelLabel(l))}</span>` : '<span class="muted">–</span>');

/* ---------- header + status poll ---------- */
function renderTop(active) {
  const el = document.getElementById('top');
  el.innerHTML = `
    <h1>Pantauan kepadatan CCTV</h1>
    <nav aria-label="Halaman">
      <a href="/" ${active === 'data' ? 'aria-current="page"' : ''}>Data</a>
      <a href="/trends" ${active === 'trends' ? 'aria-current="page"' : ''}>Tren</a>
    </nav>
    <div class="poll-status" aria-live="polite">
      <span class="dot" id="st-dot"></span>
      <span id="st-text">Memuat status…</span>
      <button class="btn" id="st-poll" type="button">Ambil sekarang</button>
    </div>`;

  const dot = document.getElementById('st-dot');
  const text = document.getElementById('st-text');
  const btn = document.getElementById('st-poll');

  async function refresh() {
    try {
      const s = await getJSON('/api/status');
      if (!s.lastPollAt) {
        dot.className = 'dot';
        text.textContent = s.running ? 'Mengambil data pertama…' : 'Belum ada pengambilan data';
      } else {
        dot.className = `dot ${s.lastOk ? 'ok' : 'bad'}`;
        text.textContent = s.lastOk
          ? `Terakhir diambil ${fmtShort(s.lastPollAt)}, berikutnya ${fmtShort(s.nextPollAt)}`
          : `Pengambilan ${fmtShort(s.lastPollAt)} gagal: ${s.lastMessage}`;
      }
    } catch {
      dot.className = 'dot bad';
      text.textContent = 'Server tidak merespons';
    }
  }
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Mengambil…';
    try { await fetch('/api/poll-now', { method: 'POST' }); } catch { /* status akan menunjukkan */ }
    await refresh();
    btn.disabled = false;
    btn.textContent = 'Ambil sekarang';
    document.dispatchEvent(new CustomEvent('data-updated'));
  });
  refresh();
  setInterval(refresh, 30000);
}
