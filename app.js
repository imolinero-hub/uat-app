/* UAT Dashboard — app.js (CDN-friendly)
 * - No Tailwind @apply anywhere (all utilities inline in HTML)
 * - Chart.js instances reused/destroyed (no growth)
 * - Theme toggle (default light) stored in localStorage
 * Author: Ildefonso Molinero
 */

window.app = function () {
  return {
    // ---------- State ----------
    raw: {},
    filtered: {},
    platforms: [],
    filters: { platform: 'ALL' },

    kpis: { inScope: 0, executedPct: 0, passPct: 0, openDefects: 0, critical: 0 },
    countdown: { compact: '—', tooltip: 'UAT dates not configured', pctShow: false },
    health: { label: '—', dotClass: '', tooltip: '' },

    issues: [],
    infoHtml: '',
    showInfo: false,

    execChart: null,
    defectChart: null,
    lastUpdate: '',

    theme: { mode: localStorage.getItem('theme') || 'light' },

    // ---------- Lifecycle ----------
    async init () {
      this.applyTheme();
      await this.loadData();
      this.buildFilters();
      this.applyFilters();
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

      try {
        if (this.raw.infoUrl) {
          const md = await fetch(this.raw.infoUrl).then(r => r.ok ? r.text() : '');
          this.infoHtml = this.mdToHtml(md);
        }
      } catch { /* ignore */ }

      this.lastUpdate = this.raw?.overview?.lastUpdate || '';
    },

    // ---------- Filters ----------
    buildFilters () {
      const set = new Set();
      (this.raw.progressDaily || []).forEach(r => set.add(r.platform || 'ALL'));
      (this.raw.defectsDaily  || []).forEach(r => set.add(r.platform || 'ALL'));
      (this.raw.issues        || []).forEach(r => set.add(r.platform || 'ALL'));
      const arr = [...set].filter(Boolean).sort();
      if (!arr.includes('ALL')) arr.unshift('ALL');
      this.platforms = arr;
      if (!this.platforms.includes(this.filters.platform)) this.filters.platform = 'ALL';
    },

    applyFilters () {
      const p = this.filters.platform;
      const same = r => p === 'ALL' || (r.platform || 'ALL') === p;
      this.filtered.progressDaily = (this.raw.progressDaily || []).filter(same);
      this.filtered.defectsDaily  = (this.raw.defectsDaily  || []).filter(same);
      this.issues = (this.raw.issues || [])
        .filter(i => ['Blocker','Critical'].includes(i.priority))
        .filter(same);
      this.computeKPIs();
      this.computeHealth();
      this.updateCharts();
    },

    // ---------- KPIs / Health / Countdown ----------
    computeKPIs () {
      this.kpis.inScope = Number(this.raw?.overview?.inScope || 0);

      const pList = this.filtered.progressDaily?.length ? this.filtered.progressDaily : (this.raw.progressDaily || []);
      if (pList.length) {
        const last = pList[pList.length - 1];
        this.kpis.executedPct = Number(last.executedPct || 0);
        this.kpis.passPct     = Number(last.passPct || 0);
      } else {
        this.kpis.executedPct = 0; this.kpis.passPct = 0;
      }

      const dList = this.filtered.defectsDaily?.length ? this.filtered.defectsDaily : (this.raw.defectsDaily || []);
      this.kpis.openDefects = dList.length ? Number(dList[dList.length - 1].openDefects || 0) : 0;

      this.kpis.critical = this.issues.length;
    },

    computeHealth () {
      const p = this.filters.platform;
      const list = (this.raw.dailyStatus || [])
        .filter(r => p === 'ALL' || r.platform === p)
        .sort((a,b)=>a.date.localeCompare(b.date));

      let rag='G', reason='On track';
      if (list.length) { rag=(list[list.length-1].rag||'G').toUpperCase(); reason=list[list.length-1].reason||reason; }
      this.health.dotClass = (rag==='G')?'dot-G':(rag==='A')?'dot-A':'dot-R';
      this.health.label    = (rag==='G')?'On track':(rag==='A')?'At risk':'Critical';
      this.health.tooltip  = reason;
    },

    computeCountdown () {
      const s = this.raw?.schedule?.start;
      const e = this.raw?.schedule?.end;
      if (!s || !e) { this.countdown = { compact:'—', tooltip:'UAT dates not configured', pctShow:false }; return; }
      const start = new Date(s), end = new Date(e), today = new Date(); today.setHours(0,0,0,0);
      const isBiz = d => d.getDay()!==0 && d.getDay()!==6;
      const bizBetween = (a,b)=>{const step=a<b?1:-1;let n=0,d=new Date(a);while((step>0&&d<b)||(step<0&&d>b)){if(isBiz(d))n++;d.setDate(d.getDate()+step);}return n;};

      if (today < start) {
        const biz = bizBetween(today,start), cal = Math.ceil((start-today)/86400000);
        this.countdown = { compact:`Starts in ${biz} biz days`, tooltip:`${s} → ${e} · ${biz} working days (${cal} calendar days to start)`, pctShow:false };
      } else if (today > end) {
        this.countdown = { compact:'Finished', tooltip:`${s} → ${e} · done`, pctShow:false };
      } else {
        const total = bizBetween(start,end) + (isBiz(end)?1:0);
        let day=0,d=new Date(start); while(d<=today){ if(isBiz(d)) day++; d.setDate(d.getDate()+1); }
        const pct = Math.round((day/total)*100);
        this.countdown = { compact:`Day ${day} of ${total}`, tooltip:`${s} → ${e} · ${pct}% elapsed`, pctShow:true };
      }
    },

    // ---------- Charts ----------
    buildCharts () {
      const eCtx = document.getElementById('execChart').getContext('2d');
      const dCtx = document.getElementById('defectChart').getContext('2d');

      if (this.execChart) this.execChart.destroy();
      this.execChart = new Chart(eCtx, {
        type: 'line',
        data: { labels: [], datasets: [
          { label:'Executed %', data:[], borderColor:'#3b82f6', backgroundColor:'#3b82f6', fill:false, tension:0.25, borderWidth:2, pointRadius:2 },
          { label:'Pass %',     data:[], borderColor:'#8b5cf6', backgroundColor:'#8b5cf6', fill:false, tension:0.25, borderWidth:2, pointRadius:2 }
        ]},
        options: {
          parsing:false, responsive:true, maintainAspectRatio:false, animation:false,
          scales:{ y:{min:0,max:100,ticks:{callback:v=>v+'%'}}, x:{ticks:{maxRotation:0,autoSkip:true}} },
          plugins:{ legend:{display:true} }
        }
      });

      if (this.defectChart) this.defectChart.destroy();
      this.defectChart = new Chart(dCtx, {
        type: 'line',
        data: { labels: [], datasets: [
          { label:'Open defects', data:[], borderColor:'#22c55e', backgroundColor:'#22c55e', fill:false, tension:0.25, borderWidth:2, pointRadius:2 }
        ]},
        options: {
          parsing:false, responsive:true, maintainAspectRatio:false, animation:false,
          scales:{ y:{beginAtZero:true,ticks:{precision:0}}, x:{ticks:{maxRotation:0,autoSkip:true}} },
          plugins:{ legend:{display:true} }
        }
      });
    },

    computeSeries () {
      const p = this.filtered.progressDaily?.length ? this.filtered.progressDaily : (this.raw.progressDaily || []);
      const d = this.filtered.defectsDaily?.length  ? this.filtered.defectsDaily  : (this.raw.defectsDaily  || []);
      return {
        labels:  p.map(r => r.date),
        exec:    p.map(r => Number(r.executedPct || 0)),
        pass:    p.map(r => Number(r.passPct || 0)),
        dLabels: d.map(r => r.date),
        open:    d.map(r => Number(r.openDefects || 0))
      };
    },

    updateCharts () {
      if (!this.execChart || !this.defectChart) return;
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
    applyTheme(){ document.documentElement.classList.toggle('dark', this.theme.mode==='dark'); },
    toggleTheme(){ this.theme.mode = (this.theme.mode==='dark') ? 'light':'dark'; localStorage.setItem('theme', this.theme.mode); this.applyTheme(); },

    // ---------- Utils ----------
    fmtPct (n) { const v=Number(n??0); return isFinite(v)?`${v}%`:'—'; },
    mdToHtml (md='') {
      if (!md) return '';
      const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      const html = esc(md)
        .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
        .split('\n\n').map(b=>{
          if (b.startsWith('- ')) {
            const items=b.split('\n').map(l=>`<li>${l.replace(/^- /,'')}</li>`).join('');
            return `<ul class="list-disc pl-5 space-y-1">${items}</ul>`;
          }
          return `<p>${b.replace(/\n/g,'<br>')}</p>`;
        }).join('');
      return html;
    }
  };
};
