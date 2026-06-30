import React, { useEffect, useMemo, useState } from 'react';
import { supabase, AI_FUNCTION_NAME } from './lib/supabaseClient.js';
import { BRANCH } from './branchConfig.js';

function fingerprint(text) {
  const stop = new Set(['the','and','for','with','this','that','from','into','when','then','have','been','were','will','not','are','our','was','has','but','they','you','your','service']);
  return Array.from(new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !stop.has(w)))).slice(0, 18);
}

function similarity(a, b) {
  const A = new Set(a || []); const B = new Set(b || []);
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(x => { if (B.has(x)) inter += 1; });
  return inter / new Set([...A, ...B]).size;
}

function pretty(obj) { return JSON.stringify(obj || {}, null, 2); }
function num(v, fallback = 0.5) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function textLines(v) { return String(v || '').split(/\n|,|;/).map(x => x.trim()).filter(Boolean); }

function LandingPage({ onAuth }) {
  return <div className="container landing">
    <div className="landing-copy">
      <span className="kicker">{BRANCH.kicker}</span>
      <h1>{BRANCH.product}</h1>
      <p className="lead">{BRANCH.promise}</p>
      <div className="landing-actions">
        <button onClick={() => onAuth('signup')}>Create account</button>
        <button className="secondary" onClick={() => onAuth('signin')}>Sign in</button>
      </div>
    </div>
    <div className="hero">
      <LossCard/>
      <div className="card">
        <h3>Distribution-ready promise</h3>
        <p>{BRANCH.distribution}</p>
        <div className="row">
          <span className="pill">Supabase auth + RLS</span>
          <span className="pill">OpenAI-Gemini fallback</span>
          <span className="pill">heuristic fallback</span>
        </div>
      </div>
    </div>
  </div>
}

function AuthPanel({ onReady, initialMode = 'signin', onBack }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    const fn = mode === 'signup' ? supabase.auth.signUp : supabase.auth.signInWithPassword;
    const { data, error } = await fn.call(supabase.auth, { email, password });
    setBusy(false);
    if (error) return setError(error.message);
    if (data?.user || data?.session) onReady();
  }

  return <div className="auth card">
    <div className="kicker">TraceCrumb Deployable</div>
    <h2>{BRANCH.product}</h2>
    <p>{BRANCH.promise}</p>
    <form className="form-grid" onSubmit={submit}>
      <label>Email<input value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@company.com" /></label>
      <label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="minimum 6 characters" /></label>
      {error && <p className="loss">{error}</p>}
      <button disabled={busy}>{busy ? 'Working...' : mode === 'signup' ? 'Create account' : 'Sign in'}</button>
      <button className="secondary" type="button" onClick={()=>setMode(mode === 'signup' ? 'signin' : 'signup')}>{mode === 'signup' ? 'Have an account? Sign in' : 'Need access? Create account'}</button>
      <button className="secondary" type="button" onClick={onBack}>Back to landing</button>
    </form>
  </div>
}

async function ensureOrg(user) {
  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id, orgs(id,name)')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  if (membership?.org_id) return { id: membership.org_id, name: membership.orgs?.name || 'TraceCrumb Org' };

  const defaultName = `${(user.email || 'TraceCrumb').split('@')[0]} Ops`;
  const { data: org, error: orgError } = await supabase
    .from('orgs')
    .insert({ name: defaultName, created_by: user.id })
    .select('id,name')
    .single();
  if (orgError) throw orgError;
  const { error: memberError } = await supabase
    .from('org_members')
    .insert({ org_id: org.id, user_id: user.id, role: 'owner' });
  if (memberError) throw memberError;
  return org;
}

function Header({ user, org, signOut }) {
  return <div className="header">
    <div className="brand">
      <span className="kicker">{BRANCH.kicker}</span>
      <h1>{BRANCH.product}</h1>
      <p>{BRANCH.promise}</p>
    </div>
    <div className="row">
      <span className="pill">{org?.name || 'No org'}</span>
      <span className="pill">{user?.email}</span>
      <button className="secondary" onClick={signOut}>Sign out</button>
    </div>
  </div>
}

async function callAI(branch, action, payload) {
  const { data, error } = await supabase.functions.invoke(AI_FUNCTION_NAME, { body: { branch, action, payload } });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'AI function failed');
  return data;
}

function LossCard() {
  return <div className="card">
    <h3>Loss-aversion wedge</h3>
    <p><b className="loss">Pain:</b> {BRANCH.pain}</p>
    <p><b className="loss">Loss prevented:</b> {BRANCH.loss}</p>
    <p><b className="ok">Proof metric:</b> {BRANCH.proofMetric}</p>
  </div>
}

function First60({ user, org }) {
  const [form, setForm] = useState({ title:'', service_name:'', severity:'high', symptom_text:'', impact:'', signals:'' });
  const [incidents, setIncidents] = useState([]);
  const [output, setOutput] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const { data } = await supabase.from('incidents').select('*').eq('org_id', org.id).order('created_at', { ascending:false }).limit(20);
    setIncidents(data || []);
  }
  useEffect(() => { load(); }, [org?.id]);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(''); setOutput(null);
    try {
      const fp = fingerprint(`${form.title} ${form.symptom_text} ${form.signals} ${form.impact}`);
      const similar = incidents.map(i => ({ id:i.id, title:i.title, service:i.service_name, score: similarity(fp, i.fingerprint), symptom:i.symptom_text, ai_summary:i.ai_summary })).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,5);
      const { data: incident, error: insErr } = await supabase.from('incidents').insert({
        org_id: org.id, created_by: user.id, title: form.title || 'Live incident', service_name: form.service_name || 'unknown-service', severity: form.severity,
        symptom_text: form.symptom_text, impact: form.impact, signals: { raw: form.signals }, fingerprint: fp
      }).select('*').single();
      if (insErr) throw insErr;
      const ai = await callAI('first60', 'first_diagnostic_branch', { ...form, fingerprint: fp, similar_incidents: similar });
      const result = ai.result || {};
      await supabase.from('incident_recommendations').insert({
        org_id: org.id, incident_id: incident.id, suggested_branch: result.suggested_branch || 'Validate recent changes and dependencies first.',
        priority_checks: result.priority_checks || [], loss_prevention_reason: result.loss_prevention_reason || '', confidence: num(result.confidence), provider: ai.provider, raw_response: result
      });
      await supabase.from('incidents').update({ ai_summary: result }).eq('id', incident.id);
      setOutput({ incident, similar, provider: ai.provider, recommendation: result });
      setForm({ title:'', service_name:'', severity:'high', symptom_text:'', impact:'', signals:'' });
      await load();
    } catch (err) { setError(err.message || String(err)); }
    setBusy(false);
  }

  async function saveOutcome(outcome) {
    if (!output?.incident?.id) return;
    const recs = await supabase.from('incident_recommendations').select('id').eq('incident_id', output.incident.id).limit(1).maybeSingle();
    await supabase.from('recommendation_outcomes').insert({ org_id: org.id, incident_id: output.incident.id, recommendation_id: recs.data?.id, adopted: true, outcome, notes: `Marked ${outcome} from MVP UI.` });
    await load();
  }

  return <div className="grid">
    <div className="card"><h2>First-60 diagnostic capture</h2><form className="form-grid" onSubmit={submit}>
      <label>Incident title<input value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="Checkout latency spike after deploy" /></label>
      <label>Service<input value={form.service_name} onChange={e=>setForm({...form,service_name:e.target.value})} placeholder="payments-api" /></label>
      <label>Severity<select value={form.severity} onChange={e=>setForm({...form,severity:e.target.value})}><option>low</option><option>medium</option><option>high</option><option>critical</option></select></label>
      <label>Symptoms<textarea required value={form.symptom_text} onChange={e=>setForm({...form,symptom_text:e.target.value})} placeholder="Error rate jumped, 5xx concentrated on POST /charge, queue depth rising..." /></label>
      <label>Signals / recent changes<textarea value={form.signals} onChange={e=>setForm({...form,signals:e.target.value})} placeholder="Last deploy 14m ago; Redis CPU high; auth dependency stable..." /></label>
      <label>Impact<textarea value={form.impact} onChange={e=>setForm({...form,impact:e.target.value})} placeholder="EU customers unable to checkout" /></label>
      {error && <p className="loss">{error}</p>}
      <button disabled={busy}>{busy ? 'Generating branch...' : 'Generate first diagnostic branch'}</button>
    </form></div>
    <div className="card"><h2>Recommendation</h2>{output ? <>
      <div className="row"><span className="pill">provider: {output.provider}</span><span className="pill">similar: {output.similar.length}</span></div>
      <pre className="output">{pretty(output.recommendation)}</pre>
      <div className="row"><button onClick={()=>saveOutcome('successful')}>Marked useful</button><button className="secondary" onClick={()=>saveOutcome('partial')}>Partial</button><button className="danger" onClick={()=>saveOutcome('failed')}>Wrong branch</button></div>
    </> : <p>Submit an incident to generate the first branch and preserve the decision trace.</p>}</div>
    <div className="card" style={{gridColumn:'1 / -1'}}><h2>Recent incident memory</h2><div className="list">{incidents.map(i=><div className="item" key={i.id}><strong>{i.title}</strong><p>{i.service_name} · {i.severity} · {new Date(i.created_at).toLocaleString()}</p><p>{i.symptom_text}</p></div>)}</div></div>
  </div>
}

function Resume({ user, org }) {
  const [form, setForm] = useState({ title:'', objective:'', task_ref:'', active_state:'', interruption_type:'context_switch', source_context:'', open_threads:'', dependencies:'', recent_decisions:'' });
  const [bundles, setBundles] = useState([]); const [output, setOutput] = useState(null); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  async function load(){ const {data}=await supabase.from('resume_bundles').select('*, work_blocks(title, task_ref)').eq('org_id',org.id).order('created_at',{ascending:false}).limit(20); setBundles(data||[]); }
  useEffect(()=>{load();},[org?.id]);
  async function submit(e){ e.preventDefault(); setBusy(true); setError(''); setOutput(null); try{
    const {data:block,error:blockErr}=await supabase.from('work_blocks').insert({org_id:org.id,created_by:user.id,...form}).select('*').single(); if(blockErr) throw blockErr;
    if(form.source_context) await supabase.from('context_fragments').insert({org_id:org.id,work_block_id:block.id,source_type:'note',content:form.source_context,source_ref:form.task_ref,importance:.8});
    const ai=await callAI('resume','context_restoration_bundle',form); const result=ai.result||{};
    const {data:bundle,error:bErr}=await supabase.from('resume_bundles').insert({org_id:org.id,work_block_id:block.id,bundle:result,confidence:num(result.confidence),provider:ai.provider}).select('*').single(); if(bErr) throw bErr;
    setOutput({block,bundle,result,provider:ai.provider}); setForm({ title:'', objective:'', task_ref:'', active_state:'', interruption_type:'context_switch', source_context:'', open_threads:'', dependencies:'', recent_decisions:'' }); await load();
  }catch(err){setError(err.message||String(err));} setBusy(false); }
  async function mark(minutes){ if(!output?.block) return; await supabase.from('restoration_events').insert({org_id:org.id,work_block_id:output.block.id,resume_bundle_id:output.bundle.id,minutes_to_first_output:minutes,notes:'Marked from MVP UI'}); await load(); }
  return <div className="grid"><div className="card"><h2>Context restoration bundle</h2><form className="form-grid" onSubmit={submit}>
    <label>Work block title<input value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="Finish auth/RLS migration" /></label>
    <label>Objective<textarea required value={form.objective} onChange={e=>setForm({...form,objective:e.target.value})} placeholder="What outcome matters when you return?" /></label>
    <label>Task / PR / ticket ref<input value={form.task_ref} onChange={e=>setForm({...form,task_ref:e.target.value})} placeholder="GH#42 / Linear ENG-19" /></label>
    <label>Current state<textarea value={form.active_state} onChange={e=>setForm({...form,active_state:e.target.value})} placeholder="What is already done? What is still unstable?" /></label>
    <label>Interruption type<select value={form.interruption_type} onChange={e=>setForm({...form,interruption_type:e.target.value})}><option>context_switch</option><option>meeting</option><option>overnight</option><option>incident</option><option>handoff</option><option>other</option></select></label>
    <label>Source context<textarea value={form.source_context} onChange={e=>setForm({...form,source_context:e.target.value})} placeholder="Paste Slack/Jira/GitHub notes. Keep secrets out." /></label>
    <label>Open threads<textarea value={form.open_threads} onChange={e=>setForm({...form,open_threads:e.target.value})} /></label>
    <label>Dependencies<textarea value={form.dependencies} onChange={e=>setForm({...form,dependencies:e.target.value})} /></label>
    <label>Recent decisions<textarea value={form.recent_decisions} onChange={e=>setForm({...form,recent_decisions:e.target.value})} /></label>
    {error && <p className="loss">{error}</p>}<button disabled={busy}>{busy?'Generating restore state...':'Generate Resume Work bundle'}</button>
  </form></div><div className="card"><h2>Resume output</h2>{output?<><div className="row"><span className="pill">provider: {output.provider}</span><span className="pill">TTFMO target: &lt; 5 min</span></div><pre className="output">{pretty(output.result)}</pre><div className="row"><button onClick={()=>mark(5)}>First output ≤5m</button><button className="secondary" onClick={()=>mark(15)}>≤15m</button><button className="danger" onClick={()=>mark(30)}>30m+</button></div></>:<p>Generate a bundle before stopping work; use it when returning.</p>}</div><div className="card" style={{gridColumn:'1 / -1'}}><h2>Recent resume bundles</h2><div className="list">{bundles.map(b=><div className="item" key={b.id}><strong>{b.work_blocks?.title || 'Work block'}</strong><p>{new Date(b.created_at).toLocaleString()} · confidence {b.confidence}</p><pre className="output">{pretty(b.bundle)}</pre></div>)}</div></div></div>
}

function Handoff({ user, org }) {
  const [form,setForm]=useState({workflow_ref:'',from_actor:'',to_actor:'',state:'',intent:'',constraints:'',open_unknowns:'',dependencies:'',risks:'',continuation_path:''});
  const [packets,setPackets]=useState([]); const [output,setOutput]=useState(null); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  async function load(){const{data}=await supabase.from('handoff_packets').select('*').eq('org_id',org.id).order('created_at',{ascending:false}).limit(20);setPackets(data||[])}
  useEffect(()=>{load()},[org?.id]);
  async function submit(e){e.preventDefault();setBusy(true);setError('');setOutput(null);try{const ai=await callAI('handoff','continuity_handoff_packet',form);const result=ai.result||{};const{data,error:pErr}=await supabase.from('handoff_packets').insert({org_id:org.id,created_by:user.id,workflow_ref:form.workflow_ref,from_actor:form.from_actor||'sender',to_actor:form.to_actor||'receiver',packet:result,status:'sent'}).select('*').single();if(pErr)throw pErr;setOutput({packet:data,result,provider:ai.provider});setForm({workflow_ref:'',from_actor:'',to_actor:'',state:'',intent:'',constraints:'',open_unknowns:'',dependencies:'',risks:'',continuation_path:''});await load();}catch(err){setError(err.message||String(err));}setBusy(false)}
  async function mark(recontact,score){if(!output?.packet)return;await supabase.from('handoff_outcomes').insert({org_id:org.id,handoff_packet_id:output.packet.id,recontact_required:recontact,continuity_score:score,notes:recontact?'Receiver required clarification':'Receiver continued without re-contact'});await load()}
  return <div className="grid"><div className="card"><h2>Operational handoff packet</h2><form className="form-grid" onSubmit={submit}>
    <label>Workflow / incident ref<input value={form.workflow_ref} onChange={e=>setForm({...form,workflow_ref:e.target.value})} placeholder="INC-1042 / Shift A→B" /></label><div className="grid"><label>From<input value={form.from_actor} onChange={e=>setForm({...form,from_actor:e.target.value})} /></label><label>To<input value={form.to_actor} onChange={e=>setForm({...form,to_actor:e.target.value})} /></label></div>
    <label>Current state<textarea required value={form.state} onChange={e=>setForm({...form,state:e.target.value})} /></label><label>Intent/rationale<textarea required value={form.intent} onChange={e=>setForm({...form,intent:e.target.value})} /></label><label>Constraints<textarea value={form.constraints} onChange={e=>setForm({...form,constraints:e.target.value})} /></label><label>Open unknowns<textarea value={form.open_unknowns} onChange={e=>setForm({...form,open_unknowns:e.target.value})} /></label><label>Dependencies<textarea value={form.dependencies} onChange={e=>setForm({...form,dependencies:e.target.value})} /></label><label>Risks<textarea value={form.risks} onChange={e=>setForm({...form,risks:e.target.value})} /></label><label>Suggested continuation path<textarea value={form.continuation_path} onChange={e=>setForm({...form,continuation_path:e.target.value})} /></label>{error&&<p className="loss">{error}</p>}<button disabled={busy}>{busy?'Building packet...':'Generate handoff packet'}</button>
  </form></div><div className="card"><h2>Handoff output</h2>{output?<><div className="row"><span className="pill">provider: {output.provider}</span><span className="pill">primary metric: re-contact</span></div><pre className="output">{pretty(output.result)}</pre><div className="row"><button onClick={()=>mark(false,.9)}>No re-contact</button><button className="danger" onClick={()=>mark(true,.35)}>Re-contact needed</button></div></>:<p>Generate a packet that transfers intent, uncertainty, dependency state, and next action.</p>}</div><div className="card" style={{gridColumn:'1 / -1'}}><h2>Recent handoffs</h2><div className="list">{packets.map(p=><div className="item" key={p.id}><strong>{p.workflow_ref || 'Handoff'}</strong><p>{p.from_actor} → {p.to_actor} · {new Date(p.created_at).toLocaleString()}</p><pre className="output">{pretty(p.packet)}</pre></div>)}</div></div></div>
}

function Continuity({ user, org }) {
  const [form,setForm]=useState({workflow_name:'',meeting_type:'status_sync',original_meeting_frequency:'weekly',current_state:'',decisions_needed:'',blockers:'',owners:'',restoration_capacity:.5,handoff_integrity:.5,coordination_persistence:.5,decision_memory_density:.5,dependency_resilience:.5,interruption_sensitivity:.5});
  const [items,setItems]=useState([]); const [output,setOutput]=useState(null); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  async function load(){const{data}=await supabase.from('coordination_artifacts').select('*').eq('org_id',org.id).order('created_at',{ascending:false}).limit(20);setItems(data||[])}
  useEffect(()=>{load()},[org?.id]);
  const eci=useMemo(()=>{const r=num(form.restoration_capacity),h=num(form.handoff_integrity),c=num(form.coordination_persistence),d=num(form.decision_memory_density),dep=num(form.dependency_resilience),i=num(form.interruption_sensitivity); return Math.max(0,Math.min(1,(.25*r)+(.25*h)+(.20*c)+(.15*d)+(.10*dep)+(.05*(1-i))));},[form]);
  async function submit(e){e.preventDefault();setBusy(true);setError('');setOutput(null);try{const payload={...form,eci_score:eci};const ai=await callAI('continuity','async_coordination_and_eci',payload);const result=ai.result||{};const sub=result.meeting_substitution_verdict==='high'?'high':result.meeting_substitution_verdict==='low'?'low':'partial';const{data,error:aErr}=await supabase.from('coordination_artifacts').insert({org_id:org.id,created_by:user.id,workflow_name:form.workflow_name,meeting_type:form.meeting_type,original_meeting_frequency:form.original_meeting_frequency,substitutability:sub,artifact:result,status:'trial'}).select('*').single();if(aErr)throw aErr;await supabase.from('eci_snapshots').insert({org_id:org.id,workflow_name:form.workflow_name,restoration_capacity:num(form.restoration_capacity),handoff_integrity:num(form.handoff_integrity),coordination_persistence:num(form.coordination_persistence),decision_memory_density:num(form.decision_memory_density),dependency_resilience:num(form.dependency_resilience),interruption_sensitivity:num(form.interruption_sensitivity),eci_score:eci,raw_inputs:payload});setOutput({artifact:data,result,provider:ai.provider,eci});await load();}catch(err){setError(err.message||String(err));}setBusy(false)}
  function range(name,label){return <label>{label}: {form[name]}<input type="range" min="0" max="1" step="0.05" value={form[name]} onChange={e=>setForm({...form,[name]:e.target.value})}/></label>}
  return <div className="grid"><div className="card"><h2>Async coordination + ECI</h2><form className="form-grid" onSubmit={submit}><label>Workflow name<input required value={form.workflow_name} onChange={e=>setForm({...form,workflow_name:e.target.value})} placeholder="Platform deploy readiness" /></label><label>Meeting type<select value={form.meeting_type} onChange={e=>setForm({...form,meeting_type:e.target.value})}><option value="broadcast">broadcast</option><option value="status_sync">status sync</option><option value="decision_resolution">decision resolution</option><option value="incident_sync">incident sync</option><option value="architecture_sync">architecture sync</option><option value="conflict_resolution">conflict resolution</option><option value="novel_reasoning">novel reasoning</option><option value="other">other</option></select></label><label>Meeting frequency<input value={form.original_meeting_frequency} onChange={e=>setForm({...form,original_meeting_frequency:e.target.value})}/></label><label>Current state<textarea required value={form.current_state} onChange={e=>setForm({...form,current_state:e.target.value})}/></label><label>Decisions needed<textarea value={form.decisions_needed} onChange={e=>setForm({...form,decisions_needed:e.target.value})}/></label><label>Blockers<textarea value={form.blockers} onChange={e=>setForm({...form,blockers:e.target.value})}/></label><label>Owners<textarea value={form.owners} onChange={e=>setForm({...form,owners:e.target.value})}/></label>{range('restoration_capacity','Restoration capacity')}{range('handoff_integrity','Handoff integrity')}{range('coordination_persistence','Coordination persistence')}{range('decision_memory_density','Decision memory density')}{range('dependency_resilience','Dependency resilience')}{range('interruption_sensitivity','Interruption sensitivity')}<div className="pill">ECI preview: {eci.toFixed(2)}</div>{error&&<p className="loss">{error}</p>}<button disabled={busy}>{busy?'Generating artifact...':'Generate coordination artifact'}</button></form></div><div className="card"><h2>Continuity output</h2>{output?<><div className="metric"><div><span>ECI</span><b>{output.eci.toFixed(2)}</b></div><div><span>Provider</span><b>{output.provider}</b></div><div><span>Mode</span><b>trial</b></div></div><pre className="output">{pretty(output.result)}</pre></>:<p>Generate a persistent coordination artifact and continuity score before replacing a meeting.</p>}</div><div className="card" style={{gridColumn:'1 / -1'}}><h2>Recent coordination artifacts</h2><div className="list">{items.map(i=><div className="item" key={i.id}><strong>{i.workflow_name}</strong><p>{i.meeting_type} · substitutability {i.substitutability} · {new Date(i.created_at).toLocaleString()}</p><pre className="output">{pretty(i.artifact)}</pre></div>)}</div></div></div>
}

export default function App() {
  const [session, setSession] = useState(null); const [org,setOrg]=useState(null); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  const [authMode, setAuthMode] = useState(null);
  async function boot(){ setLoading(true); setError(''); try{ const {data:{session}}=await supabase.auth.getSession(); setSession(session); if(session?.user){ const orgObj=await ensureOrg(session.user); setOrg(orgObj); } }catch(err){setError(err.message||String(err));} setLoading(false); }
  useEffect(()=>{ boot(); const {data:{subscription}}=supabase.auth.onAuthStateChange(()=>boot()); return ()=>subscription.unsubscribe(); },[]);
  async function signOut(){ await supabase.auth.signOut(); setSession(null); setOrg(null); }
  if(loading) return <div className="container"><div className="card">Loading TraceCrumb...</div></div>;
  if(!session && !authMode) return <LandingPage onAuth={setAuthMode}/>;
  if(!session) return <AuthPanel onReady={boot} initialMode={authMode} onBack={() => setAuthMode(null)}/>;
  return <div className="container"><Header user={session.user} org={org} signOut={signOut}/>{error&&<div className="card"><p className="loss">{error}</p></div>}<div className="hero"><LossCard/><div className="card"><h3>Distribution-ready promise</h3><p>{BRANCH.distribution}</p><div className="row"><span className="pill">Supabase auth + RLS</span><span className="pill">OpenAI→Gemini fallback</span><span className="pill">heuristic fallback</span></div></div></div>{BRANCH.id==='first60'&&<First60 user={session.user} org={org}/>} {BRANCH.id==='resume'&&<Resume user={session.user} org={org}/>} {BRANCH.id==='handoff'&&<Handoff user={session.user} org={org}/>} {BRANCH.id==='continuity'&&<Continuity user={session.user} org={org}/>}</div>;
}
