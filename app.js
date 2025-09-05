/* UAT Dashboard — app.js (modular build)
 * Author: Ildefonso Molinero
 *
 * Responsibilities:
 * - Load uat.json and about-uat.md
 * - Keep lightweight state with Alpine.js
 * - Compute KPIs + build 2 charts with Chart.js
 * - Render the Info modal from Markdown (now supports headings)
 * - Handle simple platform filtering
 * - Provide “AI Daily Status” placeholder actions (copy / download)
 */

window.app = function app() {
  return {
    /* ---------- Reactive state ---------- */
    // raw data from uat.json
    raw: {
      overview: {},
      schedule: {},
      progressDaily: [],
      defectsDaily: [],
      issues: []
    },

    // filters / selections
    filters: { platform: 'ALL' },
    platforms: [],

    // computed values / text
    lastUpdate: '',
    kpis: { inScope: 0, executedPct: 0, passPct: 0, openDefects: 0, critical: 0 },

    // modals
    showInfo: false,
    infoHtml: '',
    showReport: false,
    reportHtml: '',

    // charts
    execChart: null,
    defectChart: null,

    /* ---------- Lifecycle ---------- */
    async init() {
      // Guard: avoid double init on SW hot-reload
      if (this.__inited) return;
      this.__inited = true;

      await this.loadData();
      this.buildFilters();
      this.applyFilters();   // sets KPIs + charts

      // Load About content (Markdown)
      try {
        const md = await (await fetch('./about-uat.md?' + Date.now())).text();
        this.infoHtml = mdToHtml(md);
      } catch (e) {
        console.warn('about-uat.md not found or blocked; fallback text');
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
      // gather unique platforms from progressDaily + defectsDaily + issues
      const set = new Set();
      (this.raw.progressDaily || []).forEach(d => set.add(d.platform || 'ALL'));
      (this.raw.defectsDaily || []).forEach(d => set.add(d.platform || 'ALL'));
      (this.raw.issues || []).forEach(d => set.add(d.platform || 'ALL'));
      set.add('ALL');
      this.platforms = [...set].sort((a, b) => a.localeCompare(b));
      if (!this.platforms.includes(this.filters.platform)) this.filters.platform = 'ALL';
    },

    applyFilters() {
      // recompute KPIs + charts for the selected platform
      this.computeKPIs();
      this.drawCharts();
    },

    /* ---------- KPIs ---------- */
    computeKPIs() {
      const p = this.filters.platform;
      const overview = this.raw.overview || {};

      // high-level numbers (use overall values if platform === ALL)
      if (p === 'ALL') {
        this.kpis.inScope = Number(overview.inScope || 0);
        this.kpis.executedPct = Number(overview.executedPct || 0);
        this.kpis.passPct = Number(overview.passPct || 0);
      } else {
        // compute by last data point for that platform in progressDaily
        const list = (this.raw.progressDaily || [])
          .filter(r => r.platform === p)
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        const last = list[list.length - 1] || {};
        this.kpis.inScope = Number(last.inScope || 0);
        this.kpis.executedPct = Number(last.executedPct || 0);
        this.kpis.passPct = Number(last.passPct || 0);
      }

      // Open defects overall or per platform (use defectsDaily last value)
      const dList = (this.raw.defectsDaily || [])
        .filter(r => p === 'ALL' || r.platform === p)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      const lastD = dList[dList.length - 1] || {};
      this.kpis.openDefects = Number(lastD.openDefects || 0);

      // Count critical/blocker from issues
      const issues = (this.raw.issues || []).filter(r => p === 'ALL' || r.platform === p);
      this.kpis.critical = issues.filter(i => ['Blocker', 'Critical'].includes(i.priority)).length;
    },

    /* ---------- Charts ---------- */
    drawCharts() {
      // Datasets
      const p = this.filters.platform;
      const progress = (this.raw.progressDaily || [])
        .filter(r => p === 'ALL' || r.platform === p)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      const defects = (this.raw.defectsDaily || [])
        .filter(r => p === 'ALL' || r.platform === p)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      // time array + values
      const labelsP = progress.map(r => r.date);
      const executed = progress.map(r => Number(r.executedPct || 0));
      const pass = progress.map(r => Number(r.passPct || 0));

      const labelsD = defects.map(r => r.date);
      const openDef = defects.map(r => Number(r.openDefects || 0));

      // Destroy if already present
      if (this.execChart) { this.execChart.destroy(); this.execChart = null; }
      if (this.defectChart) { this.defectChart.destroy(); this.defectChart = null; }

      // Execution chart
      const ctx1 = document.getElementById('execChart');
      if (ctx1) {
        this.execChart = new Chart(ctx1, {
          type: 'line',
          data: {
            labels: labelsP,
            datasets: [
              {
                label: 'Executed %',
                data: executed,
                tension: 0.35,
                borderWidth: 2,
                fill: false
              },
              {
                label: 'Pass %',
                data: pass,
                tension: 0.35,
                borderWidth: 2,
                fill: false
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
              y: {
                min: 0, max: 100, ticks: { callback: v => `${v}%` }
              }
            },
            plugins: {
              legend: { position: 'bottom' },
              tooltip: {
                callbacks: {
                  label: (ctx) => `${ctx.dataset.label}: ${fmtPct(ctx.parsed.y)}`
                }
              }
            }
          }
        });
      }

      // Defect burndown
      const ctx2 = document.getElementById('defectChart');
      if (ctx2) {
        this.defectChart = new Chart(ctx2, {
          type: 'line',
          data: {
            labels: labelsD,
            datasets: [
              {
                label: 'Open defects',
                data: openDef,
                tension: 0.35,
                borderWidth: 2,
                fill: false
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
              y: { beginAtZero: true }
            },
            plugins: {
              legend: { position: 'bottom' }
            }
          }
        });
      }
    },

    /* ---------- Actions ---------- */
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
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    }
  };
};

/* ---------- Utilities ---------- */

// % formatter
function fmtPct(v) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return `${Math.round(n)}%`;
}

// Minimal markdown → HTML (headings + bold + bullets + paragraphs)
function mdToHtml(md) {
  // escape
  const esc = s => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let s = esc(md || '');

  // headings
  s = s
    .replace(/^\s*###\s+(.+)\s*$/gm, '<h4 class="text-base font-semibold mt-4">$1</h4>')
    .replace(/^\s*##\s+(.+)\s*$/gm,  '<h3 class="text-lg  font-semibold mt-4">$1</h3>')
    .replace(/^\s*#\s+(.+)\s*$/gm,   '<h2 class="text-xl font-semibold mt-6">$1</h2>');

  // bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // simple lists: "- item"
  s = s.replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>');
  s = s.replace(/(?:<li>.*<\/li>\s*)+/g, m => `<ul class="list-disc pl-6 space-y-1">${m}</ul>`);

  // paragraphs for leftover blocks
  s = s.split(/\n{2,}/).map(block => {
    if (/^\s*<(h2|h3|h4|ul|li)/.test(block)) return block;
    if (!block.trim()) return '';
    return `<p class="mb-3">${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return s;
}

// Very small HTML → Markdown (for copy/download placeholder)
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
    .replace(/<[^>]+>/g, '')             // strip the rest
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------- Alpine bootstrap ---------- */
document.addEventListener('alpine:init', () => {
  Alpine.data('app', window.app); // allows x-data="app()"
});
