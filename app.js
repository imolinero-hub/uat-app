/* UAT Dashboard — app.js
 * Single-file Alpine component (global factory) + Chart.js integration.
 * Fixes chart growth (reuse/destroy), adds reliable theme toggle (default light).
 * Author: Ildefonso Molinero
 */

window.app = function () {
  return {
    // ---------- State ----------
    raw: {},                      // full JSON from uat.json
    filtered: {},                 // filtered per platform
    platforms: [],                // ['ALL','Web','App','BOSS',...]
    filters: { platform: 'ALL' },

    kpis: { inScope: 0, executedPct: 0, passPct: 0, openDefects: 0, critical: 0 },
    countdown: { compact: '—', tooltip: 'UAT dates not configured', pct: 0, pctShow: false },
    health: { label: '—', dotClass: '', tooltip: '' },

    issues: [],
    infoHtml: '',
    showInfo: false,

    execChart: null,
    defectChart: null,
    lastUpdate: '',

    // Theme (default light)
    theme: { mode: localStorage.getItem('theme') || 'light' },

    // ---------- Lifecycle ----------
    async init () {
      // apply theme first
      this.applyTheme();

      // load data
      await this.loadData();

      // derive filters, KPIs, health & countdown
      this.buildFilters();
      this.applyFilters();
      this.computeKPIs();
      this.computeHealth();
      this.computeCountdown();

      // charts
      this.buildCharts();
      this.updateCharts();
    },

    // ---------- Data loading ----------
    async loadData () {
      try {
        const res = await fetch('./uat.json?' + Date.now());
        this.raw = await res.json();
      } catch (e) {
        console.error('Failed to load uat.json', e);
        this.raw = {};
      }

      // optional info markdown
      try {
        if (this.raw.infoUrl) {
          const md = await fetch(this.raw.infoUrl).then(r => r.ok ? r.text() : '');
          this.infoHtml = this.mdToHtml(md);
        }
      } catch {
        /* ignore */
      }

      this.lastUpdate = this.raw?.overview?.lastUpdate || '';
    },

    // ---------- Filters ----------
    buildFilters () {
      const pset = new Set();

      (this.raw.progressDaily || []).forEach(r => pset.add(r.platform || 'ALL'));
      (this.raw.defectsDaily || []).forEach(r => pset.add(r.platform || 'ALL'));
      (this.raw.issues || []).forEach(i => pset.add(i.platform || 'ALL'));

      const list = [...pset].filter(Boolean).sort();
      if (!list.includes('ALL')) list.unshift('ALL');
      this.platforms = list;
      if (!this.platforms.includes(this.filters.platform)) {
        this.filters.platform = 'ALL';
      }
    },

    applyFilters () {
      const p = this.filters.platform;
      const same = r => p === 'ALL' || (r.platform || 'ALL') === p;

      this.filtered.progressDaily = (this.raw.progressDaily || []).filter(same);
      this.filtered.defectsDaily  = (this.raw.defectsDaily  || []).filter(same);
      // Issues: only blocker/critical; show all matching platform
      this.issues = (this.raw.issues || [])
        .filter(i => ['Blocker', 'Critical'].includes(i.priority))
        .filter(same);
    },

    // ---------- KPIs / Health / Countdown ----------
    computeKPIs () {
      // in-scope
      this.kpis.inScope = Number(this.raw?.overview?.inScope || 0);

      // latest execution/pass
      const pList = this.filtered.progressDaily?.length
        ? this.filtered.progressDaily
        : (this.raw.progressDaily || []);
      if (pList.length) {
        const last = pList[pList.length - 1];
        this.kpis.executedPct = Number(last.executedPct || 0);
        this.kpis.passPct     = Number(last.passPct || 0);
      } else {
        this.kpis.executedPct = 0;
        this.kpis.passPct = 0;
      }

      // latest open defects
      const dList = this.filtered.defectsDaily?.length
        ? this.filtered.defectsDaily
        : (this.raw.defectsDaily || []);
      this.kpis.openDefects = dList.length
        ? Number(dList[dList.length - 1].openDefects || 0)
        : 0;

      // critical count
      this.kpis.critical = this.issues.length;
    },

    computeHealth () {
      // manual RAG overrides in raw.dailyStatus
      const p = this.filters.platform;
      const list = (this.raw.dailyStatus || [])
        .filter(r => p === 'ALL' || r.platform === p)
        .sort((a, b) => a.date.localeCompare(b.date));

      let rag = 'G', reason = 'On track';
      if (list.length) {
        const last = list[list.length - 1];
        rag = (last.rag || 'G').toUpperCase();
        reason = last.reason || reason;
      }
      this.health.label = (rag === 'G') ? 'On track'
                         : (rag === 'A') ? 'At risk'
                         : 'Critical';
      this.health.dotClass = (rag === 'G') ? 'dot-G' : (rag === 'A') ? 'dot-A' : 'dot-R';
      this.health.tooltip = reason;
    },

    computeCountdown () {
      const s = this.raw?.schedule?.start;
      const e = this.raw?.schedule?.end;
      if (!s || !e) { this.countdown = { compact: '—', tooltip: 'UAT dates not configured' }; return; }

      const start = new Date(s);
      const end   = new Date(e);
      const today = new Date();
      today.setHours(0,0,0,0);

      const isBiz = d => d.getDay() !== 0 && d.getDay() !== 6;

      const bizDaysBetween = (a, b) => {
        const step = a < b ? 1 : -1;
        let d = new Date(a), n = 0;
        while ( (step > 0 && d < b) || (step < 0 && d > b) ) {
          if (isBiz(d)) n++;
          d.setDate(d.getDate() + step);
        }
        return n;
      };

      if (today < start) {
        const bizToStart = bizDaysBetween(today, start);
        const calToStart = Math.ceil((start - today) / 86400000);
        this.countdown.compact = `Starts in ${bizToStart} biz days`;
        this.countdown.tooltip = `${s} → ${e} · ${bizToStart} working days (${calToStart} calendar days to start)`;
        this.countdown.pctShow = false;
      } else if (today > end) {
        this.countdown.compact = 'Finished';
        this.countdown.tooltip = `${s} → ${e} · done`;
        this.countdown.pctShow = false;
      } else {
        // within UAT: Day X of N (business days)
        const totalBiz = bizDaysBetween(start, end) + (isBiz(end) ? 1 : 0);
        let day = 0;
        let d = new Date(start);
        while (d <= today) {
          if (isBiz(d)) day++;
          d.setDate(d.getDate() + 1);
        }
        const pct = Math.round((day / totalBiz) * 100);
        this.countdown.compact = `Day ${day} of ${totalBiz}`;
        this.countdown.tooltip = `${s} → ${e} · ${pct}% elapsed`;
        this.countdown.pct = pct;
        this.countdown.pctShow = true;
      }
    },

    // ---------- Charts ----------
    buildCharts () {
      const eCtx = document.getElementById('execChart').getContext('2d');
      const dCtx = document.getElementById('defectChart').getContext('2d');

      if (this.execChart) this.execChart.destroy();
      this.execChart = new Chart(eCtx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            { label: 'Executed %', data: [], borderColor: '#3b82f6', backgroundColor: '#3b82f6', borderWidth: 2, tension: 0.25, pointRadius: 2 },
            { label: 'Pass %',     data: [], borderColor: '#8b5cf6', backgroundColor: '#8b5cf6', borderWidth: 2, tension: 0.25, pointRadius: 2 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          scales: {
            y: { min: 0, max: 100, ticks: { callback: v => v + '%' } },
            x: { ticks: { maxRotation: 0, autoSkip: true } }
          },
          plugins: { legend: { display: true } }
        }
      });

      if (this.defectChart) this.defectChart.destroy();
      this.defectChart = new Chart(dCtx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            { label: 'Open defects', data: [], borderColor: '#22c55e', backgroundColor: '#22c55e', borderWidth: 2, tension: 0.25, pointRadius: 2 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          scales: {
            y: { beginAtZero: true, ticks: { precision: 0 } },
            x: { ticks: { maxRotation: 0, autoSkip: true } }
          },
          plugins: { legend: { display: true } }
        }
      });
    },

    computeSeries () {
      const pSrc = (this.filtered.progressDaily?.length ? this.filtered.progressDaily : this.raw.progressDaily) || [];
      const dSrc = (this.filtered.defectsDaily?.length ? this.filtered.defectsDaily : this.raw.defectsDaily) || [];

      return {
        labels:  pSrc.map(r => r.date),
        exec:    pSrc.map(r => Number(r.executedPct || 0)),
        pass:    pSrc.map(r => Number(r.passPct || 0)),
        dLabels: dSrc.map(r => r.date),
        open:    dSrc.map(r => Number(r.openDefects || 0))
      };
    },

    updateCharts () {
      if (!this.execChart || !this.defectChart) this.buildCharts();

      const { labels, exec, pass, dLabels, open } = this.computeSeries();

      this.execChart.data.labels = labels;
      this.execChart.data.datasets[0].data = exec;
      this.execChart.data.datasets[1].data = pass;
      this.execChart.update('none');

      this.defectChart.data.labels = dLabels;
      this.defectChart.data.datasets[0].data = open;
      this.defectChart.update('none');
    },

    // ---------- Theme ----------
    applyTheme () {
      document.documentElement.classList.toggle('dark', this.theme.mode === 'dark');
    },
    toggleTheme () {
      this.theme.mode = (this.theme.mode === 'dark') ? 'light' : 'dark';
      localStorage.setItem('theme', this.theme.mode);
      this.applyTheme();
    },

    // ---------- Utils ----------
    fmtPct (n) { const v = Number(n ?? 0); return isFinite(v) ? `${v}%` : '—'; },

    // tiny safe Markdown→HTML (bold + bullets)
    mdToHtml (md = '') {
      if (!md) return '';
      const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      const html = esc(md)
        .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
        .split('\n\n').map(block=>{
          if (block.startsWith('- ')) {
            const items = block.split('\n').map(l=>l.replace(/^- /,'<li>$&').replace(/^<li>- /,'<li>'));
            return `<ul class="list-disc pl-5 space-y-1">${items.join('</li>')}</li></ul>`;
          }
          return `<p>${block.replace(/\n/g,'<br>')}</p>`;
        }).join('');
      return html;
    }
  };
};
