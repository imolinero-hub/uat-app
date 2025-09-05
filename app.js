/* UAT Dashboard — app.js (stable baseline + heading support in Markdown)
 * Author: Ildefonso Molinero
 *
 * Keeps the previous working behavior:
 *  - Theme toggle (light/dark) with initTheme/toggleTheme + body :class binding
 *  - Countdown pill (business days)
 *  - Load uat.json + about-uat.md
 *  - KPIs and 2 charts
 *  - Info modal rendered from Markdown
 *  - AI Daily Status copy/download helpers
 * Only change: mdToHtml() now supports # / ## / ### headings
 */

window.app = function app() {
  return {
    /* ---------- State ---------- */
    // Theme
    theme: 'theme-light',
    initTheme() {
      try {
        const saved = localStorage.getItem('theme');
        const isDark = saved === 'dark';
        this.theme = isDark ? 'theme-dark' : 'theme-light';
        document.documentElement.classList.toggle('dark', isDark);
      } catch (_) {}
    },
    toggleTheme() {
      const isDark = this.theme === 'theme-light';
      this.theme = isDark ? 'theme-dark' : 'theme-light';
      try {
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
      } catch (_) {}
      document.documentElement.classList.toggle('dark', isDark);
    },

    // Data
    raw: { overview: {}, schedule: {}, progressDaily: [], defectsDaily: [], issues: [] },
    filters: { platform: 'ALL' },
    platforms: [],
    lastUpdate: '',

    // KPIs
    kpis: { inScope: 0, executedPct: 0, passPct: 0, openDefects: 0, critical: 0 },

    // Countdown pill
    countdown: { compact: '—', tooltip: 'UAT dates not configured', pct: 0, pctShow: false },

    // Modals
    showInfo: false,
    infoHtml: '',
    showReport: false,
    reportHtml: '',

    // Charts
    execChart: null,
    defectChart: null,

    /* ---------- Lifecycle ---------- */
    async init() {
      if (this.__inited) return;
      this.__inited = true;

      await this.loadData();
      this.buildFilters();
      this.applyFilters();
      this.computeCountdown();

      // Load About (Markdown → HTML)
      try {
        const md = await (await fetch('./about-uat.md?' + Date.now())).text();
        this.infoHtml = mdToHtml(md);
      } catch (e) {
        this.infoHtml = '<p>About file not available.</p>';
      }
    },

    /* ---------- Data ---------- */
    async loadData() {
      try {
        const res = await fetch('./uat.json?' + Date.now());
        this.raw = await res.json();
      } catch (e) {
        console.error('Failed to load uat.json', e);
        this.raw = { overview: {}, schedule: {}, progressDaily: [], defectsDaily: [], issues: [] };
      }
      this.lastUpdate = this.raw?.overview?.lastUpdate || '';
    },

    buildFilters() {
      const set = new Set();
      (this.raw.progressDaily || []).forEach(r => set.add(r.platform || 'ALL'));
      (this.raw.defectsDaily || []).forEach(r => set.add(r.platform || 'ALL'));
      (this.raw.issues || []).forEach(r => set.add(r.platform || 'ALL'));
      set.add('ALL');
      this.platforms = [...set].sort((a, b) => a.localeCompare(b));
      if (!this.platforms.includes(this.filters.platform)) this.filters.platform = 'ALL';
    },

    applyFilters() {
      this.computeKPIs();
      this.drawCharts();
    },

    /* ---------- KPIs ---------- */
    computeKPIs() {
      const p = this.filters.platform;
      const ov = this.raw.overview || {};

      if (p === 'ALL') {
        this.kpis.inScope = Number(ov.inScope || 0);
        this.kpis.executedPct = Number(ov.executedPct || 0);
        this.kpis.passPct = Number(ov.passPct || 0);
      } else {
        const list = (this.raw.progressDaily || [])
          .filter(r => r.platform === p)
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        const last = list[list.length - 1] || {};
        this.kpis.inScope = Number(last.inScope || 0);
        this.kpis.executedPct = Number(last.executedPct || 0);
        this.kpis.passPct = Number(last.passPct || 0);
      }

      const dList = (this.raw.defectsDaily || [])
        .filter(r => p === 'ALL' || r.platform === p)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      const lastD = dList[dList.length - 1] || {};
      this.kpis.openDefects = Number(lastD.openDefects || 0);

      const issues = (this.raw.issues || []).filter(r => p === 'ALL' || r.platform === p);
      this.kpis.critical = issues.filter(i => ['Blocker', 'Critical'].includes(i.priority)).length;
    },

    /* ---------- Countdown ---------- */
    computeCountdown() {
      const start = this.raw?.schedule?.uatStart;
      const end = this.raw?.schedule?.uatEnd;
      if (!start || !end) {
        this.countdown = { compact: '—', tooltip: 'UAT dates not configured', pct: 0, pctShow: false };
        return;
      }

      const today = new Date();
      const dStart = new Date(start);
      const dEnd = new Date(end);
      const biz = (a, b) => {
        let d = new Date(a), c = 0;
        while (d <= b) { const wd = d.getDay(); if (wd !== 0 && wd !== 6) c++; d.setDate(d.getDate() + 1); }
        return c;
      };

      if (today < dStart) {
        const days = biz(today, dStart) - 1;
        this.countdown = { compact: `Starts in ${days} biz days`, tooltip: `${start} – ${end}`, pct: 0, pctShow: false };
        return;
      }
      if (today > dEnd) {
        this.countdown = { compact: `Finished`, tooltip: `${start} – ${end}`, pct: 100, pctShow: true };
        return;
      }

      const total = biz(dStart, dEnd);
      const done = biz(dStart, today);
      const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
      this.countdown = { compact: `${done}/${total} biz days`, tooltip: `${start} – ${end}`, pct, pctShow: true };
    },

    /* ---------- Charts ---------- */
    drawCharts() {
      const p = this.filters.platform;
      const progress = (this.raw.progressDaily || [])
        .filter(r => p === 'ALL' || r.platform === p)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      const defects = (this.raw.defectsDaily || [])
        .filter(r => p === 'ALL' || r.platform === p)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      const labelsP = progress.map(r => r.date);
      const exec = progress.map(r => Number(r.executedPct || 0));
      const pass = progress.map(r => Number(r.passPct || 0));

      const labelsD = defects.map(r => r.date);
      const openDef = defects.map(r => Number(r.openDefects || 0));

      if (this.execChart) { this.execChart.destroy(); this.execChart = null; }
      if (this.defectChart) { this.defectChart.destroy(); this.defectChart = null; }

      const ctx1 = document.getElementById('execChart');
      if (ctx1) {
        this.execChart = new Chart(ctx1, {
          type: 'line',
          data: {
            labels: labelsP,
            datasets: [
              { label: 'Executed %', data: exec, tension: 0.35, borderWidth: 2, fill: false },
              { label: 'Pass %', data: pass, tension: 0.35, borderWidth: 2, fill: false }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            scales: { y: { min: 0, max: 100, ticks: { callback: v => `${v}%` } } },
            plugins: {
              legend: { position: 'bottom' },
              tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtPct(c.parsed.y)}` } }
            }
          }
        });
      }

      const ctx2 = document.getElementById('defectChart');
      if (ctx2) {
        this.defectChart = new Chart(ctx2, {
          type: 'line',
          data: {
            labels: labelsD,
            datasets: [{ label: 'Open defects', data: openDef, tension: 0.35, borderWidth: 2, fill: false }]
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            scales: { y: { beginAtZero: true } },
            plugins: { legend: { position: 'bottom' } }
          }
        });
      }
    },

    /* ---------- Report helpers ---------- */
    copyReport() {
      if (!this.reportHtml || !navigator.clipboard) return;
      const md = htmlToMd(this.reportHtml);
      navigator.clipboard.writeText(md).catch(() => {});
    },
    downloadReport() {
      if (!this.reportHtml) return;
      const md = htmlToMd(this.reportHtml);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'daily-status.md';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
    }
  };
};

/* ---------- Helpers ---------- */

// % formatter
function fmtPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)}%` : '—';
}

/** Minimal Markdown → HTML
 *  - Supports: headings (#, ##, ###), **bold**, bullet lists (- item), paragraphs, <br> for single line breaks
 *  - Escapes HTML first
 */
function mdToHtml(md) {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
     .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let s = esc(md || '');

  // headings
  s = s
    .replace(/^\s*###\s+(.+)\s*$/gm, '<h4 class="text-base font-semibold mt-4">$1</h4>')
    .replace(/^\s*##\s+(.+)\s*$/gm,  '<h3 class="text-lg  font-semibold mt-4">$1</h3>')
    .replace(/^\s*#\s+(.+)\s*$/gm,   '<h2 class="text-xl font-semibold mt-6">$1</h2>');

  // bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // list items
  s = s.replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>');
  s = s.replace(/(?:<li>.*<\/li>\s*)+/g, (m) => `<ul class="list-disc pl-6 space-y-1">${m}</ul>`);

  // wrap remaining blocks as paragraphs
  s = s.split(/\n{2,}/).map(block => {
    if (/^\s*<(h2|h3|h4|ul)/.test(block)) return block;
    const t = block.trim();
    if (!t) return '';
    return `<p class="mb-3">${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return s;
}

// Simple HTML → Markdown for copy/download
function htmlToMd(html) {
  if (!html) return '';
  return html
    .replace(/<\/?strong>/g, '**')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p>\s*<p>/g, '\n\n')
    .replace(/<\/?p>/g, '')
    .replace(/<li>/g, '- ')
    .replace(/<\/li>/g, '\n')
    .replace(/<\/?ul[^>]*>/g, '')
    .replace(/<h2[^>]*>(.*?)<\/h2>/g, '# $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/g, '## $1\n\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/g, '### $1\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------- Alpine bootstrap ---------- */
document.addEventListener('alpine:init', () => {
  Alpine.data('app', window.app); // use x-data="app()"
});
