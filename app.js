/* UAT Dashboard — app.js (modular) */
/* Author: Ildefonso Molinero */

window.app = function () {
  return {
    // ---------- State ----------
    _inited: false,          // protect from double init
    raw: {},
    filtered: {},
    platforms: [],
    filters: { platform: 'ALL' },

    kpis: { inScope: 0, executedPct: 0, passPct: 0, openDefects: 0, critical: 0 },
    countdown: { compact: '—', tooltip: 'UAT dates not configured', pct: 0, pctShow: false },
    health: { label: '—', dotClass: '', tooltip: '' },

    issues: [],
    infoHtml: '',
    reportHtml: '',
    showInfo: false,
    showReport: false,

    execChart: null,
    defectChart: null,
    lastUpdate: '',

    // ---------- Lifecycle ----------
    async init () {
      if (this._inited) return;          // guard
      this._inited = true;

      await this.loadData();
      this.applyTheme();                 // if you support theme in localStorage
      this.buildFilters();
      this.computeKPIs();
      this.computeHealth();
      this.computeCountdown();
      this.buildCharts();
      this.updateCharts();
    },

    // ---------- Data ----------
    async loadData () {
      try {
        const res = await fetch('./uat.json?' + Date.now());
        this.raw = await res.json();
      } catch (e) {
        console.error('Failed to load uat.json', e);
        this.raw = {};
      }
      this.lastUpdate = this.raw?.overview?.lastUpdate || '';
      // Pre-compute info/report text if you use them
      this.infoHtml = this.raw?.aboutHtml || '';
      this.reportHtml = '';
    },

    // ---------- Filters / KPIs / Health / Countdown ----------
    buildFilters () {
      const set = new Set();
      (this.raw.progressDaily || []).forEach(r => set.add(r.platform || 'ALL'));
      (this.raw.defectsDaily || []).forEach(r => set.add(r.platform || 'ALL'));
      (this.raw.issues || []).forEach(i => set.add(i.platform || 'ALL'));
      const arr = [...set].filter(Boolean).sort();
      if (!arr.includes('ALL')) arr.unshift('ALL');
      this.platforms = arr;

      // Apply initial filter
      this.applyFilters();
    },

    applyFilters () {
      const p = this.filters.platform;
      const same = r => p === 'ALL' || (r.platform || 'ALL') === p;

      this.filtered.progressDaily = (this.raw.progressDaily || []).filter(same);
      this.filtered.defectsDaily = (this.raw.defectsDaily || []).filter(same);
      this.issues = (this.raw.issues || []).filter(i => same(i) && ['Blocker', 'Critical'].includes(i.priority))
                                            .sort((a,b)=>a.date?.localeCompare(b.date)||0);
    },

    computeKPIs () {
      const s = this.filtered.progressDaily;
      const last = s?.length ? s[s.length - 1] : {};
      this.kpis.inScope     = Number(this.raw?.overview?.inScope || 0);
      this.kpis.executedPct = Number(last.executedPct || 0);
      this.kpis.passPct     = Number(last.passPct || 0);

      const d = this.filtered.defectsDaily;
      const lastD = d?.length ? d[d.length - 1] : {};
      this.kpis.openDefects = Number(lastD.openDefects || 0);

      // issues already filtered to blocker/critical
      this.kpis.critical = this.issues.length;
    },

    computeHealth () {
      // Simple RAG based on your rules; keep your previous logic here
      const rag = (this.raw?.dailyStatus || []).slice().reverse().find(x => x.reason);
      if (!rag) { this.health = { label: 'On track', dotClass: 'bg-emerald-500', tooltip: 'On track' }; return; }
      const map = {
        'G': ['On track', 'bg-emerald-500'],
        'A': ['At risk',  'bg-amber-500'],
        'R': ['Critical', 'bg-rose-500']
      };
      const [label, dot] = map[rag.rag] || ['On track', 'bg-emerald-500'];
      this.health = { label, dotClass: dot, tooltip: rag.reason };
    },

    computeCountdown () {
      const r = this.raw?.uatDates || {};
      if (!r.start || !r.end) { this.countdown = { compact: '—', tooltip: 'UAT dates not configured', pct: 0, pctShow: false }; return; }
      const [y1, m1, d1] = r.start.split('-').map(Number);
      const [y2, m2, d2] = r.end.split('-').map(Number);
      const start = new Date(y1, m1 - 1, d1);
      const end   = new Date(y2, m2 - 1, d2);

      // business-days diff (very simple; replace with your previous function if you had one)
      const bizBetween = (a,b) => {
        let cnt = 0, d = new Date(a);
        while (d <= b) { const wd = d.getDay(); if (wd !== 0 && wd !== 6) cnt++; d.setDate(d.getDate()+1); }
        return cnt;
      };
      const today = new Date();
      const total = bizBetween(start, end);
      const done  = bizBetween(start, today < start ? start : today);
      let compact, tooltip;
      if (today < start)       { compact = `Starts in ${bizBetween(today, start)} biz days`; tooltip = `${start.toDateString()} → ${end.toDateString()}`; }
      else if (today > end)    { compact = `Finished`; tooltip = `${start.toDateString()} → ${end.toDateString()}`; }
      else                     { compact = `Day ${done} of ${total}`; tooltip = `${start.toDateString()} → ${end.toDateString()}`; }

      this.countdown = { compact, tooltip, pct: Math.round(done * 100 / Math.max(total,1)), pctShow: true };
    },

    // ---------- Charts ----------
    buildCharts () {
      const ctxExec   = document.getElementById('execChart');
      const ctxDefect = document.getElementById('defectChart');

      if (this.execChart?.destroy)   this.execChart.destroy();
      if (this.defectChart?.destroy) this.defectChart.destroy();

      // Execution chart
      this.execChart = new Chart(ctxExec, {
        type: 'line',
        data: { datasets: [
          { label: 'Executed %', data: [], tension: .25, pointRadius: 2, borderWidth: 2 },
          { label: 'Pass %',     data: [], tension: .25, pointRadius: 2, borderWidth: 2 }
        ]},
        options: { responsive: true, animation: false, maintainAspectRatio: false,
          scales: {
            x: { type: 'time', time: { unit: 'day' } },
            y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }
          },
          plugins: { legend: { display: false } }
        }
      });

      // Defects chart
      this.defectChart = new Chart(ctxDefect, {
        type: 'line',
        data: { datasets: [
          { label: 'Open defects', data: [], tension: .25, pointRadius: 2, borderWidth: 2 }
        ]},
        options: { responsive: true, animation: false, maintainAspectRatio: false,
          scales: {
            x: { type: 'time', time: { unit: 'day' } },
            y: { beginAtZero: true }
          },
          plugins: { legend: { display: false } }
        }
      });
    },

    updateCharts () {
      // Exec
      const ex = this.filtered.progressDaily || [];
      const execPts = ex.map(r => ({ x: r.date, y: Number(r.executedPct || 0) }));
      const passPts = ex.map(r => ({ x: r.date, y: Number(r.passPct || 0) }));
      this.execChart.data.datasets[0].data = execPts;
      this.execChart.data.datasets[1].data = passPts;
      this.execChart.update();

      // Defects
      const dd = this.filtered.defectsDaily || [];
      const openPts = dd.map(r => ({ x: r.date, y: Number(r.openDefects || 0) }));
      this.defectChart.data.datasets[0].data = openPts;
      this.defectChart.update();
    },

    // ---------- UI helpers ----------
    onPlatformChange () {
      this.applyFilters();
      this.computeKPIs();
      this.updateCharts();
    },

    applyTheme () {
      // if you use theme flag in localStorage, apply here; default is light mode
      document.documentElement.classList.remove('dark');
    }
  };
};

// Hook for Alpine
document.addEventListener('alpine:init', () => Alpine.data('app', window.app));
