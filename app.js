/* ---------- BizCal (unchanged) ---------- */
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

/* ---------- Alpine app() (enhanced with planned vs actual) ---------- */
function app(){
  return {
    raw:{ overview:{}, progressDaily:[], defectsDaily:[], issues:[], keyDates:[], schedule:{}, plannedSeries:{}, plan:{} },
    kpis:{ inScope:0, executedPct:0, passPct:0, openDefects:0, critical:0 },
    planned:{ exec:0, pass:0 },
    deltas:{ exec:0, pass:0 },
    platforms:[], filters:{ platform:'' },
    lastUpdate:'', issues:[],
    execChart:null, defectChart:null,
    aiStatus:'', aiOpen:false,
    theme:'theme-dark',
    countdown:{ title:'UAT Days', label:'—', pct:0, pctShow:false, subtitle:'' },
    infoOpen:false, infoHtml:'',

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

      this.lastUpdate = this.raw.overview?.lastUpdate || '';
      this.platforms  = this.getPlatforms();
      this.computeKpis();
      this.computePlannedToday();   // NEW: compute planned values and deltas
      this.drawCharts();
      this.filterIssues();
      this.computeCountdown();
    },

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

    getPlatforms(){
      const set = new Set((this.raw.issues||[]).map(i=>i.platform).filter(Boolean));
      return set.size ? [...set].sort() : ['Web','App','BOSS'];
    },
    onFilterChange(){ this.computeKpis(); this.filterIssues(); },

    /* ----- Planned helpers ----- */
    plannedExecutedPct(dayIndex){
      const execDays = this.raw.plan?.exec_days ?? 10;
      if (dayIndex <= 0) return 0;
      if (dayIndex >= execDays) return 100;
      return Math.round((dayIndex / execDays) * 100);
    },
    plannedPassPct(dayIndex){
      const passDays = this.raw.plan?.pass_days ?? 15;
      const passTarget = (this.raw.plan?.pass_target ?? 95) / 100; // transform to ratio
      if (dayIndex <= 0) return 0;
      const capped = Math.min(dayIndex, passDays);
      const pct = (capped * (passTarget / passDays)) * 100;
      // Cap at 95 after day 15
      const capped95 = Math.min(pct, 95);
      return Math.round(capped95);
    },
    kpiColorPlan(actual, planned){
      const diff = actual - planned; // percentage points
      if (diff >= 0) return 'text-emerald-400';
      if (diff >= -5) return 'text-amber-300';
      return 'text-rose-400';
    },

    computePlannedToday(){
      // Determine working-day index from schedule using BizCal
      const sch = this.raw.schedule || {};
      const cal = BizCal(sch);
      const today = cal.todayTZ();
      let todayIndex = 1;
      if (cal.start && cal.end){
        if (today < cal.start) todayIndex = 1;
        else if (today > cal.end) todayIndex = cal.businessDays().length;
        else todayIndex = cal.indexFor(today);
      } else {
        // Fallback: infer from progressDaily length
        const p = this.raw.progressDaily || [];
        todayIndex = p.length ? p.length : 1;
      }

      // Prefer plannedSeries arrays if present and aligned to business days
      if (this.raw.plannedSeries?.planned_executed_pct?.length){
        const i = Math.min(todayIndex, this.raw.plannedSeries.planned_executed_pct.length) - 1;
        this.planned.exec = this.raw.plannedSeries.planned_executed_pct[i] ?? this.plannedExecutedPct(todayIndex);
      } else {
        this.planned.exec = this.plannedExecutedPct(todayIndex);
      }
      if (this.raw.plannedSeries?.planned_pass_pct?.length){
        const i = Math.min(todayIndex, this.raw.plannedSeries.planned_pass_pct.length) - 1;
        this.planned.pass = this.raw.plannedSeries.planned_pass_pct[i] ?? this.plannedPassPct(todayIndex);
      } else {
        this.planned.pass = this.plannedPassPct(todayIndex);
      }

      // Actuals from last progressDaily entry
      const p = this.raw.progressDaily || [];
      let actualExec = 0, actualPass = 0;
      if (p.length){
        actualExec = +p[p.length-1].executedPct || 0;
        actualPass = +p[p.length-1].passPct || 0;
      }
      this.deltas.exec = Math.round(actualExec - this.planned.exec);
      this.deltas.pass = Math.round(actualPass - this.planned.pass);

      // Store also in kpis for quick templating (no HTML changes yet; will be used in next step)
      this.kpis.plannedExecutedPct = this.planned.exec;
      this.kpis.plannedPassPct = this.planned.pass;
      this.kpis.execColorClass = this.kpiColorPlan(actualExec, this.planned.exec);
      this.kpis.passColorClass = this.kpiColorPlan(actualPass, this.planned.pass);
      this.kpis.execDelta = this.deltas.exec;
      this.kpis.passDelta = this.deltas.pass;
    },

    computeKpis(){
      const p = this.raw.progressDaily || [];
      if(p.length){
        const last = p[p.length-1];
        this.kpis.inScope     = last.inScope ?? this.raw.overview?.inScope ?? 0;
        this.kpis.executedPct = +last.executedPct || 0;
        this.kpis.passPct     = +last.passPct || 0;
      } else {
        this.kpis.inScope = this.raw.overview?.inScope || 0;
        this.kpis.executedPct = 0; this.kpis.passPct = 0;
      }
      const plat = this.filters.platform;
      const open = (this.raw.issues||[]).filter(i=>{
        const isOpen = !i.status || i.status.toLowerCase() !== 'closed';
        const matches = !plat || i.platform === plat;
        return isOpen && matches;
      });
      this.kpis.openDefects = open.length;
      this.kpis.critical    = open.filter(i=>['Blocker','Critical'].includes(i.priority)).length;
    },
    filterIssues(){
      const plat = this.filters.platform;
      const keep = new Set(['Blocker','Critical']);
      this.issues = (this.raw.issues || [])
        .filter(i => keep.has((i.priority||'').trim()))
        .filter(i => !plat || i.platform === plat);
    },

    drawCharts(){
      if(!window.Chart){ console.error('Chart.js not loaded'); return; }
      const common = {
        responsive:true, maintainAspectRatio:false, animation:false,
        elements: { line: { borderWidth: 2 }, point: { radius: 3, hitRadius: 6, hoverRadius: 4 } },
        plugins:{ legend:{ position:'bottom', labels:{ color:'#94a3b8' } } }
      };
      const labels = (this.raw.progressDaily||[]).map(r=>r.date);
      const exec   = (this.raw.progressDaily||[]).map(r=>+r.executedPct||0);
      const pass   = (this.raw.progressDaily||[]).map(r=>+r.passPct||0);

      // Build planned series aligned to the number of business days captured in progressDaily
      const n = labels.length || Math.max(this.raw.plannedSeries?.planned_executed_pct?.length||0, this.raw.plannedSeries?.planned_pass_pct?.length||0) || 0;
      const plannedExec = [];
      const plannedPass = [];
      for (let i=1;i<=n;i++){
        if (this.raw.plannedSeries?.planned_executed_pct?.length >= i){
          plannedExec.push(this.raw.plannedSeries.planned_executed_pct[i-1]);
        } else {
          plannedExec.push(this.plannedExecutedPct(i));
        }
        if (this.raw.plannedSeries?.planned_pass_pct?.length >= i){
          plannedPass.push(this.raw.plannedSeries.planned_pass_pct[i-1]);
        } else {
          plannedPass.push(this.plannedPassPct(i));
        }
      }

      if(this.execChart){ this.execChart.destroy(); }
      this.execChart = new Chart(document.getElementById('execChart'), {
        type:'line',
        data:{ labels, datasets:[
          {label:'Executed %', data:exec, borderColor:'#60a5fa', backgroundColor:'#60a5fa', tension:.25, spanGaps:true},
          {label:'Pass %',     data:pass, borderColor:'#a78bfa', backgroundColor:'#a78bfa', tension:.25, spanGaps:true},
          {label:'Executed % (Planned)', data:plannedExec, borderColor:'#94a3b8', backgroundColor:'#94a3b8', borderDash:[6,6], tension:.25, spanGaps:true, pointRadius:0},
          {label:'Pass % (Planned)',     data:plannedPass, borderColor:'#64748b', backgroundColor:'#64748b', borderDash:[6,6], tension:.25, spanGaps:true, pointRadius:0}
        ]},
        options:{
          ...common,
          scales:{
            x:{ type:'time', time:{ unit:'day' }, grid:{ color:'rgba(148,163,184,.2)'} },
            y:{ beginAtZero:true, max:100, ticks:{ callback:v=>v+'%' }, grid:{ color:'rgba(148,163,184,.2)'} }
          }
        }
      });

      const labelsD = (this.raw.defectsDaily||[]).map(r=>r.date);
      const open    = (this.raw.defectsDaily||[]).map(r=>+r.openDefects||0);
      if(this.defectChart){ this.defectChart.destroy(); }
      this.defectChart = new Chart(document.getElementById('defectChart'), {
        type:'line',
        data:{ labels: labelsD, datasets:[
          {label:'Open defects', data:open, borderColor:'#34d399', backgroundColor:'#34d399', tension:.25, spanGaps:true}
        ]},
        options:{
          ...common,
          scales:{
            x:{ type:'time', time:{ unit:'day' }, grid:{ color:'rgba(148,163,184,.2)'} },
            y:{ beginAtZero:true, grid:{ color:'rgba(148,163,184,.2)'} }
          }
        }
      });
    },

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

    async openInfo(){
      this.infoOpen = true;
      this.infoHtml = '<p class="text-slate-400">Loading…</p>';
      const url = this.raw.infoUrl || './about-uat.md';
      try{
        const res = await fetch(url, { cache:'no-store' });
        const md = res.ok ? await res.text() : 'No info available.';
        this.infoHtml = this.mdToHtml(md);
      }catch{
        this.infoHtml = '<p class="text-rose-400">Failed to load info.</p>';
      }
    },

    generateAIStatus(){
      this.aiOpen = true;
      const plat = this.filters.platform || 'All platforms';
      const md = [
        `**Summary (${plat})**`,
        `• Executed ${this.fmtPct(this.kpis.executedPct)}, Pass ${this.fmtPct(this.kpis.passPct)}. Open defects ${this.kpis.openDefects} (${this.kpis.critical} blocker/critical).`,
        `• Execution trending ${this.trendText('exec')} and defects ${this.trendText('def')}.`,
        ``,
        `**Highlights**`,
        `• Most planned scenarios executed; quality trending positively.`,
        `• Key dates on track; no change to Go/No-Go.`,
        ``,
        `**Risks & Blockers**`,
        `${this.issues.length ? '• Active blockers/criticals require attention (see table below).' : '• No Blocker/Critical reported currently.'}`,
        ``,
        `**Next Steps**`,
        `• Close remaining critical defects; re-test impacted flows.`,
        `• Prepare demo materials ahead of Alpha Demo.`,
      ].join('\n');
      this.aiStatus = this.mdToHtml(md);
    },
    copyAI(){ if(this.aiStatus){ navigator.clipboard.writeText(this.htmlToText(this.aiStatus)); } },
    downloadAI(){
      const text = this.aiStatus ? this.htmlToText(this.aiStatus) : '';
      const blob = new Blob([text], {type:'text/markdown'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `UAT_Daily_Status_${(this.lastUpdate||'').replace(/[: ]/g,'_')}.md`;
      a.click(); URL.revokeObjectURL(a.href);
    },

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
    mdToHtml(md){
      const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      return esc(md)
        .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
        .replace(/^• /gm,'<li>')
        .replace(/\n{2,}/g,'\n\n')
        .split('\n\n').map(block=>{
          if(block.startsWith('<li>')) return `<ul class="list-disc pl-5 space-y-1">${block.replace(/<li>/g,'<li class="marker:text-slate-400">')}</ul>`;
          return `<p>${block.replace(/\n/g,'<br>')}</p>`;
        }).join('');
    },
    htmlToText(html){ const tmp=document.createElement('div'); tmp.innerHTML=html; return tmp.innerText; }
  }
}

/* Alpine registration */
document.addEventListener('alpine:init',()=>{ Alpine.data('app', app) });
