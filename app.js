/*!
 * UAT Dashboard – application logic
 * - Loads uat.json
 * - Filters by platform; computes KPIs, charts, countdown (business days), health (R/A/G with manual overrides)
 * - Alpine entry: app(), Utilities: BizCal(), mdToHtml()
 * Author: Ildefonso Molinero
 */

function app(){
  return {
    // ---------- State ----------
    raw: {},                    // full JSON
    filtered: {},              // filtered by platform
    platforms: [],             // from data
    filters: { platform: 'ALL' },

    kpis: { inScope: 0, executedPct: 0, passPct: 0, openDefects: 0, critical: 0 },
    countdown: { compact:'—', tooltip:'UAT dates not configured', pct:0, pctShow:false },
    health: { label:'—', className:'', dotClass:'', tooltip:'' },

    issues: [],                // Blocker/Critical view
    infoHtml: '',              // Info modal content
    reportHtml: '',            // AI daily status content (placeholder)
    showInfo: false,
    showReport: false,

    execChart: null,
    defectChart: null,
    lastUpdate: '',

    // ---------- Lifecycle ----------
    async init(){
      try{
        const res = await fetch('./uat.json?'+Date.now());
        this.raw = await res.json();
      }catch(e){ console.error('Failed to load uat.json', e); return; }

      this.lastUpdate = this.raw?.overview?.lastUpdate || '';

      // Platforms
      const set = new Set((this.raw.issues||[]).map(i=>i.platform).filter(Boolean));
      (this.raw.progressDaily||[]).forEach(r=>set.add(r.platform));
      this.platforms = Array.from(set).filter(Boolean).sort();

      // Build info HTML (optional external text could be loaded too)
      this.infoHtml = `
        <h3 class="font-semibold mb-2">What is UAT RI-4?</h3>
        <p>User Acceptance Testing validates the end-to-end experience across Web, App, and BOSS before go-live.</p>
        <ul class="list-disc ml-5 mt-2">
          <li>Scope: Checkout, Payments, Account, Order history</li>
          <li>Back-office: pricing, promotions, tax, fulfillment</li>
        </ul>
      `;

      this.applyFilters();
      this.drawCharts();
    },

    // ---------- Filters & KPIs ----------
    applyFilters(){
      const plat = this.filters.platform;
      // progress/defects filtered
      this.filtered.progressDaily = (this.raw.progressDaily||[]).filter(r=>plat==='ALL'||r.platform===plat);
      this.filtered.defectsDaily  = (this.raw.defectsDaily||[]).filter(r=>plat==='ALL'||r.platform===plat);

      // Issues: show Blocker/Critical only
      const keep = new Set(['Blocker','Critical']);
      this.issues = (this.raw.issues||[])
        .filter(i => keep.has((i.priority||'').trim()))
        .filter(i => plat==='ALL' || i.platform === plat);

      // KPIs
      this.kpis.inScope = this.filtered.progressDaily.at(-1)?.inScope || this.raw.overview?.inScope || 0;
      this.kpis.executedPct = this.filtered.progressDaily.at(-1)?.executedPct || 0;
      this.kpis.passPct     = this.filtered.progressDaily.at(-1)?.passPct || 0;
      this.kpis.openDefects = this.filtered.defectsDaily.at(-1)?.openDefects ?? (this.raw.defectsDaily?.at(-1)?.openDefects ?? 0);
      this.kpis.critical    = this.issues.length;

      // Countdown + Health
      this.computeCountdown();
      this.computeHealth();

      // Charts refresh
      this.updateCharts();
    },

    // ---------- Countdown (business-day aware) ----------
    computeCountdown(){
      const sch = this.raw.schedule || {};
      const cal = BizCal(sch);
      const { start, end } = cal;

      if(!start || !end){
        this.countdown = { compact:'—', tooltip:'UAT dates not configured', pct:0, pctShow:false, subtitle:'(dates missing)' };
        return;
      }

      const bizDays = cal.businessDays();
      const total   = bizDays.length;
      const today   = cal.todayTZ();
      const beforeStart = today < start;
      const afterEnd    = today > end;

      if (beforeStart){
        let firstRun = new Date(start);
        while(!cal.isBusiness(firstRun)) firstRun = new Date(firstRun.getTime()+86400000);
        let daysUntil = 0;
        for (let d=new Date(today.getTime()+86400000); d<=firstRun; d=new Date(d.getTime()+86400000)){
          if(cal.isBusiness(d)) daysUntil++;
        }
        const calDays = Math.ceil((firstRun - today) / 86400000);
        this.countdown = {
          compact: `Starts in ${daysUntil} biz day${daysUntil===1?'':'s'}`,
          tooltip: `${cal.formatDay(start)} – ${cal.formatDay(end)} · ${total} working days\n${calDays} calendar days to start`,
          pct:0, pctShow:false, subtitle:''
        };
        return;
      }
      if (afterEnd){
        this.countdown = {
          compact:'Completed',
          tooltip:`Ran ${cal.formatDay(start)} – ${cal.formatDay(end)} · ${total} working days`,
          pct:100, pctShow:true, subtitle:''
        };
        return;
      }
      if (!cal.isBusiness(today)){
        const lastBizIndex = cal.indexFor(new Date(today.getTime()-86400000));
        const next = cal.nextBusinessAfter(today);
        const pct = Math.max(0, Math.min(100, (lastBizIndex/total)*100));
        this.countdown = {
          compact:`Paused · resumes ${cal.formatDay(next)}`,
          tooltip:`Completed day ${lastBizIndex} of ${total}\n${cal.formatDay(start)} – ${cal.formatDay(end)}`,
          pct, pctShow:true, subtitle:''
        };
        return;
      }
      const dayIdx = cal.indexFor(today);
      const pct    = Math.max(0, Math.min(100, (dayIdx/total)*100));
      this.countdown = {
        compact:`Day ${dayIdx}/${total}`,
        tooltip:`${cal.formatDay(start)} – ${cal.formatDay(end)} · ${total} working days`,
        pct, pctShow:true, subtitle:''
      };
    },

    // ---------- Health (R/A/G) ----------
    /**
     * Manual override per day via raw.dailyStatus. Fallback auto rules (mild).
     * Severity order: R > A > G.
     */
    computeHealth(){
      const plat = this.filters.platform;
      const todayISO = new Date().toISOString().slice(0,10);

      // 1) Manual overrides
      const overrides = (this.raw.dailyStatus||[])
        .filter(r => r.date === todayISO && (r.platform === plat || r.platform === 'ALL'));

      const pickMostSevere = (arr)=> {
        const rank = { 'R':3, 'A':2, 'G':1 };
        return arr.sort((a,b)=> (rank[b.rag||'G']||0) - (rank[a.rag||'G']||0))[0];
      };

      const ov = overrides.length ? pickMostSevere(overrides) : null;
      if (ov){
        const map = this._healthMap(ov.rag);
        this.health = {
          label: map.label,
          className: map.bgClass,
          dotClass: map.dotClass,
          tooltip: (ov.reason ? `${map.label}: ${ov.reason}` : map.label) + (ov.by ? ` (by ${ov.by})` : '')
        };
        return;
      }

      // 2) Fallback (auto) – very conservative default
      let rag = 'G';
      const crit = this.kpis.critical || 0;
      const pass = +this.kpis.passPct || 0;

      if (crit >= 2) rag = 'R';
      else if (crit === 1 || pass < 90) rag = 'A';

      const map = this._healthMap(rag);
      this.health = { label: map.label, className: map.bgClass, dotClass: map.dotClass, tooltip: map.label };
    },

    _healthMap(rag){
      switch((rag||'G').toUpperCase()){
        case 'R': return { label:'At risk', bgClass:'health-R', dotClass:'dot-R' };
        case 'A': return { label:'Watch',  bgClass:'health-A', dotClass:'dot-A' };
        default:  return { label:'Healthy', bgClass:'health-G', dotClass:'dot-G' };
      }
    },

    // ---------- Charts ----------
    drawCharts(){
      const ctx1 = document.getElementById('execChart');
      const ctx2 = document.getElementById('defectChart');

      this.execChart = new Chart(ctx1, {
        type:'line',
        data:{ datasets:[
          { label:'Executed %', data:[], tension:.3, pointRadius:2, borderColor:'#5b8def', backgroundColor:'#5b8def' },
          { label:'Pass %',     data:[], tension:.3, pointRadius:2, borderColor:'#a78bfa', backgroundColor:'#a78bfa' }
        ]},
        options:{
          responsive:true, maintainAspectRatio:false,
          scales:{
            x:{ type:'time', time:{ unit:'day' } },
            y:{ min:0, max:100, ticks:{ callback:v=>v+'%' } }
          },
          plugins:{ legend:{ display:true } }
        }
      });

      this.defectChart = new Chart(ctx2, {
        type:'line',
        data:{ datasets:[
          { label:'Open defects', data:[], tension:.3, pointRadius:2, borderColor:'#22c55e', backgroundColor:'#22c55e' }
        ]},
        options:{
          responsive:true, maintainAspectRatio:false,
          scales:{
            x:{ type:'time', time:{ unit:'day' } },
            y:{ beginAtZero:true }
          },
          plugins:{ legend:{ display:true } }
        }
      });

      this.updateCharts();
    },

    updateCharts(){
      if (!this.execChart || !this.defectChart) return;

      const exec = (this.filtered.progressDaily||[]).map(r => ({ x:r.date, y:r.executedPct }));
      const pass = (this.filtered.progressDaily||[]).map(r => ({ x:r.date, y:r.passPct }));
      this.execChart.data.datasets[0].data = exec;
      this.execChart.data.datasets[1].data = pass;
      this.execChart.update();

      const open = (this.filtered.defectsDaily||[]).map(r => ({ x:r.date, y:r.openDefects||0 }));
      this.defectChart.data.datasets[0].data = open;
      this.defectChart.update();
    },

    // ---------- UI helpers ----------
    openInfo(){ this.showInfo = true; },
    openReport(){
      // Placeholder report – you can wire GenAI later
      const k = this.kpis;
      this.reportHtml = mdToHtml(`
**Summary (All platforms)**
- Executed ${k.executedPct}% · Pass ${k.passPct}% · Open defects ${k.openDefects} (${k.critical} blocker/critical).
- Execution trending steady and defects down.

**Risks & Blockers**
- See table below.

**Next Steps**
- Close remaining criticals and re-test impacted flows.
      `);
      this.showReport = true;
    },
    copyReport(){ navigator.clipboard.writeText(this.reportHtml.replace(/<[^>]+>/g,'')); },
    downloadReport(){
      const blob = new Blob([this.reportHtml.replace(/<[^>]+>/g,'')], {type:'text/markdown'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'uat-status.md'; a.click();
      URL.revokeObjectURL(a.href);
    },

    fmtPct(v){ return (v || v===0) ? `${Number(v).toFixed(0)}%` : '—'; }
  };
}

/* -------------------------- Utilities -------------------------- */

// Minimal markdown → HTML (safe-ish)
function mdToHtml(md){
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  return esc(md)
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .split('\n\n').map(block=>{
      if(block.trim().startsWith('- ')){
        const items = block.trim().split('\n').map(l=>l.replace(/^- /,'').trim());
        return `<ul class="list-disc ml-5 space-y-1">${items.map(i=>`<li>${i}</li>`).join('')}</ul>`;
      }
      return `<p>${block.replace(/\n/g,'<br>')}</p>`;
    }).join('');
}

// Business calendar helper (TZ + holidays)
function BizCal({ start, end, timezone='Europe/Berlin', holidays=[] }){
  const fmt = (d) => new Date(d);
  const S = start ? fmt(start) : null;
  const E = end   ? fmt(end)   : null;
  const tz = timezone;

  // holidays as yyyy-mm-dd set
  const hset = new Set(holidays || []);

  const isBusiness = (d)=>{
    const day = d.getDay(); // 0 Sun .. 6 Sat
    const iso = d.toISOString().slice(0,10);
    return day!==0 && day!==6 && !hset.has(iso);
  };
  const businessDays = ()=>{
    if(!S || !E) return [];
    const days=[]; let d=new Date(S);
    while(d<=E){ if(isBusiness(d)) days.push(new Date(d)); d=new Date(d.getTime()+86400000); }
    return days;
  };
  const nextBusinessAfter = (d)=>{
    let x = new Date(d.getTime()+86400000);
    while(!isBusiness(x)) x = new Date(x.getTime()+86400000);
    return x;
  };
  const indexFor = (d)=>{
    const arr = businessDays();
    const iso = d.toISOString().slice(0,10);
    const idx = arr.findIndex(x=>x.toISOString().slice(0,10)===iso);
    return idx>=0 ? idx+1 : Math.max(0, arr.findIndex(x=>x<d))+1;
  };
  const todayTZ = ()=>{
    // naive (browser TZ) is OK for now
    const now = new Date();
    const iso = now.toISOString().slice(0,10);
    return new Date(iso+'T12:00:00Z'); // avoid DST edge
  };
  const formatDay = d => {
    const dt = new Date(d);
    return dt.toLocaleDateString(undefined,{ day:'2-digit', month:'short' }).replace('.', '');
  };

  return { start:S, end:E, timezone:tz, isBusiness, businessDays, nextBusinessAfter, indexFor, todayTZ, formatDay };
}

document.addEventListener('alpine:init', ()=> Alpine.data('app', app) );
