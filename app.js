
/* ERA — Emergency Resource Allocator
   Local-first MVP. State is persisted in localStorage and synchronized across tabs.
*/
const STORAGE_KEY = "era_mvp_state_v1";
const SESSION_KEY = "era_mvp_session_v1";
const CHANNEL_NAME = "era_mvp_sync";
let mapInstance = null, routeLayer = null, refreshTimer = null;

const seedState = {
  meta:{version:1, lastUpdated:Date.now(), nextCase:1001, nextRequest:5001, nextReservation:8001},
  settings:{requestTimeoutSec:60, weights:{resource:45, travel:25, freshness:15, capacity:15}},
  users:[
    {id:"disp-1",name:"Central Dispatcher",role:"dispatcher",username:"dispatcher",password:"dispatch123"},
    {id:"amb-1",name:"Ambulance Operator A1",role:"ambulance",username:"ambulance1",password:"amb123",ambulanceId:"AMB-01"},
    {id:"amb-2",name:"Ambulance Operator A2",role:"ambulance",username:"ambulance2",password:"amb123",ambulanceId:"AMB-02"},
    {id:"amb-3",name:"Ambulance Operator A3",role:"ambulance",username:"ambulance3",password:"amb123",ambulanceId:"AMB-03"},
    {id:"amb-4",name:"Ambulance Operator A4",role:"ambulance",username:"ambulance4",password:"amb123",ambulanceId:"AMB-04"},
    {id:"hosp-1",name:"CityCare General Hospital",role:"hospital",username:"hospital1",password:"hosp123",hospitalId:"H-01"},
    {id:"hosp-2",name:"Metro Trauma & Critical Care",role:"hospital",username:"hospital2",password:"hosp123",hospitalId:"H-02"},
    {id:"hosp-3",name:"Riverside Medical Center",role:"hospital",username:"hospital3",password:"hosp123",hospitalId:"H-03"},
    {id:"hosp-4",name:"Sunrise Multispeciality Hospital",role:"hospital",username:"hospital4",password:"hosp123",hospitalId:"H-04"}
  ],
  hospitals:[
    {id:"H-01",name:"CityCare General Hospital",lat:18.5204,lng:73.8567,address:"Central Pune",lastUpdated:Date.now()-15*1000,
      resources:{icu:4,ventilator:3,ot:2,trauma:3,bloodOneg:6,cardiology:2,neuro:2,pediatric:3}},
    {id:"H-02",name:"Metro Trauma & Critical Care",lat:18.5314,lng:73.8446,address:"Shivajinagar",lastUpdated:Date.now()-90*1000,
      resources:{icu:2,ventilator:2,ot:3,trauma:5,bloodOneg:2,cardiology:1,neuro:1,pediatric:1}},
    {id:"H-03",name:"Riverside Medical Center",lat:18.5074,lng:73.8077,address:"Aundh",lastUpdated:Date.now()-4*60*1000,
      resources:{icu:5,ventilator:1,ot:1,trauma:2,bloodOneg:8,cardiology:3,neuro:3,pediatric:4}},
    {id:"H-04",name:"Sunrise Multispeciality Hospital",lat:18.5590,lng:73.7868,address:"Baner",lastUpdated:Date.now()-8*60*1000,
      resources:{icu:3,ventilator:3,ot:2,trauma:1,bloodOneg:4,cardiology:2,neuro:2,pediatric:2}}
  ],
  ambulances:[
    {id:"AMB-01",operator:"amb-1",status:"AVAILABLE",lat:18.5074,lng:73.8077,currentCaseId:null},
    {id:"AMB-02",operator:"amb-2",status:"AVAILABLE",lat:18.5204,lng:73.8567,currentCaseId:null},
    {id:"AMB-03",operator:"amb-3",status:"AVAILABLE",lat:18.5314,lng:73.8446,currentCaseId:null},
    {id:"AMB-04",operator:"amb-4",status:"AVAILABLE",lat:18.5590,lng:73.7868,currentCaseId:null}
  ],
  cases:[],
  requests:[],
  reservations:[],
  audit:[
    {id:"evt-1",ts:Date.now()-60*1000,type:"SYSTEM",message:"ERA MVP initialized with simulated hospital and ambulance data."}
  ]
};

const resourceLabels = {
  icu:"ICU Bed", ventilator:"Ventilator", ot:"Operating Theatre", trauma:"Trauma Team",
  bloodOneg:"O− Blood Units", cardiology:"Cardiology", neuro:"Neuro", pediatric:"Pediatric"
};
const severityWeight = {CRITICAL:1.0,HIGH:.8,MODERATE:.55,LOW:.3};

function clone(o){return JSON.parse(JSON.stringify(o))}
function now(){return Date.now()}
function uid(prefix){return prefix+"-"+Math.random().toString(36).slice(2,8)}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmtTime(ts){return new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})}
function ageSec(ts){return Math.max(0,Math.floor((now()-ts)/1000))}
function freshnessLabel(ts){
  const a=ageSec(ts); if(a<30) return ["Fresh","green"]; if(a<120) return ["Recent","blue"]; if(a<300) return ["Aging","yellow"]; return ["Stale","red"];
}
function getState(){
  const raw=localStorage.getItem(STORAGE_KEY);
  if(!raw){localStorage.setItem(STORAGE_KEY,JSON.stringify(seedState)); return clone(seedState)}
  try{return JSON.parse(raw)}catch(e){localStorage.setItem(STORAGE_KEY,JSON.stringify(seedState));return clone(seedState)}
}
function saveState(s, reason="state updated"){
  s.meta.lastUpdated=now(); s.meta.version=(s.meta.version||0)+1;
  localStorage.setItem(STORAGE_KEY,JSON.stringify(s));
  try{localStorage.setItem("era_mvp_ping",JSON.stringify({t:now(),reason}))}catch(e){}
  return s;
}
function audit(s,type,message,caseId=null){
  s.audit.unshift({id:uid("evt"),ts:now(),type,message,caseId});
  s.audit=s.audit.slice(0,150);
}
function getSession(){try{return JSON.parse(sessionStorage.getItem(SESSION_KEY)||"null")}catch(e){return null}}
function setSession(u){sessionStorage.setItem(SESSION_KEY,JSON.stringify(u))}
function logout(){sessionStorage.removeItem(SESSION_KEY); location.reload()}
function currentUser(){const x=getSession(); if(!x)return null; return x}
function hospitalById(s,id){return s.hospitals.find(x=>x.id===id)}
function ambulanceById(s,id){return s.ambulances.find(x=>x.id===id)}
function caseById(s,id){return s.cases.find(x=>x.id===id)}
function userById(s,id){return s.users.find(x=>x.id===id)}
function distanceKm(a,b){
  const R=6371, p=Math.PI/180, dLat=(b.lat-a.lat)*p,dLng=(b.lng-a.lng)*p;
  const q=Math.sin(dLat/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(q));
}
function etaMinutes(km, severity="MODERATE"){
  const traffic = 1.15 + ((Math.round(km*10)%4)*.08);
  const speed = severity==="CRITICAL"?34:30;
  return Math.max(2,Math.round(km/ speed *60*traffic));
}
function resourceRequirementsFromForm(form){
  const req={};
  ["icu","ventilator","ot","trauma","bloodOneg","cardiology","neuro","pediatric"].forEach(k=>{
    const el=form.querySelector(`[name="${k}"]`);
    if(el && Number(el.value)>0) req[k]=Number(el.value);
  });
  return req;
}
function requiredResourceText(req){return Object.entries(req).filter(([,v])=>v>0).map(([k,v])=>`${resourceLabels[k]} ×${v}`).join(", ")||"No special resource specified"}
function computeRankings(s, c){
  const w=s.settings.weights;
  const amb=ambulanceById(s,c.ambulanceId);
  const candidates=s.hospitals.map(h=>{
    const freshness=freshnessLabel(h.lastUpdated);
    const age=ageSec(h.lastUpdated);
    let matched=0, total=0, hardFail=false;
    const resourceDetails=[];
    for(const [k,v] of Object.entries(c.requirements||{})){
      total++;
      const available=(h.resources[k]||0);
      const ok=available>=v;
      if(ok) matched++; else hardFail=true;
      resourceDetails.push({key:k,required:v,available,ok});
    }
    const resourceScore=total?matched/total*100:100;
    const km=distanceKm(amb,h), eta=etaMinutes(km,c.severity);
    const travelScore=Math.max(0,100-(eta*2.4));
    const freshScore=Math.max(0,100-(age/300*100));
    const capacityValues=Object.entries(c.requirements||{}).map(([k,v])=>Math.min(2,(h.resources[k]||0)/Math.max(1,v)));
    const capacityScore=capacityValues.length ? Math.min(100,capacityValues.reduce((a,b)=>a+b,0)/capacityValues.length*50) : 70;
    const severityBoost=severityWeight[c.severity]||.5;
    let score=resourceScore*w.resource/100+travelScore*w.travel/100+freshScore*w.freshness/100+capacityScore*w.capacity/100;
    if(hardFail) score-=35;
    if(freshness[1]==="red") score-=8;
    if(c.severity==="CRITICAL" && eta>15) score-=8;
    score=Math.max(0,Math.min(100,score));
    return {hospitalId:h.id,hospitalName:h.name,score,hardFail,km,eta,resourceScore,travelScore,freshScore,capacityScore,
      freshnessLabel:freshness[0],freshnessClass:freshness[1],resourceDetails,severityBoost};
  }).sort((a,b)=>b.score-a.score);
  return candidates;
}
function rankBadge(r){
  if(r.hardFail) return `<span class="status s-red"><span class="status-dot"></span>Missing mandatory resource</span>`;
  return `<span class="status s-green"><span class="status-dot"></span>Eligible</span>`;
}
function activeRequestForCase(s,caseId){
  return s.requests.find(r=>r.caseId===caseId && ["PENDING","STANDBY"].includes(r.status));
}
function caseRequests(s,caseId){return s.requests.filter(r=>r.caseId===caseId).sort((a,b)=>b.createdAt-a.createdAt)}
function reservationForCase(s,caseId){return s.reservations.find(r=>r.caseId===caseId && r.status==="ACTIVE")}
function reserveResources(s,c,h){
  // MVP atomic-style reservation: a short localStorage lock prevents normal cross-tab races.
  const lockKey="era_resource_lock_"+h.id, token=uid("lock");
  const existing=localStorage.getItem(lockKey);
  if(existing){try{const x=JSON.parse(existing);if(now()-x.ts<4000)return {ok:false,reason:"Hospital resource lock is currently held by another transaction."}}catch(e){}}
  localStorage.setItem(lockKey,JSON.stringify({token,ts:now()}));
  try{
    const fresh=getState();
    const hh=hospitalById(fresh,h.id), cc=caseById(fresh,c.id);
    if(!hh||!cc) return {ok:false,reason:"Case or hospital no longer exists."};
    for(const [k,v] of Object.entries(cc.requirements||{})){
      if((hh.resources[k]||0)<v) return {ok:false,reason:`${resourceLabels[k]} no longer available.`};
    }
    for(const [k,v] of Object.entries(cc.requirements||{})) hh.resources[k]-=v;
    const reservation={id:"RES-"+fresh.meta.nextReservation++,caseId:c.id,hospitalId:h.id,resources:clone(c.requirements),status:"ACTIVE",createdAt:now()};
    fresh.reservations.push(reservation);
    cc.assignedHospitalId=h.id; cc.status="ASSIGNED"; cc.assignmentConfirmedAt=now();
    cc.updatedAt=now();
    audit(fresh,"RESERVATION",`${h.name} reserved resources for ${cc.patientName}.`,c.id);
    saveState(fresh,"resources reserved");
    return {ok:true,reservation};
  } finally {localStorage.removeItem(lockKey)}
}
function releaseReservation(s,c){
  const r=reservationForCase(s,c.id); if(!r)return false;
  const h=hospitalById(s,r.hospitalId); if(!h)return false;
  for(const [k,v] of Object.entries(r.resources||{}))h.resources[k]=(h.resources[k]||0)+v;
  r.status="RELEASED";r.releasedAt=now();
  audit(s,"RELEASE",`Released reserved resources at ${h.name} for ${c.patientName}.`,c.id);
  return true;
}
function triggerReallocation(s,c,reason){
  c.status="REALLOCATING";c.reallocationCount=(c.reallocationCount||0)+1;c.updatedAt=now();
  audit(s,"REALLOCATION",`${c.patientName}: ${reason}. Re-ranking eligible hospitals.`,c.id);
  const ranks=computeRankings(s,c);
  const previous=new Set(caseRequests(s,c.id).map(r=>r.hospitalId));
  const candidate=ranks.find(r=>!r.hardFail && !previous.has(r.hospitalId));
  if(candidate){
    const req={id:"REQ-"+s.meta.nextRequest++,caseId:c.id,hospitalId:candidate.hospitalId,status:"PENDING",createdAt:now(),expiresAt:now()+s.settings.requestTimeoutSec*1000,attempt:c.reallocationCount+1};
    s.requests.push(req);
    c.status="AWAITING_CONFIRMATION";c.pendingHospitalId=candidate.hospitalId;c.updatedAt=now();
    audit(s,"REQUEST",`Reallocation request sent to ${candidate.hospitalName}.`,c.id);
    saveState(s,"reallocation request");
    return candidate;
  }
  c.status="NO_HOSPITAL";c.pendingHospitalId=null;c.updatedAt=now();
  audit(s,"ALERT",`No eligible hospital found for ${c.patientName}. Dispatcher intervention required.`,c.id);
  saveState(s,"no hospital");
  return null;
}
function createCase(s,form,user){
  const ambulance=ambulanceById(s,user.ambulanceId);
  if(!ambulance || ambulance.currentCaseId) throw new Error("This ambulance already has an active case.");
  const fd=new FormData(form);
  const c={
    id:"CASE-"+s.meta.nextCase++,patientName:fd.get("patientName"),age:Number(fd.get("age")||0),
    sex:fd.get("sex"),severity:fd.get("severity"),condition:fd.get("condition"),
    requirements:resourceRequirementsFromForm(form),ambulanceId:user.ambulanceId,status:"RANKING",
    createdAt:now(),updatedAt:now(),assignedHospitalId:null,pendingHospitalId:null,reallocationCount:0,
    location:{lat:ambulance.lat,lng:ambulance.lng,label:fd.get("locationLabel")||"Ambulance current location"},
    notes:fd.get("notes")||""
  };
  s.cases.unshift(c);ambulance.currentCaseId=c.id;ambulance.status="ON_CASE";
  audit(s,"CASE",`New ${c.severity} emergency ${c.id} created by ${user.name}.`,c.id);
  const ranks=computeRankings(s,c);
  const top=ranks.find(r=>!r.hardFail);
  if(top){
    const req={id:"REQ-"+s.meta.nextRequest++,caseId:c.id,hospitalId:top.hospitalId,status:"PENDING",createdAt:now(),expiresAt:now()+s.settings.requestTimeoutSec*1000,attempt:1};
    s.requests.push(req);c.status="AWAITING_CONFIRMATION";c.pendingHospitalId=top.hospitalId;
    audit(s,"REQUEST",`Initial hospital request sent to ${top.hospitalName}.`,c.id);
    ranks.slice(0,3).filter(r=>r.hospitalId!==top.hospitalId&&!r.hardFail).forEach(r=>{
      s.requests.push({id:"REQ-"+s.meta.nextRequest++,caseId:c.id,hospitalId:r.hospitalId,status:"STANDBY",createdAt:now(),expiresAt:null,attempt:1});
      audit(s,"STANDBY",`${r.hospitalName} placed on standby.`,c.id);
    });
  }else{c.status="NO_HOSPITAL";audit(s,"ALERT",`No suitable hospital found for ${c.patientName}.`,c.id)}
  saveState(s,"case created");return c;
}
function hospitalRespond(s,requestId,decision,reason=""){
  const r=s.requests.find(x=>x.id===requestId); if(!r||r.status!=="PENDING")return {ok:false,reason:"Request is no longer pending."};
  const c=caseById(s,r.caseId),h=hospitalById(s,r.hospitalId);
  if(!c||!h)return {ok:false,reason:"Case or hospital missing."};
  if(decision==="REJECT"){
    r.status="REJECTED";r.respondedAt=now();r.reason=reason||"Hospital cannot accept at this time.";
    audit(s,"REJECT",`${h.name} rejected ${c.patientName}: ${r.reason}`,c.id);
    if(c.status!=="ASSIGNED"){triggerReallocation(s,c,`${h.name} rejected request`)}
    else saveState(s,"request rejected");
    return {ok:true};
  }
  const result=reserveResources(s,c,h);
  if(!result.ok){
    r.status="CONFLICT";r.respondedAt=now();r.reason=result.reason;
    audit(s,"CONFLICT",`${h.name} could not reserve resources for ${c.patientName}: ${result.reason}`,c.id);
    triggerReallocation(s,c,`reservation conflict at ${h.name}`);
    return {ok:false,reason:result.reason};
  }
  r.status="ACCEPTED";r.respondedAt=now();r.reservationId=result.reservation.id;
  s.requests.filter(x=>x.caseId===c.id&&x.status==="STANDBY").forEach(x=>{x.status="CANCELLED";x.respondedAt=now()});
  c.pendingHospitalId=null;
  const amb=ambulanceById(s,c.ambulanceId);if(amb)amb.status="EN_ROUTE";
  audit(s,"ACCEPT",`${h.name} accepted ${c.patientName}; required resources reserved.`,c.id);
  saveState(s,"request accepted");return {ok:true};
}
function processTimeouts(){
  const s=getState();let changed=false;
  s.requests.filter(r=>r.status==="PENDING"&&r.expiresAt&&r.expiresAt<=now()).forEach(r=>{
    const c=caseById(s,r.caseId);if(!c||c.status==="ASSIGNED")return;
    r.status="EXPIRED";r.respondedAt=now();r.reason="Response timeout";
    audit(s,"TIMEOUT",`Request ${r.id} to ${hospitalById(s,r.hospitalId)?.name||r.hospitalId} expired.`,c.id);
    triggerReallocation(s,c,"hospital response timeout");changed=true;
  });
  if(changed)saveState(s,"timeout processing");
  return changed;
}
function seedDemoCase(){
  const s=getState(), u=s.users.find(x=>x.role==="ambulance");
  if(!u||ambulanceById(s,u.ambulanceId).currentCaseId)return;
  const form=document.createElement("form");
  const fields={patientName:"Demo Critical Patient",age:"47",sex:"M",severity:"CRITICAL",condition:"Road traffic trauma",locationLabel:"Demo incident zone",notes:"Dispatcher demo case"};
  Object.entries(fields).forEach(([k,v])=>{const i=document.createElement("input");i.name=k;i.value=v;form.appendChild(i)});
  ["icu","ventilator","trauma","bloodOneg"].forEach((k,i)=>{const x=document.createElement("input");x.name=k;x.value=k==="bloodOneg"?2:1;form.appendChild(x)});
  try{createCase(s,form,u);toast("Demo emergency created.","success")}catch(e){toast(e.message,"danger")}
}
function resetDemo(){
  if(!confirm("Reset all local demo data? This clears active cases and restores seeded hospitals/ambulances."))return;
  localStorage.removeItem(STORAGE_KEY);location.reload();
}
function render(){
  processTimeouts();
  const root=document.getElementById("app"),u=currentUser();
  if(!u){root.innerHTML=loginView();bindLogin();return}
  const s=getState();
  root.innerHTML=appShell(u,s);
  bindShell(u,s);
  if(u.role==="ambulance")renderAmbulance();
  if(u.role==="hospital")renderHospital();
  if(u.role==="dispatcher")renderDispatcher();
}
function refreshCurrentPage(){
  const u=currentUser();
  if(!u)return;
  const page=document.querySelector(".nav-btn.active")?.dataset.page||"overview";
  routePage(page,u);
}
function loginView(){
 return `<div class="login"><div class="login-card">
   <div class="login-logo"><div class="brand-mark">+</div><div><h1>ERA</h1><div class="muted tiny">Emergency Resource Allocator</div></div></div>
   <h2 style="margin:0 0 6px">Sign in to operations</h2><p>One application · three role-based workspaces · shared live demo state</p>
   <form id="loginForm">
     <div class="field"><label>Username</label><input name="username" autocomplete="username" required placeholder="e.g. dispatcher"></div>
     <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
     <button class="btn btn-primary" style="width:100%;padding:11px">Sign in</button>
   </form>
   <div class="demo-users"><div class="tiny muted" style="margin-bottom:6px">Demo accounts</div>
     <div class="demo-user"><span>Dispatcher</span><span class="kbd">dispatcher / dispatch123</span></div>
     <div class="demo-user"><span>Ambulance 1–4</span><span class="kbd">ambulance1 / amb123</span></div>
     <div class="demo-user"><span>Hospital 1–4</span><span class="kbd">hospital1 / hosp123</span></div>
   </div>
 </div></div>`
}
function bindLogin(){
 document.getElementById("loginForm").onsubmit=e=>{
   e.preventDefault();const fd=new FormData(e.target),s=getState();
   const u=s.users.find(x=>x.username===fd.get("username")&&x.password===fd.get("password"));
   if(!u){toast("Invalid demo credentials.","danger");return}
   setSession({id:u.id,name:u.name,role:u.role,ambulanceId:u.ambulanceId,hospitalId:u.hospitalId,username:u.username});render();
 };
}
function appShell(u,s){
 const title=u.role==="dispatcher"?"Dispatcher Command Center":u.role==="ambulance"?`Ambulance ${u.ambulanceId}`:hospitalById(s,u.hospitalId)?.name;
 return `<div class="topbar"><div class="brand"><div class="brand-mark">+</div><div>ERA <small>Emergency Resource Allocator</small></div></div>
   <div class="top-actions"><span class="role-chip">${esc(u.name)} · ${u.role.toUpperCase()}</span><button class="btn btn-sm" id="logoutBtn">Logout</button></div></div>
   <div class="layout"><aside class="sidebar">${navForRole(u.role)}</aside><main class="content"><div id="view"></div></main></div><div class="toast-wrap" id="toasts"></div>`
}
function navForRole(role){
 const common=role==="ambulance"?[
  ["overview","◉","My Emergency"],["new","＋","New Patient"],["history","▤","Case History"]
 ]:role==="hospital"?[
  ["overview","◉","Hospital Overview"],["requests","↔","Incoming Requests"],["resources","▦","Resources"]
 ]:[
  ["overview","◉","Command Center"],["cases","⚕","Live Cases"],["hospitals","▦","Hospitals & Resources"],["simulator","⚡","Scenario Simulator"]
 ];
 return common.map((x,i)=>`<button class="nav-btn ${i===0?"active":""}" data-page="${x[0]}"><span class="nav-icon">${x[1]}</span>${x[2]}</button>`).join("")
}
function bindShell(u,s){
 document.querySelectorAll(".nav-btn").forEach(b=>b.onclick=()=>{document.querySelectorAll(".nav-btn").forEach(x=>x.classList.remove("active"));b.classList.add("active");routePage(b.dataset.page,u)});
 document.getElementById("logoutBtn").onclick=logout;
 routePage(document.querySelector(".nav-btn.active").dataset.page,u);
}
function routePage(page,u){if(u.role==="ambulance")return ambulancePage(page,u);if(u.role==="hospital")return hospitalPage(page,u);return dispatcherPage(page,u)}
function ambulancePage(page,u){const s=getState(),a=ambulanceById(s,u.ambulanceId);if(page==="new")return ambulanceNew(u,s);if(page==="history")return ambulanceHistory(u,s);return ambulanceOverview(u,s,a)}
function hospitalPage(page,u){const s=getState(),h=hospitalById(s,u.hospitalId);if(page==="requests")return hospitalRequests(u,s,h);if(page==="resources")return hospitalResources(u,s,h);return hospitalOverview(u,s,h)}
function dispatcherPage(page,u){const s=getState();if(page==="cases")return dispatcherCases(s);if(page==="hospitals")return dispatcherHospitals(s);if(page==="simulator")return dispatcherSimulator(s);return dispatcherOverview(s)}
function setView(html){document.getElementById("view").innerHTML=html;setTimeout(()=>bindDynamic(),0)}
function bindDynamic(){
 document.querySelectorAll("[data-action]").forEach(el=>el.onclick=()=>handleAction(el.dataset.action,el.dataset));
 if(document.getElementById("map"))setTimeout(initMap,20);
}
function renderAmbulance(){routePage("overview",currentUser())}
function ambulanceOverview(u,s,a){
 const c=a.currentCaseId?caseById(s,a.currentCaseId):null;
 setView(`<div class="page-title"><div><h1>Ambulance Operations</h1><p>${esc(a.id)} · Operator: ${esc(u.name)} · shared live state</p></div><button class="btn btn-primary" data-action="nav" data-target="new">+ New Emergency</button></div>
 ${c?ambulanceCaseCard(s,c,a):`<div class="card"><div class="empty"><h3>No active emergency</h3><p>Start a new patient case to trigger hospital ranking and resource allocation.</p><button class="btn btn-primary" data-action="nav" data-target="new">Create Emergency Request</button></div></div>`}`);
}
function ambulanceCaseCard(s,c,a){
 const h=c.assignedHospitalId?hospitalById(s,c.assignedHospitalId):null;
 const pending=c.pendingHospitalId?hospitalById(s,c.pendingHospitalId):null;
 const ranks=computeRankings(s,c),requests=caseRequests(s,c.id);
 return `<div class="grid grid-4">
   <div class="card"><div class="metric"><div><div class="metric-label">Patient</div><div class="value" style="font-size:20px">${esc(c.patientName)}</div></div>${severityStatus(c.severity)}</div><div class="kpi-note">${esc(c.condition)} · ${c.age} yrs</div></div>
   <div class="card"><div class="metric"><div><div class="metric-label">Case Status</div><div class="value" style="font-size:19px">${esc(c.status.replaceAll("_"," "))}</div></div>${caseStatusChip(c.status)}</div><div class="kpi-note">Updated ${fmtTime(c.updatedAt)}</div></div>
   <div class="card"><div class="metric"><div><div class="metric-label">Allocation</div><div class="value" style="font-size:19px">${h?esc(h.name):pending?esc(pending.name):"Searching"}</div></div></div><div class="kpi-note">${h?"Confirmed & reserved":pending?"Awaiting hospital response":"Dispatcher attention required"}</div></div>
   <div class="card"><div class="metric"><div><div class="metric-label">Reallocations</div><div class="value">${c.reallocationCount||0}</div></div></div><div class="kpi-note">Automatic fallback attempts</div></div>
 </div>
 <div class="grid grid-2" style="margin-top:14px">
  <div class="card"><h3>Destination & route</h3>${h?`<div class="row"><div><b>${esc(h.name)}</b><div class="muted small">${esc(h.address)}</div></div><span class="status s-green"><span class="status-dot"></span>Confirmed</span></div><div class="chips" style="margin:10px 0"><span class="chip good">Resources reserved</span><span class="chip">${distanceKm(a,h).toFixed(1)} km</span><span class="chip">ETA ${etaMinutes(distanceKm(a,h),c.severity)} min</span></div><div id="map"></div>`:`<div class="alert ${pending?"warn":"danger"}">${pending?`Request sent to <b>${esc(pending.name)}</b>. Waiting for confirmation. Re-ranking occurs automatically on timeout/rejection.`:"No confirmed destination. Dispatcher intervention may be required."}</div>`}</div>
  <div class="card"><h3>Hospital request status</h3>${requests.length?`<div class="list">${requests.map(r=>{const hh=hospitalById(s,r.hospitalId);return `<div class="list-item"><div class="row"><b>${esc(hh?.name||r.hospitalId)}</b>${requestStatus(r.status)}</div><div class="tiny muted" style="margin-top:5px">${r.status==="PENDING"&&r.expiresAt?`Response deadline in ${Math.max(0,Math.ceil((r.expiresAt-now())/1000))}s`:`${r.reason||"Attempt "+r.attempt}`}</div></div>`}).join("")}</div>`:"<div class=\"empty\">No requests yet.</div>"}<h3 style="margin-top:18px">Required resources</h3><div class="chips">${Object.entries(c.requirements).map(([k,v])=>`<span class="chip">${esc(resourceLabels[k])} ×${v}</span>`).join("")}</div></div>
 </div>
 <div class="card" style="margin-top:14px"><h3>Current ranking snapshot</h3>${rankingTable(ranks.slice(0,4),true)}</div>`
}
function ambulanceNew(u,s){
 const a=ambulanceById(s,u.ambulanceId);
 setView(`<div class="page-title"><div><h1>New Emergency</h1><p>Enter the minimum information required by the allocation engine.</p></div></div>
 <div class="card"><form id="newCaseForm"><div class="form-grid">
  <div class="field"><label>Patient name</label><input name="patientName" required placeholder="Patient / temporary ID"></div>
  <div class="field"><label>Age</label><input name="age" type="number" min="0" max="120" required value="45"></div>
  <div class="field"><label>Sex</label><select name="sex"><option>M</option><option>F</option><option>Other</option></select></div>
  <div class="field"><label>Severity</label><select name="severity"><option>CRITICAL</option><option>HIGH</option><option>MODERATE</option><option>LOW</option></select></div>
  <div class="field full"><label>Condition / emergency type</label><input name="condition" required placeholder="e.g. Road traffic trauma, cardiac arrest"></div>
  <div class="field full"><label>Incident / current location</label><input name="locationLabel" value="Ambulance current location"></div>
  <div class="field full"><label>Required resources</label><div class="grid grid-4">${resourceField("icu","ICU bed")} ${resourceField("ventilator","Ventilator")} ${resourceField("ot","Operating theatre")} ${resourceField("trauma","Trauma team")} ${resourceField("bloodOneg","O− blood")} ${resourceField("cardiology","Cardiology")} ${resourceField("neuro","Neuro")} ${resourceField("pediatric","Pediatric")}</div></div>
  <div class="field full"><label>Clinical notes</label><textarea name="notes" rows="3" placeholder="Optional context for receiving hospital"></textarea></div>
 </div><div class="alert" style="margin-bottom:12px"><b>Allocation behavior:</b> system filters mandatory resource mismatches, then scores resource match, travel time, data freshness and capacity confidence. Top hospital receives the active request; next candidates are placed on standby.</div>
 <div class="toolbar"><button class="btn btn-primary" type="submit">Submit & Start Allocation</button><button class="btn" type="button" data-action="nav" data-target="overview">Cancel</button></div></form></div>`);
 document.getElementById("newCaseForm").onsubmit=e=>{e.preventDefault();try{createCase(getState(),e.target,u);toast("Emergency created. Hospital request sent.","success");setTimeout(()=>ambulancePage("overview",u),250)}catch(err){toast(err.message,"danger")}}
}
function resourceField(k,label){return `<div><label>${label}</label><input name="${k}" type="number" min="0" max="20" value="0"></div>`}
function ambulanceHistory(u,s){
 const cases=s.cases.filter(c=>c.ambulanceId===u.ambulanceId);
 setView(`<div class="page-title"><div><h1>Case History</h1><p>All cases initiated by ${esc(u.ambulanceId)}.</p></div></div><div class="card">${cases.length?`<table><thead><tr><th>Case</th><th>Patient</th><th>Severity</th><th>Status</th><th>Hospital</th><th>Created</th></tr></thead><tbody>${cases.map(c=>`<tr><td>${c.id}</td><td>${esc(c.patientName)}</td><td>${severityStatus(c.severity)}</td><td>${caseStatusChip(c.status)}</td><td>${esc(hospitalById(s,c.assignedHospitalId)?.name||"—")}</td><td>${fmtTime(c.createdAt)}</td></tr>`).join("")}</tbody></table>`:"<div class=\"empty\">No cases yet.</div>"}</div>`);
}
function hospitalOverview(u,s,h){
 const incoming=s.requests.filter(r=>r.hospitalId===h.id&&r.status==="PENDING").length;
 const reserved=s.reservations.filter(r=>r.hospitalId===h.id&&r.status==="ACTIVE");
 setView(`<div class="page-title"><div><h1>${esc(h.name)}</h1><p>${esc(h.address)} · last update ${ageSec(h.lastUpdated)}s ago</p></div><button class="btn btn-primary" data-action="hospital-refresh">Refresh availability timestamp</button></div>
 <div class="grid grid-4">${Object.entries(h.resources).map(([k,v])=>`<div class="card"><div class="metric"><div><div class="metric-label">${esc(resourceLabels[k])}</div><div class="value">${v}</div></div>${v>0?`<span class="status s-green"><span class="status-dot"></span>Available</span>`:`<span class="status s-red"><span class="status-dot"></span>Full</span>`}</div></div>`).join("")}</div>
 <div class="grid grid-2" style="margin-top:14px"><div class="card"><h3>Incoming requests</h3><div class="value">${incoming}</div><div class="kpi-note">Pending requests requiring hospital decision</div><button class="btn" style="margin-top:12px" data-action="nav" data-target="requests">Open requests</button></div>
 <div class="card"><h3>Active reservations</h3><div class="value">${reserved.length}</div><div class="kpi-note">Resources currently held for incoming patients</div></div></div>`);
}
function hospitalRequests(u,s,h){
 const reqs=s.requests.filter(r=>r.hospitalId===h.id&&["PENDING","ACCEPTED","REJECTED","CONFLICT"].includes(r.status)).sort((a,b)=>b.createdAt-a.createdAt);
 setView(`<div class="page-title"><div><h1>Incoming Requests</h1><p>Accepting a request performs a live resource availability check and reservation.</p></div></div>
 <div class="list">${reqs.length?reqs.map(r=>hospitalRequestCard(s,r,h)).join(""):"<div class=\"card empty\">No active or recent requests.</div>"}</div>`);
}
function hospitalRequestCard(s,r,h){
 const c=caseById(s,r.caseId),amb=ambulanceById(s,c?.ambulanceId),rank=c?computeRankings(s,c).find(x=>x.hospitalId===h.id):null;
 if(!c)return "";
 return `<div class="card"><div class="row"><div><h3 style="margin-bottom:3px">${esc(c.patientName)} <span class="muted">· ${c.id}</span></h3><div class="tiny muted">${esc(c.condition)} · ${c.age} yrs · ${esc(c.ambulanceId)}</div></div>${requestStatus(r.status)}</div>
 <div class="chips" style="margin:11px 0">${Object.entries(c.requirements).map(([k,v])=>`<span class="chip ${((h.resources[k]||0)>=v)?"good":"bad"}">${esc(resourceLabels[k])} ×${v} · ${h.resources[k]||0} avail</span>`).join("")}</div>
 ${rank?`<div class="grid grid-4"><div class="alert"><b>${rank.score.toFixed(1)}</b><div class="tiny muted">allocation score</div></div><div class="alert"><b>${rank.eta} min</b><div class="tiny muted">estimated ETA</div></div><div class="alert"><b>${rank.freshScore.toFixed(0)}%</b><div class="tiny muted">freshness</div></div><div class="alert"><b>${rank.resourceScore.toFixed(0)}%</b><div class="tiny muted">resource match</div></div></div>`:""}
 ${r.status==="PENDING"?`<div class="toolbar" style="margin-top:12px"><button class="btn btn-success" data-action="accept" data-id="${r.id}">Accept & Reserve</button><button class="btn btn-danger" data-action="reject" data-id="${r.id}">Reject</button><span class="tiny muted toolbar-right">${r.expiresAt?`deadline ${Math.max(0,Math.ceil((r.expiresAt-now())/1000))}s`:""}</span></div>`:""}
 ${r.reason?`<div class="alert ${r.status==="CONFLICT"?"danger":"warn"}" style="margin-top:10px">${esc(r.reason)}</div>`:""}</div>`
}
function hospitalResources(u,s,h){
 setView(`<div class="page-title"><div><h1>Resource Management</h1><p>Change simulated capacity. Updating the timestamp improves freshness in the allocation engine.</p></div></div>
 <div class="card"><form id="resourceForm"><div class="grid grid-4">${Object.entries(h.resources).map(([k,v])=>`<div class="field"><label>${esc(resourceLabels[k])}</label><input name="${k}" type="number" min="0" max="99" value="${v}"></div>`).join("")}</div><button class="btn btn-primary">Save availability</button></form></div>`);
 document.getElementById("resourceForm").onsubmit=e=>{e.preventDefault();const ss=getState(),hh=hospitalById(ss,h.id);Object.keys(hh.resources).forEach(k=>hh.resources[k]=Math.max(0,Number(new FormData(e.target).get(k)||0)));hh.lastUpdated=now();audit(ss,"RESOURCE_UPDATE",`${hh.name} updated resource availability.`);saveState(ss,"hospital resource update");toast("Availability updated and timestamp refreshed.","success");hospitalPage("resources",u)}
}
function dispatcherOverview(s){
 const active=s.cases.filter(c=>!["COMPLETED","CANCELLED"].includes(c.status)).length;
 const pending=s.requests.filter(r=>r.status==="PENDING").length;
 const assigned=s.cases.filter(c=>c.status==="ASSIGNED").length;
 const stale=s.hospitals.filter(h=>ageSec(h.lastUpdated)>300).length;
 setView(`<div class="page-title"><div><h1>Command Center</h1><p>Central view of live emergencies, hospital capacity and allocation decisions.</p></div><div class="toolbar"><button class="btn btn-primary" data-action="demo-case">Create Demo Emergency</button><button class="btn" data-action="reset">Reset Demo</button></div></div>
 <div class="grid grid-4"><div class="card"><div class="metric"><div><div class="metric-label">Active cases</div><div class="value">${active}</div></div></div></div><div class="card"><div class="metric"><div><div class="metric-label">Awaiting confirmation</div><div class="value">${pending}</div></div></div></div><div class="card"><div class="metric"><div><div class="metric-label">Assigned / en route</div><div class="value">${assigned}</div></div></div></div><div class="card"><div class="metric"><div><div class="metric-label">Stale hospitals</div><div class="value">${stale}</div></div></div><div class="kpi-note">Freshness > 5 min</div></div></div>
 <div class="grid grid-2" style="margin-top:14px"><div class="card"><h3>Live emergency board</h3>${liveCaseList(s,5)}</div><div class="card"><h3>Ambulance fleet</h3>${ambulanceTable(s)}</div></div>
 <div class="card" style="margin-top:14px"><h3>Allocation engine</h3><div class="grid grid-4">${Object.entries(s.settings.weights).map(([k,v])=>`<div class="alert"><b>${v}%</b><div class="tiny muted">${k} factor weight</div></div>`).join("")}</div><div class="kpi-note" style="margin-top:9px">Hard resource mismatches are filtered/penalized; eligible hospitals are scored using the weighted factors above.</div></div>`);
}
function dispatcherCases(s){
 setView(`<div class="page-title"><div><h1>Live Cases</h1><p>Open a case to inspect ranking, request history, reservation and override controls.</p></div></div><div class="list">${s.cases.length?s.cases.map(c=>dispatcherCaseCard(s,c)).join(""):"<div class=\"card empty\">No cases yet. Create a demo emergency to exercise the workflow.</div>"}</div>`);
}
function dispatcherCaseCard(s,c){
 const h=c.assignedHospitalId?hospitalById(s,c.assignedHospitalId):null,p=c.pendingHospitalId?hospitalById(s,c.pendingHospitalId):null;
 return `<div class="card case-card" data-action="case-detail" data-id="${c.id}"><div class="row"><div><h3 style="margin-bottom:4px">${esc(c.patientName)} <span class="muted">· ${c.id}</span></h3><div class="tiny muted">${esc(c.condition)} · ${esc(c.ambulanceId)} · ${fmtTime(c.createdAt)}</div></div>${severityStatus(c.severity)}</div><div class="row" style="margin-top:10px"><div>${caseStatusChip(c.status)} <span class="muted small">${h?`Assigned: ${esc(h.name)}`:p?`Pending: ${esc(p.name)}`:"No destination"}</span></div><div class="tiny muted">Reallocations: ${c.reallocationCount||0}</div></div></div>`
}
function dispatcherHospitals(s){
 setView(`<div class="page-title"><div><h1>Hospitals & Resources</h1><p>Live simulated availability, freshness and capacity confidence.</p></div></div><div class="grid grid-2">${s.hospitals.map(h=>hospitalResourceCard(s,h)).join("")}</div>`);
}
function hospitalResourceCard(s,h){
 const f=freshnessLabel(h.lastUpdated),active=s.reservations.filter(r=>r.hospitalId===h.id&&r.status==="ACTIVE").length;
 return `<div class="card"><div class="row"><div><h3>${esc(h.name)}</h3><div class="tiny muted">${esc(h.address)} · ${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}</div></div><span class="status s-${f[1]}"><span class="status-dot"></span>${f[0]} · ${ageSec(h.lastUpdated)}s</span></div><div class="grid grid-4" style="margin-top:12px">${Object.entries(h.resources).map(([k,v])=>`<div class="alert"><b>${v}</b><div class="tiny muted">${esc(resourceLabels[k])}</div></div>`).join("")}</div><div class="kpi-note">Active reservations: ${active}</div></div>`
}
function dispatcherSimulator(s){
 setView(`<div class="page-title"><div><h1>Scenario Simulator</h1><p>Use these controls to demonstrate stale data, rejection, timeout, reallocation and double-booking behavior.</p></div></div>
 <div class="grid grid-2">
  <div class="card"><h3>1. Create a controlled emergency</h3><p class="small muted">Creates a critical trauma case from AMB-01. It uses the same ranking engine as the real ambulance flow.</p><button class="btn btn-primary" data-action="demo-case">Create Demo Emergency</button></div>
  <div class="card"><h3>2. Make a hospital stale</h3><p class="small muted">Sets Hospital 3's last update to 10 minutes ago. Freshness penalty becomes visible in ranking.</p><button class="btn btn-warning" data-action="make-stale" data-id="H-03">Make H-03 stale</button></div>
  <div class="card"><h3>3. Force a pending request to expire</h3><p class="small muted">Expires the oldest pending request. The normal timeout/reallocation engine will then run.</p><button class="btn btn-warning" data-action="expire-request">Expire oldest pending request</button></div>
  <div class="card"><h3>4. Double-booking test</h3><p class="small muted">Creates two simultaneous cases requiring one ICU bed at H-01, then attempts acceptance from two hospital requests. Only one reservation should succeed.</p><button class="btn btn-danger" data-action="double-book">Run double-booking test</button></div>
 </div>
 <div class="card" style="margin-top:14px"><h3>How the allocation score works</h3>${factorExplanation(s)}</div>
 <div class="card" style="margin-top:14px"><h3>Recent audit log</h3>${auditTimeline(s,15)}</div>`);
}
function factorExplanation(s){
 return `<div class="factor-row"><span>Resource match</span><div class="factor-bar"><span style="width:${s.settings.weights.resource}%"></span></div><b>${s.settings.weights.resource}%</b></div>
 <div class="factor-row"><span>Travel time</span><div class="factor-bar"><span style="width:${s.settings.weights.travel}%"></span></div><b>${s.settings.weights.travel}%</b></div>
 <div class="factor-row"><span>Data freshness</span><div class="factor-bar"><span style="width:${s.settings.weights.freshness}%"></span></div><b>${s.settings.weights.freshness}%</b></div>
 <div class="factor-row"><span>Capacity confidence</span><div class="factor-bar"><span style="width:${s.settings.weights.capacity}%"></span></div><b>${s.settings.weights.capacity}%</b></div>
 <div class="alert" style="margin-top:12px">Hospitals missing a required resource are marked ineligible and receive a strong score penalty. Critical cases also receive additional travel-time pressure. Final acceptance always re-checks real-time simulated capacity before reservation.</div>`
}
function liveCaseList(s,n){
 const arr=s.cases.filter(c=>!["COMPLETED","CANCELLED"].includes(c.status)).slice(0,n);
 return arr.length?`<div class="list">${arr.map(c=>{const h=c.assignedHospitalId?hospitalById(s,c.assignedHospitalId):c.pendingHospitalId?hospitalById(s,c.pendingHospitalId):null;return `<div class="list-item"><div class="row"><b>${esc(c.patientName)}</b>${severityStatus(c.severity)}</div><div class="tiny muted" style="margin-top:5px">${c.id} · ${c.ambulanceId} · ${caseStatusChip(c.status)} · ${h?esc(h.name):"—"}</div></div>`}).join("")}</div>`:"<div class=\"empty\">No active cases.</div>"
}
function ambulanceTable(s){
 return `<table><thead><tr><th>Ambulance</th><th>Operator</th><th>Status</th><th>Case</th></tr></thead><tbody>${s.ambulances.map(a=>`<tr><td><b>${a.id}</b></td><td>${esc(userById(s,a.operator)?.name||"—")}</td><td>${a.status==="AVAILABLE"?`<span class="status s-green"><span class="status-dot"></span>Available</span>`:`<span class="status s-blue"><span class="status-dot"></span>${a.status.replace("_"," ")}</span>`}</td><td>${a.currentCaseId||"—"}</td></tr>`).join("")}</tbody></table>`
}
function rankingTable(ranks,compact=false){
 return `<table><thead><tr><th>#</th><th>Hospital</th><th>Score</th><th>Resources</th><th>ETA</th><th>Freshness</th><th>Capacity</th><th>Eligibility</th></tr></thead><tbody>${ranks.map((r,i)=>`<tr><td><b>${i+1}</b></td><td><b>${esc(r.hospitalName)}</b><div class="score-bar"><div class="score-fill" style="width:${r.score}%"></div></div></td><td><span class="score">${r.score.toFixed(1)}</span></td><td>${r.resourceScore.toFixed(0)}%</td><td>${r.eta} min<br><span class="tiny muted">${r.km.toFixed(1)} km</span></td><td>${r.freshScore.toFixed(0)}%<br><span class="tiny muted">${r.freshnessLabel}</span></td><td>${r.capacityScore.toFixed(0)}%</td><td>${rankBadge(r)}</td></tr>`).join("")}</tbody></table>`
}
function severityStatus(x){const c=x==="CRITICAL"?"red":x==="HIGH"?"yellow":"blue";return `<span class="status s-${c}"><span class="status-dot"></span>${esc(x)}</span>`}
function caseStatusChip(x){const c=x==="ASSIGNED"?"green":x==="AWAITING_CONFIRMATION"||x==="RANKING"||x==="REALLOCATING"?"yellow":x==="NO_HOSPITAL"?"red":"blue";return `<span class="status s-${c}"><span class="status-dot"></span>${esc(x.replaceAll("_"," "))}</span>`}
function requestStatus(x){const c=x==="ACCEPTED"?"green":x==="REJECTED"||x==="CONFLICT"||x==="EXPIRED"?"red":x==="STANDBY"?"purple":"yellow";return `<span class="status s-${c}"><span class="status-dot"></span>${esc(x)}</span>`}
function auditTimeline(s,n){
 return `<div class="timeline">${s.audit.slice(0,n).map(e=>`<div class="event"><strong>${esc(e.type)}</strong> <span class="tiny muted">${fmtTime(e.ts)}</span><div>${esc(e.message)}</div></div>`).join("")}</div>`
}
function openCaseDetail(s,id){
 const c=caseById(s,id);if(!c)return;
 const ranks=computeRankings(s,c),h=c.assignedHospitalId?hospitalById(s,c.assignedHospitalId):null;
 const modal=document.createElement("div");modal.className="modal-backdrop";modal.id="caseModal";
 modal.innerHTML=`<div class="modal"><div class="modal-head"><div><h2 style="margin:0 0 5px">${esc(c.patientName)}</h2><div class="small muted">${c.id} · ${esc(c.ambulanceId)} · ${esc(c.condition)}</div></div><button class="close" id="closeModal">×</button></div>
 <div class="chips" style="margin:13px 0">${severityStatus(c.severity)} ${caseStatusChip(c.status)} ${h?`<span class="chip good">${esc(h.name)}</span>`:""}</div>
 <h3>Ranking</h3>${rankingTable(ranks)}
 <h3 style="margin-top:17px">Request history</h3>${caseRequests(s,c.id).map(r=>`<div class="list-item" style="margin-bottom:7px"><div class="row"><b>${esc(hospitalById(s,r.hospitalId)?.name||r.hospitalId)}</b>${requestStatus(r.status)}</div><div class="tiny muted">${r.reason||"Attempt "+r.attempt} · ${fmtTime(r.createdAt)}</div></div>`).join("")}
 <h3 style="margin-top:17px">Dispatcher controls</h3><div class="toolbar"><button class="btn btn-warning" data-action="override" data-id="${c.id}">Override / Reassign</button>${h?`<button class="btn btn-success" data-action="complete" data-id="${c.id}">Mark handoff complete</button>`:""}<button class="btn btn-danger" data-action="cancel" data-id="${c.id}">Cancel case</button></div>
 <h3 style="margin-top:17px">Audit trail</h3>${auditTimeline(s,10)}</div>`;
 document.body.appendChild(modal);document.getElementById("closeModal").onclick=()=>modal.remove();modal.onclick=e=>{if(e.target===modal)modal.remove()};
 modal.querySelectorAll("[data-action]").forEach(el=>el.onclick=()=>{modal.remove();handleAction(el.dataset.action,el.dataset)})
}
function initMap(){
 const s=getState(),u=currentUser(),a=u?.role==="ambulance"?ambulanceById(s,u.ambulanceId):null;
 if(!a)return;const c=a.currentCaseId?caseById(s,a.currentCaseId):null;if(!c||!c.assignedHospitalId)return;
 const h=hospitalById(s,c.assignedHospitalId);const el=document.getElementById("map");if(!el)return;
 if(mapInstance){try{mapInstance.remove()}catch(e){}mapInstance=null}
 mapInstance=L.map(el,{zoomControl:true}).setView([a.lat,a.lng],12);
 L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap contributors"}).addTo(mapInstance);
 const pts=[[a.lat,a.lng],[h.lat,h.lng]];
 routeLayer=L.polyline(pts,{color:"#36a3ff",weight:5,opacity:.85}).addTo(mapInstance);
 L.marker([a.lat,a.lng]).addTo(mapInstance).bindPopup(`<b>${esc(a.id)}</b><br>Ambulance`);
 L.marker([h.lat,h.lng]).addTo(mapInstance).bindPopup(`<b>${esc(h.name)}</b><br>Destination`);
 mapInstance.fitBounds(routeLayer.getBounds(),{padding:[25,25]});
}
function handleAction(action,data){
 const u=currentUser(),s=getState();
 if(action==="nav"){document.querySelector(`[data-page="${data.target}"]`)?.click();return}
 if(action==="hospital-refresh"){const h=hospitalById(s,u.hospitalId);h.lastUpdated=now();audit(s,"RESOURCE_UPDATE",`${h.name} refreshed availability timestamp.`);saveState(s,"refresh");toast("Availability timestamp refreshed.","success");hospitalPage("overview",u);return}
 if(action==="accept"){const res=hospitalRespond(s,data.id,"ACCEPT");toast(res.ok?"Request accepted and resources reserved.":res.reason,res.ok?"success":"danger");hospitalPage("requests",u);return}
 if(action==="reject"){const reason=prompt("Reason for rejection:","Resource unavailable");if(reason===null)return;const res=hospitalRespond(s,data.id,"REJECT",reason);toast("Request rejected; reallocation triggered if required.","success");hospitalPage("requests",u);return}
 if(action==="demo-case"){seedDemoCase();render();return}
 if(action==="reset"){resetDemo();return}
 if(action==="make-stale"){const h=hospitalById(s,data.id);h.lastUpdated=now()-10*60*1000;audit(s,"SIMULATION",`${h.name} marked stale for demonstration.`);saveState(s,"stale simulation");toast(`${h.name} is now stale.`,"success");dispatcherSimulator(s);return}
 if(action==="expire-request"){const r=s.requests.find(x=>x.status==="PENDING");if(!r){toast("No pending request to expire.","danger");return}r.expiresAt=now()-1;saveState(s,"forced expiry");processTimeouts();toast("Oldest pending request expired; reallocation processed.","success");dispatcherSimulator(getState());return}
 if(action==="double-book"){runDoubleBookingTest();return}
 if(action==="case-detail"){openCaseDetail(s,data.id);return}
 if(action==="override"){overrideCase(data.id);return}
 if(action==="complete"){completeCase(data.id);return}
 if(action==="cancel"){cancelCase(data.id);return}
}
function overrideCase(caseId){
 const s=getState(),c=caseById(s,caseId);if(!c)return;
 const candidates=computeRankings(s,c).filter(r=>!r.hardFail);
 if(!candidates.length){toast("No eligible hospitals for override.","danger");return}
 const names=candidates.map((x,i)=>`${i+1}. ${x.hospitalName} (score ${x.score.toFixed(1)})`).join("\n");
 const choice=prompt("Enter hospital number to request/assign:\n\n"+names,"1");if(choice===null)return;
 const r=candidates[Number(choice)-1];if(!r){toast("Invalid selection.","danger");return}
 s.requests.filter(x=>x.caseId===c.id&&["PENDING","STANDBY"].includes(x.status)).forEach(x=>{x.status="CANCELLED";x.respondedAt=now()});
 c.assignedHospitalId=null;c.pendingHospitalId=r.hospitalId;c.status="AWAITING_CONFIRMATION";c.updatedAt=now();
 s.requests.push({id:"REQ-"+s.meta.nextRequest++,caseId:c.id,hospitalId:r.hospitalId,status:"PENDING",createdAt:now(),expiresAt:now()+s.settings.requestTimeoutSec*1000,attempt:(c.reallocationCount||0)+1,override:true});
 audit(s,"OVERRIDE",`Dispatcher manually routed ${c.patientName} to ${r.hospitalName} for confirmation.`,c.id);saveState(s,"dispatcher override");toast("Override request sent to "+r.hospitalName,"success");render()
}
function completeCase(id){
 const s=getState(),c=caseById(s,id);if(!c)return;
 if(c.status!=="ASSIGNED"){toast("Only an assigned case can be completed.","danger");return}
 const r=reservationForCase(s,id);releaseReservation(s,c);c.status="COMPLETED";c.completedAt=now();c.updatedAt=now();
 const a=ambulanceById(s,c.ambulanceId);if(a){a.status="AVAILABLE";a.currentCaseId=null}
 audit(s,"HANDOFF",`${c.patientName} handoff completed at ${hospitalById(s,c.assignedHospitalId)?.name||"hospital"}.`,id);saveState(s,"handoff complete");toast("Handoff completed; ambulance and resources released.","success");dispatcherCases(s)
}
function cancelCase(id){
 const s=getState(),c=caseById(s,id);if(!c)return;
 if(reservationForCase(s,id))releaseReservation(s,c);
 s.requests.filter(x=>x.caseId===id&&["PENDING","STANDBY"].includes(x.status)).forEach(x=>x.status="CANCELLED");
 c.status="CANCELLED";c.updatedAt=now();const a=ambulanceById(s,c.ambulanceId);if(a){a.status="AVAILABLE";a.currentCaseId=null}
 audit(s,"CANCEL",`${c.patientName} case cancelled by dispatcher.`,id);saveState(s,"case cancelled");toast("Case cancelled.","success");dispatcherCases(s)
}
function runDoubleBookingTest(){
 const s=getState(),h=hospitalById(s,"H-01");
 // Force one ICU bed, then create two cases without assigning an existing active case.
 h.resources.icu=1;h.lastUpdated=now();
 for(let i=0;i<2;i++){
   const a=s.ambulances[i];if(a.currentCaseId)continue;
   const c={id:"CASE-"+s.meta.nextCase++,patientName:`Conflict Test ${i+1}`,age:50+i,sex:"M",severity:"CRITICAL",condition:"Simultaneous ICU request",requirements:{icu:1},ambulanceId:a.id,status:"AWAITING_CONFIRMATION",createdAt:now(),updatedAt:now(),assignedHospitalId:null,pendingHospitalId:"H-01",reallocationCount:0,location:{lat:a.lat,lng:a.lng,label:"Conflict test"}};
   s.cases.unshift(c);a.currentCaseId=c.id;a.status="ON_CASE";
   s.requests.push({id:"REQ-"+s.meta.nextRequest++,caseId:c.id,hospitalId:"H-01",status:"PENDING",createdAt:now(),expiresAt:now()+60000,attempt:1,conflictTest:true});
 }
 audit(s,"SIMULATION","Double-booking scenario created: two patients compete for one ICU bed at H-01.");
 saveState(s,"double booking setup");
 // Simulate two hospital accept attempts sequentially against fresh shared state.
 const reqs=getState().requests.filter(r=>r.hospitalId==="H-01"&&r.status==="PENDING"&&r.caseId.startsWith("CASE-"));
 let outcomes=[];
 reqs.slice(0,2).forEach(r=>{const res=hospitalRespond(getState(),r.id,"ACCEPT");outcomes.push(res.ok?"ACCEPTED":"CONFLICT / REALLOCATED")});
 toast("Double-booking test complete: "+outcomes.join(" vs "),"success");
 dispatcherSimulator(getState());
}
function toast(msg,type=""){const w=document.getElementById("toasts");if(!w)return;const t=document.createElement("div");t.className="toast "+type;t.textContent=msg;w.appendChild(t);setTimeout(()=>t.remove(),3500)}
function start(){
  if(!localStorage.getItem(STORAGE_KEY))localStorage.setItem(STORAGE_KEY,JSON.stringify(seedState));
  window.addEventListener("storage",e=>{if((e.key===STORAGE_KEY||e.key==="era_mvp_ping")&&currentUser()){refreshCurrentPage()}});
  if(refreshTimer)clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(processTimeouts())refreshCurrentPage()},2500);
  render();
}
start();
