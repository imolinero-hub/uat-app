/* =====================================================================
   UAT Dashboard – app.js (cleaned & organized)
   Sections:
     1) BizCal (calendar helpers)
     2) Alpine component: state & lifecycle
     3) Theme helpers
     4) KPI planned/actual helpers & calculations
     5) Charts
     6) Countdown widget
     7) Info modal
     8) Scroll lock helpers
     9) Daily Status modal (with RAG injection & fallback)
    10) Markdown helpers (single, deduplicated mdToHtml) + utilities
    11) Alpine registration
   ===================================================================== */


/* =====================================================
 * 1) BizCal (unchanged)
 * ===================================================== */
function BizCal(schedule){
  const tz = schedule.timezone || 'Europe/Berlin';
  const holidays = new Set(Array.isArray(schedule.holidays) ? schedule.holidays : []);

  const toTZDate = (dStr) => {
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'})
      .formatToParts(new Date(dStr+'T00:00:00'));
    const y = +parts.find(p=>p.type==='year').value;
    const m = +parts.find(p=>p.type==='month').value;
    const d = +parts.find(p=>p.type==='day').value;
    return new Date(Date.UTC(y,m-1,d,0,0,0));
  };
  const todayTZ = () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
    const y = +parts.find(p=>p.type==='year').value;
    const m = +parts.find(p=>p.type==='month').value;
    const d = +parts.find(p=>p.type==='day').value;
    return new Date(Date.UTC(y,m-1,d,0,0,0));
  };
  const fmtDay = (d) => new Intl.DateTimeFormat(undefined,{timeZone:tz,month:'short',day:'2-digit'}).format(d);
  const isWeekend = (d) => { const wd = d.getUTCDay(); return wd===0 || wd===6; };
  const isHoliday = (d) => holidays.has(d.toISOString().slice(0,10));
  const isBusiness = (d) => !isWeekend(d) && !isHoliday(d);

  const start = schedule.start ? toTZDate(schedule.start) : null;
  const end   = schedule.end   ? toTZDate(schedule.end)   : null;

  const businessDays = () => {
    const out = [];
    if(!start || !end) return out;
    for(let d = new Date(start); d <= end; d = new Date(d.getTime()+86400000)){
      if(isBusiness(d)) out.push(new Date(d));
    }
    return out;
  };

  const indexFor = (d) => businessDays().filter(x => x <= d).length;
  const nextBusinessAfter = (d) => {
    let n = new Date(d.getTime()+86400000);
    while(!isBusiness(n)) n = new Date(n.getTime()+86400000);
    return n;
  };

  return { businessDays, isBusiness, indexFor, nextBusinessAfter, formatDay:fmtDay, todayTZ, start, end, tz };
}


/* =====================================================
 * 2) Alpine component: state & lifecycle
 * ===================================================== */
function app(){
  return {
    // ------------- raw data & derived model -------------
    raw:{ overview:{}, progressDaily:[], defectsDaily:[], issues:[], keyDates:[], schedule:{}, plannedSeries:{}, plan:{} },
    kpis:{ inScope:0, executedPct:0, passPct:0, openDefects:0, critical:0 },
    planned:{ exec:0, pass:0 },
    deltas:{ exec:0, pass:0 },
    asOf:'', issues:[],

    // charts
    execChart:null, defectChart:null,

    // UI state
    theme:'theme-dark',
    countdown:{ title:'UAT Days', label:'—', pct:0, pctShow:false, subtitle:'' },

    // Info modal
    infoOpen:false, infoHtml:'',

    // Daily Status modal
    dailyOpen:false, dailyHtml:'',

    // ---------------- lifecycle ----------------
    async init(){
      try{
        const res = await fetch('./uat.json?v=' + Date.now(), { cache:'no-store' });
        if(res.ok){ this.raw = await res.json(); }
        else throw new Error('Failed to fetch uat.json');
      }catch(e){
        console.error('Failed to fetch uat.json', e);
        document.body.insertAdjacentHTML('beforeend','<div class="toast">uat.json could not be loaded</div>');
        return;
      }

      this.asOf   = this.raw.asOf || this.raw.overview?.lastUpdate || '';
      this.issues = this.raw.issues || [];

      this.computeKpis();
      this.computePlannedToday();
      this.drawCharts();
      this.computeCountdown();
    },

    /* =====================================================
     * 3) Theme helpers
     * ===================================================== */
    initTheme(){
      const saved = localStorage.getItem('uat-theme');
      this.theme = saved || 'theme-dark';
      document.documentElement.classList.toggle('theme-light', this.theme==='theme-light');
    },
    toggleTheme(){
      this.theme = (this.theme==='theme-light') ? 'theme-dark' : 'theme-light';
      document.documentElement.classList.toggle('theme-light', this.theme==='theme-light');
      localStorage.setItem('uat-theme', this.theme);
    },

    /* =====================================================
     * 4) KPI planned/actual helpers & calculations
     * ===================================================== */

    // Small helpers for RAG label/emoji (used in Daily Status too)
    healthEmoji(status){
      return status==='green' ? '🟢'
           : status==='amber' ? '🟠'
           : status==='red'   ? '🔴'
           : '🟢';
    },
    healthLabelClass(status){
      return status==='green' ? 'rag-green'
           : status==='amber' ? 'rag-amber'
           : 'rag-red';
    },
    healthText(statusClass){
      if(statusClass==='rag-green') return 'On Track';
      if(statusClass==='rag-amber') return 'At Risk';
      return 'Off Track';
    },

    // Auto health rules (tweak thresholds as needed)
    autoHealthClass(){
      const k = this.kpis;
      const execOK = (k.executedPct >= (k.plannedExecutedPct||0));
      const passOK = (k.passPct     >= (k.plannedPassPct||0));
      const nearOK = (k.executedPct >= (k.plannedExecutedPct||0) - 5) &&
                     (k.passPct     >= (k.plannedPassPct||0)     - 5);
      const blockers = k.critical||0;

      if (execOK && passOK && blockers <= 2) return 'rag-green';
      if (nearOK && blockers <= 5)           return 'rag-amber';
      return 'rag-red';
    },

    // Header badge model
    get healthBadge(){
      const h = this.raw.health || { status:'auto' };
      let klass = 'rag-green', label = 'On Track', tooltip = '';

      if (h.status && h.status !== 'auto') {
        // manual override from JSON
        klass = this.healthLabelClass(h.status);
        label = this.healthText(klass);
        const when = (this.asOf ? ` • ${this.asOf}` : '');
        tooltip = `Set manually${when}${h.comment ? ' • '+h.comment : ''}`;
      } else {
        // automatic
        klass = this.autoHealthClass();
        label = this.healthText(klass);
        const k = this.kpis;
        tooltip = (klass==='rag-green')
          ? 'Exec & Pass ≥ plan; Blockers ≤ 2'
          : (klass==='rag-amber')
            ? 'Within 5pp of plan or Blockers ≤ 5'
            : 'Lagging plan or higher blocker count';
      }
      return { class: klass, label, tooltip };
    },

    // Planned targets (used for KPI deltas & chart planned lines)
    plannedExecutedPct(dayIndex){
      const execDays = this.raw.plan?.exec_days ?? 10;
      if (dayIndex <= 0) return 0;
      if (dayIndex >= execDays) return 100;
      return Math.round((dayIndex / execDays) * 100);
    },
    plannedPassPct(dayIndex){
      const passDays = this.raw.plan?.pass_days ?? 15;
      const passTarget = (this.raw.plan?.pass_target ?? 95) / 100;
      if (dayIndex <= 0) return 0;
      const capped = Math.min(dayIndex, passDays);
      const pct = (capped * (passTarget / passDays)) * 100;
      return Math.round(Math.min(pct, 95));
    },
    kpiColorPlan(actual, planned){
      const diff = (actual||0) - (planned||0);
      if (diff >= 0) return 'text-emerald-400';
      if (diff >= -5) return 'text-amber-300';
      return 'text-rose-400';
    },

    computePlannedToday(){
      // Determine working-day index using BizCal or fallback to progress length
      const cal = BizCal(this.raw.schedule||{});
      const today = cal.todayTZ();
      let idx = 1;
      if (cal.start && cal.end){
        if (today < cal.start) idx = 1;
        else if (today > cal.end) idx = cal.businessDays().length;
        else idx = cal.indexFor(today);
      } else {
        const p = this.raw.progressDaily || [];
        idx = p.length ? p.length : 1;
      }

      // planned values
      if (this.raw.plannedSeries?.planned_executed_pct?.length){
        const i = Math.min(idx, this.raw.plannedSeries.planned_executed_pct.length) - 1;
        this.planned.exec = Number(this.raw.plannedSeries.planned_executed_pct[i]) || this.plannedExecutedPct(idx);
      } else {
        this.planned.exec = this.plannedExecutedPct(idx);
      }
      if (this.raw.plannedSeries?.planned_pass_pct?.length){
        const i = Math.min(idx, this.raw.plannedSeries.planned_pass_pct.length) - 1;
        this.planned.pass = Number(this.raw.plannedSeries.planned_pass_pct[i]) || this.plannedPassPct(idx);
      } else {
        this.planned.pass = this.plannedPassPct(idx);
      }

      // actuals
      const p = this.raw.progressDaily || [];
      const actualExec = p.length ? (Number(p[p.length-1].executedPct)||0) : 0;
      const actualPass = p.length ? (Number(p[p.length-1].passPct)||0) : 0;
      const plannedExec = Number(this.planned.exec)||0;
      const plannedPass = Number(this.planned.pass)||0;

      this.deltas.exec = Math.round(actualExec - plannedExec);
      this.deltas.pass = Math.round(actualPass - plannedPass);

      // expose to kpis for bindings
      this.kpis.plannedExecutedPct = plannedExec;
      this.kpis.plannedPassPct     = plannedPass;
      this.kpis.execDelta          = this.deltas.exec;
      this.kpis.passDelta          = this.deltas.pass;
      this.kpis.execColorClass     = this.kpiColorPlan(actualExec, plannedExec);
      this.kpis.passColorClass     = this.kpiColorPlan(actualPass, plannedPass);
    },

    computeKpis(){
      // Progress KPIs (from latest progressDaily entry)
      const p = this.raw.progressDaily || [];
      if (p.length) {
        const last = p[p.length - 1];
        this.kpis.inScope     = Number(last.inScope ?? this.raw.overview?.inScope ?? 0);
        this.kpis.executedPct = Number(last.executedPct ?? 0);
        this.kpis.passPct     = Number(last.passPct ?? 0);
      } else {
        this.kpis.inScope     = Number(this.raw.overview?.inScope ?? 0);
        this.kpis.executedPct = 0;
        this.kpis.passPct     = 0;
      }

      // Defects KPIs: take latest point; fallback to 0
      const dd = this.raw.defectsDaily || [];
      this.kpis.openDefects = dd.length
        ? Number(dd[dd.length - 1].openDefects ?? 0)
        : 0;

      // Blocker/Critical is simply the number of open issues in JSON
      this.kpis.critical = (this.raw.issues || []).length;

      // Ensure planned values are numbers to avoid NaN in deltas
      this.kpis.plannedExecutedPct = Number(this.kpis.plannedExecutedPct || 0);
      this.kpis.plannedPassPct     = Number(this.kpis.plannedPassPct || 0);
    },

    /* =====================================================
     * 5) Charts
     * ===================================================== */
    drawCharts(){
      if(!window.Chart){ console.error('Chart.js not loaded'); return; }

      const common = {
        responsive:true, maintainAspectRatio:false, animation:false,
        elements: { line: { borderWidth: 2 }, point: { radius: 3, hitRadius: 6, hoverRadius: 4 } },
        plugins:{ legend:{ position:'bottom', labels:{ color:'#94a3b8', usePointStyle:true } } }
      };

      // ----- Execution Over Time -----
      const pd = this.raw.progressDaily || [];
      let labels = pd.map(r => r.date);
      const exec = pd.map(r => +r.executedPct || 0);
      const pass = pd.map(r => +r.passPct || 0);

      // If there are no actual labels (pre-start), synthesize labels so planned lines still render
      if (!labels.length) {
        const cal = BizCal(this.raw.schedule || {});
        const biz = (cal.start && cal.end) ? cal.businessDays() : [];
        if (biz.length) {
          labels = biz.map(d => new Date(d).toISOString().slice(0,10));
        } else {
          const N = Math.max(
            this.raw.plannedSeries?.planned_executed_pct?.length || 0,
            this.raw.plannedSeries?.planned_pass_pct?.length || 0,
            19
          );
          const t0 = new Date();
          labels = Array.from({length:N}, (_,i)=> new Date(t0.getTime()+i*86400000).toISOString().slice(0,10));
        }
      }

      // Planned series aligned to labels length
      const n = labels.length;
      const plannedExec = Array.from({length:n}, (_,i)=>{
        const day = i+1;
        if (this.raw.plannedSeries?.planned_executed_pct?.length >= day) {
          return this.raw.plannedSeries.planned_executed_pct[day-1];
        }
        return this.plannedExecutedPct(day);
      });
      const plannedPass = Array.from({length:n}, (_,i)=>{
        const day = i+1;
        if (this.raw.plannedSeries?.planned_pass_pct?.length >= day) {
          return this.raw.plannedSeries.planned_pass_pct[day-1];
        }
        return this.plannedPassPct(day);
      });

      if (this.execChart) this.execChart.destroy();
      this.execChart = new Chart(document.getElementById('execChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label:'Executed %', data:exec, borderColor:'#60a5fa', backgroundColor:'#60a5fa', tension:.25, spanGaps:true },
            { label:'Pass %',     data:pass, borderColor:'#a78bfa', backgroundColor:'#a78bfa', tension:.25, spanGaps:true },
            // Planned (dotted)
            { label:'Executed % (Planned)', data:plannedExec, borderColor:'#64748b', borderDash:[8,6], tension:.25, spanGaps:true, pointRadius:0, pointStyle:'line' },
            { label:'Pass % (Planned)',     data:plannedPass, borderColor:'#cbd5e1', borderDash:[2,6], tension:.25, spanGaps:true, pointRadius:0, pointStyle:'line' }
          ]
        },
        options: {
          ...common,
          scales: {
            x: {
              type: 'time',
              time: { unit:'day', displayFormats:{ day:'MMM dd' }, tooltipFormat:'MMM dd, yyyy' },
              grid: { color:'rgba(148,163,184,.2)' }
            },
            y: {
              beginAtZero:true, max:100,
              ticks:{ callback:v=>v+'%' },
              grid:{ color:'rgba(148,163,184,.2)' }
            }
          },
          plugins: {
            ...(common.plugins || {}),
            tooltip: {
              callbacks: {
                title: (ctx) => {
                  const d = ctx[0].parsed.x;
                  return new Date(d).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
                }
              }
            }
          }
        }
      });

      // ----- Defect Burndown -----
      const dd = this.raw.defectsDaily || [];
      const labelsD = dd.map(r => r.date);
      const dataDef = dd.map(r => Number(r.openDefects ?? 0));
      const labelsD2 = labelsD.length ? labelsD : [this.asOf || ''];
      const dataDef2 = dataDef.length ? dataDef : [0];

      if (this.defectChart) this.defectChart.destroy();
      this.defectChart = new Chart(document.getElementById('defectChart'), {
        type:'line',
        data:{
          labels: labelsD2,
          datasets:[
            { label:'Open defects', data:dataDef2, borderColor:'#34d399', backgroundColor:'#34d399', tension:.25, spanGaps:true }
          ]
        },
        options:{
          ...common,
          scales:{
            x:{ type:'time', time:{ unit:'day', displayFormats:{ day:'MMM dd' }, tooltipFormat:'MMM dd, yyyy' }, grid:{ color:'rgba(148,163,184,.2)'} },
            y:{ beginAtZero:true, grid:{ color:'rgba(148,163,184,.2)'} }
          }
        }
      });
    },

    /* =====================================================
     * 6) Countdown widget
     * ===================================================== */
    computeCountdown(){
      const sch = this.raw.schedule || {};
      const cal = BizCal(sch);
      const { start, end } = cal;

      if(!start || !end){
        this.countdown = { title:'UAT Days', label:'—', compact:'—', tooltip:'UAT dates not configured', pct:0, pctShow:false, subtitle:'(dates missing)' };
        return;
      }
      const bizDays = cal.businessDays();
      const total   = bizDays.length;
      const today   = cal.todayTZ();

      if (today < start){
        let firstRun = new Date(start);
        while(!cal.isBusiness(firstRun)) firstRun = new Date(firstRun.getTime() + 86400000);
        let daysUntil = 0;
        for (let d = new Date(today.getTime()+86400000); d <= firstRun; d = new Date(d.getTime()+86400000)){
          if (cal.isBusiness(d)) daysUntil++;
        }
        const calDays = Math.ceil((firstRun - today) / 86400000);
        this.countdown = {
          title: 'UAT Days',
          label: `Starts in ${daysUntil} business day${daysUntil===1?'':'s'}`,
          compact: `Starts in ${daysUntil} biz day${daysUntil===1?'':'s'}`,
          tooltip: `${cal.formatDay(start)} – ${cal.formatDay(end)} · ${total} working days\n${calDays} calendar days to start`,
          pct: 0, pctShow:false,
          subtitle: `${cal.formatDay(start)} – ${cal.formatDay(end)} · ${total} working days (${calDays} calendar days to start)`
        };
        return;
      }
      if (today > end){
        this.countdown = {
          title:'UAT Days', label:'Completed', compact:'Completed',
          tooltip:`Ran ${cal.formatDay(start)} – ${cal.formatDay(end)} · ${total} working days`,
          pct:100, pctShow:true, subtitle:`${total}/${total} working days · Ran ${cal.formatDay(start)} – ${cal.formatDay(end)}`
        };
        return;
      }
      if (!cal.isBusiness(today)){
        const lastBizIndex = cal.indexFor(new Date(today.getTime() - 86400000));
        const next = cal.nextBusinessAfter(today);
        const pct = Math.max(0, Math.min(100, (lastBizIndex / total) * 100));
        this.countdown = {
          title:'UAT Days',
          label:`Paused · resumes ${cal.formatDay(next)}`,
          compact:`Paused · resumes ${cal.formatDay(next)}`,
          tooltip:`Completed day ${lastBizIndex} of ${total}\n${cal.formatDay(start)} – ${cal.formatDay(end)}`,
          pct, pctShow:true, subtitle:`Completed day ${lastBizIndex} of ${total}`
        };
        return;
      }
      const dayIdx = cal.indexFor(today);
      const pct    = Math.max(0, Math.min(100, (dayIdx / total) * 100));
      this.countdown = {
        title:'UAT Days',
        label:`Day ${dayIdx} of ${total}`,
        compact:`Day ${dayIdx}/${total}`,
        tooltip:`${cal.formatDay(start)} – ${cal.formatDay(end)} · ${total} working days`,
        pct, pctShow:true,
        subtitle:`${cal.formatDay(start)} – ${cal.formatDay(end)} · ${total} working days`
      };
    },

    /* =====================================================
     * 7) Info modal
     * ===================================================== */
    async openInfo(){
      this.infoOpen = true;
      this.infoHtml = '<p class="text-slate-400">Loading…</p>';
      this.lockScroll();
      const url = this.raw.infoUrl || './about-uat.md';
      try{
        const res = await fetch(url, { cache:'no-store' });
        const md = res.ok ? await res.text() : 'No info available.';
        this.infoHtml = this.mdToHtml(md);
      }catch{
        this.infoHtml = '<p class="text-rose-400">Failed to load info.</p>';
      }
      requestAnimationFrame(()=> this.$refs?.infoDialog?.focus());
    },
    closeInfo(){
      this.infoOpen = false;
      this.unlockScroll();
    },

    /* =====================================================
     * 8) Scroll lock helpers
     * ===================================================== */
    lockScroll(){
      this._scrollY = window.scrollY || window.pageYOffset || 0;
      const b = document.body;
      b.style.position = 'fixed';
      b.style.top = `-${this._scrollY}px`;
      b.style.left = '0';
      b.style.right = '0';
      b.style.width = '100%';
    },
    unlockScroll(){
      const b = document.body;
      const y = this._scrollY || 0;
      b.style.position = '';
      b.style.top = '';
      b.style.left = '';
      b.style.right = '';
      b.style.width = '';
      window.scrollTo(0, y);
    },

    /* =====================================================
     * 9) Daily Status modal (RAG injection + fallback)
     * ===================================================== */
    async openDaily(){
      this.dailyOpen = true;
      this.dailyHtml = '<p class="text-slate-400">Loading…</p>';
      this.lockScroll();

      const url = this.raw.statusUrl || './daily-status.md';

      // Compose a small RAG header line we can prepend to the MD
      const h  = this.raw.health || {};
      const ragLine = `**Overall Status:** ${this.healthEmoji(h.status)} ${this.healthText(this.healthLabelClass(h.status||'green'))}` +
                      (h.comment ? ` — ${h.comment}` : '');

      try{
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
          const md = await res.text();
          const mdWithRag = `${ragLine}\n\n${md}`;
          this.dailyHtml = this.mdToHtml(mdWithRag);
        } else {
          this.dailyHtml = this.mdToHtml(this.buildDailyFallback(ragLine));
        }
      }catch{
        this.dailyHtml = this.mdToHtml(this.buildDailyFallback(ragLine));
      }
      requestAnimationFrame(()=> this.$refs?.dailyDialog?.focus());
    },
    closeDaily(){
      this.dailyOpen = false;
      this.unlockScroll();
    },

    // Fallback daily if external MD is missing
    buildDailyFallback(ragLine=''){
      const k = this.kpis;
      const dateLine = this.asOf ? `**Date:** ${this.asOf}` : '';
      const lines = [
        `# UAT Daily Status — ${this.raw.overview?.release || ''}`,
        dateLine,
        '',
        ragLine || '',
        '',
        '### Key Highlights',
        '- Execution is progressing on **plan**.',
        '- Defects remain manageable; blockers are **under control**.',
        `- No risks impacting the **Go/No-Go decision** today.`,
        '',
        '### Status Summary',
        `- **Executed:** ${this.fmtPct(k.executedPct)} (Planned: ${this.fmtPct(this.kpis.plannedExecutedPct||0)} · Δ ${k.execDelta>0?'+':''}${k.execDelta}pp)`,
        `- **Pass rate:** ${this.fmtPct(k.passPct)} (Planned: ${this.fmtPct(this.kpis.plannedPassPct||0)} · Δ ${k.passDelta>0?'+':''}${k.passDelta}pp)`,
        `- **Open defects:** ${k.openDefects}`,
        `- **Blocker/Critical:** ${k.critical}`,
        '',
        '### Defect Overview',
        `- Trend: ${this.trendText('defects')==='down' ? 'Improving' : this.trendText('defects')==='up' ? 'Worsening' : 'Stable'} compared to yesterday.`,
        '',
        '### Next Steps',
        '- Continue retesting open defects.',
        '- Maintain focus on **high-severity** defect resolution.'
      ];
      return lines.join('\n');
    },

    // Utilities for Daily Status
    copyDaily(){ if(this.dailyHtml){ navigator.clipboard.writeText(this.htmlToText(this.dailyHtml)); } },
    downloadDaily(){
      const text = this.dailyHtml ? this.htmlToText(this.dailyHtml) : '';
      const blob = new Blob([text], {type:'text/markdown'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Daily_Status_${(this.asOf||'').replace(/[: ]/g,'_')}.md`;
      a.click(); URL.revokeObjectURL(a.href);
    },

    /* =====================================================
     * 10) Markdown helpers (single version) + utilities
     * ===================================================== */

    // Markdown -> HTML (headings #/##/###, lists -,*,•, paragraphs, bold/italic)
    mdToHtml(md){
      if (!md || typeof md !== "string") return "";
      md = md.replace(/\r\n?/g, "\n").replace(/\\([&*_])/g, "$1").trim();

      const esc = (s) =>
        s.replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#39;");

      const formatInline = (text) => {
        let t = esc(text);
        t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        t = t.replace(/(^|[^*])\*(.+?)\*(?!\*)/g, (m, p1, g1) => p1 + "<em>" + g1 + "</em>");
        return t;
      };

      const lines = md.split("\n");
      let i = 0, html = "", inList = false;

      const flushList = () => { if (inList) { html += "</ul>"; inList = false; } };

      const collectList = () => {
        if (!inList) { html += '<ul class="list-disc pl-5 space-y-1">'; inList = true; }
        while (i < lines.length) {
          const m = lines[i].match(/^\s*[-*•]\s+(.+)$/);
          if (!m) break;
          html += `<li>${formatInline(m[1])}</li>`;
          i++;
        }
      };

      const collectParagraph = (firstLine) => {
        const block = [firstLine]; i++;
        while (i < lines.length) {
          const l = lines[i];
          if (/^\s*$/.test(l)) break;
          if (/^\s*(#{1,3})\s+/.test(l)) break;
          if (/^\s*[-*•]\s+/.test(l)) break;
          if (/^\s*---\s*$/.test(l)) break;
          block.push(l); i++;
        }
        const joined = block.map(formatInline).join("<br>");
        html += `<p>${joined}</p>`;
      };

      const peekFirstNonEmpty = () => {
        for (const l of lines) if (l.trim()) return l.trim();
        return "";
      };
      const firstLine = peekFirstNonEmpty();
      let autoTitleUsed = false;

      while (i < lines.length) {
        const line = lines[i];

        if (/^\s*$/.test(line)) { flushList(); i++; continue; }            // blank
        if (/^\s*---\s*$/.test(line)) { flushList(); html += "<hr>"; i++; continue; } // rule

        const h = line.match(/^\s*(#{1,3})\s+(.+)$/); // heading #..###
        if (h) { flushList(); const level = h[1].length; html += `<h${level}>${formatInline(h[2].trim())}</h${level}>`; i++; continue; }

        if (/^\s*[-*•]\s+/.test(line)) { collectList(); flushList(); continue; } // list

        // auto title for first non-empty line
        if (!autoTitleUsed && line.trim() === firstLine && line.length <= 120) {
          flushList(); html += `<h2>${formatInline(line.trim())}</h2>`; autoTitleUsed = true; i++; continue;
        }

        collectParagraph(line);
      }
      flushList();
      html = html.replace(/<p>\s*<\/p>/g, "");
      return html;
    },

    htmlToText(html){ const tmp=document.createElement('div'); tmp.innerHTML=html; return tmp.innerText; },

    // display helpers
    fmtPct(v){ return (v??0).toFixed(0)+'%'; },
    kpiColor(v){ return v>=90 ? 'text-emerald-400' : (v>=70 ? 'text-amber-300' : 'text-rose-400'); },
    sevDot(p){ const c = p==='Blocker' ? '#fb7185' : p==='Critical' ? '#fca5a5' : '#f59e0b'; return `background:${c}`; },
    trendText(kind){
      try{
        if(kind==='exec'){
          const arr = (this.raw.progressDaily||[]).slice(-3).map(r=>+r.executedPct||0);
          if(arr.length<2) return 'steady';
          const d = arr[arr.length-1] - arr[0];
          return d>0 ? 'up' : (d<0 ? 'down' : 'steady');
        }else{
          const arr = (this.raw.defectsDaily||[]).slice(-3).map(r=>+r.openDefects||0);
          if(arr.length<2) return 'steady';
          const d = arr[arr.length-1] - arr[0];
          return d<0 ? 'down' : (d>0 ? 'up' : 'steady');
        }
      }catch{ return '—'; }
    },
  }
}


/* =====================================================
 * 11) Alpine registration
 * ===================================================== */
document.addEventListener('alpine:init',()=>{ Alpine.data('app', app) });
