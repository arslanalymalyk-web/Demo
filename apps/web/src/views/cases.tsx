import { useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type CaseDetail, type CaseListRow, type EvidenceRow, type Me, type Reviewer, type RunSummary } from "../api";
import { Async, Card, CaseState, DataClass, PageHead, PolicyBadge, RuleList, Status, Table, useAction, useApi } from "../components";
import { dateTime, titleCase } from "../format";

const ACTIONS: Record<string, string> = { monitor: "Monitor (no external action)", advisory: "Advisory (a recommendation to decision-makers)", handoff: "Handoff (a task for a person, in the institution's own systems)" };

export function CaseList({ can }: { can: (p: string) => boolean }): ReactNode {
  const [state, setState] = useState("");
  const list = useApi<CaseListRow[]>(`/v1/cases${state ? `?state=${state}` : ""}`);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead title="Cases" aside={can("case.write") ? <button className="primary" onClick={() => setOpen(!open)}>{open ? "Close form" : "Open a case"}</button> : null}>
        A case carries one question from signal to a recorded, authorized human decision. Evidence, scenarios, policy results and decisions stay together.
      </PageHead>
      {open ? <NewCase onDone={id => { location.hash = `#/cases/${id}`; }} /> : null}
      <div className="row" style={{ margin: "0 0 14px" }}>
        <label>State<select value={state} onChange={e => setState(e.target.value)}><option value="">All</option>{["open", "analysis", "in_review", "decided", "closed"].map(s => <option key={s} value={s}>{titleCase(s)}</option>)}</select></label>
      </div>
      <Async state={list} empty={d => d.length === 0}>{rows => (
        <Table label="Cases"><thead><tr><th>Case</th><th>Domain</th><th>State</th><th>Sensitivity</th><th>Updated</th></tr></thead>
          <tbody>{rows.map(r => <tr key={r.id}><td><a href={`#/cases/${r.id}`}><span className="mono">{r.case_key}</span> {r.title}</a></td><td>{r.domain}</td><td><CaseState value={r.state} /></td><td>{r.sensitivity === "restricted" ? <span className="badge b-warn">Restricted</span> : "Internal"}</td><td>{dateTime(r.updated_at)}</td></tr>)}</tbody></Table>
      )}</Async>
    </>
  );
}

function NewCase({ onDone }: { onDone: (id: string) => void }): ReactNode {
  const [f, setF] = useState({ title: "", objective: "", domain: "energy", sensitivity: "internal" });
  const a = useAction(() => {});
  const submit = async (e: FormEvent) => { e.preventDefault(); let id = ""; if (await a.run(async () => { id = (await api<{ id: string }>("/v1/cases", { method: "POST", body: f })).id; })) onDone(id); };
  return (
    <Card title="Open a case">
      <form className="stack" onSubmit={submit}>
        <label>Title<input type="text" required minLength={3} value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></label>
        <label>Objective: what decision will this inform?<textarea required minLength={3} value={f.objective} onChange={e => setF({ ...f, objective: e.target.value })} /></label>
        <div className="row"><label>Domain<select value={f.domain} onChange={e => setF({ ...f, domain: e.target.value })}>{["energy", "sovereign capital", "treasury", "banking", "infrastructure"].map(d => <option key={d}>{d}</option>)}</select></label>
          <label>Sensitivity<select value={f.sensitivity} onChange={e => setF({ ...f, sensitivity: e.target.value })}><option value="internal">Internal</option><option value="restricted">Restricted: participants only</option></select></label></div>
        {a.error ? <div className="note err" role="alert">{a.error}</div> : null}
        <button className="primary" disabled={a.busy}>Open case</button>
      </form>
    </Card>
  );
}

const TABS = ["Situation", "Evidence", "Scenarios", "Options", "Decision & Memory", "Activity"] as const;

export function CaseWorkspace({ id, me }: { id: string; me: Me }): ReactNode {
  const c = useApi<CaseDetail>(`/v1/cases/${id}`);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Situation");
  return (
    <Async state={c}>{d => {
      const need = d.activePolicy?.authority ?? {};
      return <>
        <PageHead title={`${d.caseKey} · ${d.title}`} aside={<a className="btn" href="#/cases">All cases</a>}>{d.objective}</PageHead>
        <dl className="authority" aria-label="Authority and policy">
          <div><dt>State</dt><dd><CaseState value={d.state} /> {d.disposition ? <span className="badge b-plain">{titleCase(d.disposition)}</span> : null}</dd></div>
          <div><dt>Owner</dt><dd>{d.owner?.name ?? "—"}</dd></div>
          <div><dt>Named reviewer</dt><dd>{d.reviewer?.name ?? "Not yet assigned"}</dd></div>
          <div><dt>Policy in force</dt><dd>{d.activePolicy ? `${d.activePolicy.key} v${d.activePolicy.version}` : <span className="badge b-bad">None active</span>}</dd></div>
          <div><dt>Authority required</dt><dd className="small">{Object.entries(need).map(([k, v]) => <div key={k}>{k}: {v.join(" or ")}</div>)}</dd></div>
          <div><dt>Sensitivity</dt><dd>{d.sensitivity === "restricted" ? <span className="badge b-warn">Restricted</span> : "Internal"}</dd></div>
          {d.hold ? <div><dt>Retention</dt><dd><span className="badge b-bad">Legal hold</span></dd></div> : null}
        </dl>
        <div className="tabs" role="tablist" aria-label="Case workspace">
          {TABS.map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        <div role="tabpanel" aria-label={tab}>
          {tab === "Situation" ? <Situation d={d} me={me} reload={c.reload} /> : null}
          {tab === "Evidence" ? <EvidenceTab d={d} me={me} reload={c.reload} /> : null}
          {tab === "Scenarios" ? <ScenariosTab d={d} me={me} reload={c.reload} /> : null}
          {tab === "Options" ? <OptionsTab d={d} me={me} reload={c.reload} /> : null}
          {tab === "Decision & Memory" ? <DecisionTab d={d} me={me} reload={c.reload} /> : null}
          {tab === "Activity" ? <Activity d={d} /> : null}
        </div>
      </>;
    }}</Async>
  );
}

function RetentionCard({ d, me, reload }: { d: CaseDetail; me: Me; reload: () => void }): ReactNode {
  const a = useAction(reload), [why, setWhy] = useState(""), [purpose, setPurpose] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const canHold = me.permissions.includes("retention.manage"), canExport = me.permissions.includes("export.run");
  if (!canHold && !canExport && !d.hold) return null;
  async function download() {
    setBusy(true); setErr(null);
    try {
      const b = await api<unknown>(`/v1/cases/${d.id}/export`, { method: "POST", body: { purpose } });
      const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 1)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `${d.caseKey}-export.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000); setPurpose("");
    } catch (e) { setErr(e instanceof ApiError ? e.message : "The export failed."); } finally { setBusy(false); }
  }
  return (
    <Card title="Retention" aside={<span className="small muted">Nothing here deletes anything</span>}>
      {d.hold ? <div className="note err" role="status"><strong>Legal hold.</strong> {d.hold.reason}<div className="small">Placed {dateTime(d.hold.placedAt)}</div></div> : <p className="small muted">This case is kept for ten years with its decisions and audit trail. A hold marks it as protected from any future clean-up.</p>}
      {canHold ? <form className="stack" onSubmit={e => { e.preventDefault(); void a.run(() => api(`/v1/cases/${d.id}/${d.hold ? "release" : "hold"}`, { method: "POST", body: { reason: why } })).then(ok => ok && setWhy("")); }}>
        <label>{d.hold ? "Why the hold is released" : "Why a hold is needed"}<textarea required minLength={10} value={why} onChange={e => setWhy(e.target.value)} /></label>
        <button disabled={a.busy}>{d.hold ? "Release the hold" : "Place a hold"}</button>{a.error ? <div className="note err" role="alert">{a.error}</div> : null}</form> : null}
      {canExport ? <form className="stack" style={{ marginTop: 12 }} onSubmit={e => { e.preventDefault(); void download(); }}>
        <label>Export this case: what is it for?<input type="text" required minLength={10} value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="e.g. annual audit sample, ticket 8812" /></label>
        <button disabled={busy}>Download the record</button><span className="small muted">A complete record with its audit events and a hash that proves it was not altered. The export is itself recorded.</span>{err ? <div className="note err" role="alert">{err}</div> : null}</form> : null}
    </Card>
  );
}

function Situation({ d, me, reload }: { d: CaseDetail; me: Me; reload: () => void }): ReactNode {
  const a = useAction(reload);
  const [why, setWhy] = useState("");
  const mine = d.owner?.id === me.id;
  return (
    <div className="grid g2">
      <Card title="What this case is">
        <p>{d.objective}</p>
        <dl className="prov"><div><dt>Domain</dt><dd>{d.domain}</dd></div><div><dt>Opened</dt><dd>{dateTime(d.createdAt)}</dd></div><div><dt>Last updated</dt><dd>{dateTime(d.updatedAt)}</dd></div><div><dt>Version</dt><dd>{d.version}</dd></div></dl>
        <h3 style={{ margin: "16px 0 6px" }}>Starting snapshot</h3>
        <p className="small muted">Frozen when the case was opened. The graph the analysis started from can always be recovered.</p>
        <p className="small mono">graph {d.startSnapshot.graphHash.slice(0, 20)}… · {d.startSnapshot.entities} entities · {d.startSnapshot.relationships} links</p>
        <h3 style={{ margin: "16px 0 6px" }}>Participants</h3>
        <div className="row">{d.participants.map(p => <span key={p.id} className="badge b-plain">{p.name} · {p.role}</span>)}</div>
      </Card>
      <Card title="Next step">
        {d.state === "open" ? <p>Attach evidence, then start analysis.</p> : null}
        {d.state === "analysis" ? <p>Build options in the Options tab, then submit them to a named reviewer.</p> : null}
        {d.state === "in_review" ? <p>Waiting for {d.reviewer?.name ?? "the reviewer"} to decide.</p> : null}
        {d.state === "decided" ? <p>A decision is recorded. Complete any handoffs, then close the case to write it to institutional memory.</p> : null}
        {d.state === "closed" ? <p>This case is closed and cannot change.</p> : null}
        {mine && d.state === "open" ? <div style={{ marginBottom: 12 }}><button className="primary" disabled={a.busy} onClick={() => void a.run(() => api(`/v1/cases/${d.id}/start`, { method: "POST", body: {} }))}>Start analysis</button></div> : null}
        {mine && (d.state === "open" || d.state === "analysis") ? (
          <details><summary>Dismiss this case</summary>
            <form className="stack" onSubmit={e => { e.preventDefault(); void a.run(() => api(`/v1/cases/${d.id}/close`, { method: "POST", body: { rationale: why } })); }}>
              <label>Why is it not actionable?<textarea required minLength={10} value={why} onChange={e => setWhy(e.target.value)} /></label><button disabled={a.busy}>Dismiss</button></form></details>
        ) : null}
        {a.error ? <div className="note err" role="alert" style={{ marginTop: 10 }}>{a.error}</div> : null}
      </Card>
      <RetentionCard d={d} me={me} reload={reload} />
    </div>
  );
}

function EvidenceTab({ d, me, reload }: { d: CaseDetail; me: Me; reload: () => void }): ReactNode {
  const ev = useApi<EvidenceRow[]>(me.permissions.includes("case.write") && ["open", "analysis"].includes(d.state) ? "/v1/evidence?limit=100" : null);
  const a = useAction(reload);
  const [pick, setPick] = useState(""), [role, setRole] = useState("supports"), [note, setNote] = useState("");
  const attached = new Set(d.evidence.map(e => e.id));
  return (
    <div className="grid">
      <Card title="Evidence on this case" aside={<span className="small muted">Attached evidence is never overwritten</span>}>
        {d.evidence.length === 0 ? <div className="empty">No evidence attached yet.</div> : (
          <Table label="Case evidence"><thead><tr><th>Record</th><th>Source</th><th>Validation</th><th>Class</th><th>Role</th><th>Note</th></tr></thead>
            <tbody>{d.evidence.map(e => <tr key={e.id}><td><a href={`#/evidence/${e.id}`} className={e.title ? "" : "mono"}>{e.title ?? (e.externalKey ?? e.id).slice(0, 44)}</a></td><td>{e.sourceName}<div className="small muted">{e.sourceStatus ? <Status value={e.sourceStatus} /> : null}</div></td><td><Status value={e.validation} /></td><td>{e.dataClass ? <DataClass value={e.dataClass} /> : "—"}</td><td>{titleCase(e.role)}</td><td className="small">{e.note ?? "—"}</td></tr>)}</tbody></Table>
        )}
      </Card>
      {["open", "analysis"].includes(d.state) && me.permissions.includes("case.write") ? (
        <Card title="Attach evidence">
          <Async state={ev}>{rows => (
            <form className="stack" onSubmit={e => { e.preventDefault(); void a.run(() => api(`/v1/cases/${d.id}/evidence`, { method: "POST", body: { evidenceId: pick, role, note: note || undefined } })).then(ok => { if (ok) { setPick(""); setNote(""); } }); }}>
              <label>Record<select required value={pick} onChange={e => setPick(e.target.value)}><option value="">Choose a record…</option>{rows.filter(r => !attached.has(r.id)).map(r => <option key={r.id} value={r.id}>{r.source_key} · {r.title ?? r.external_key.slice(0, 50)} · {r.validation_status}</option>)}</select></label>
              <div className="row"><label>How it bears on the case<select value={role} onChange={e => setRole(e.target.value)}><option value="supports">Supports</option><option value="contradicts">Contradicts</option><option value="context">Context</option></select></label>
                <label style={{ flex: 1 }}>Note<input type="text" value={note} onChange={e => setNote(e.target.value)} /></label></div>
              {a.error ? <div className="note err" role="alert">{a.error}</div> : null}<button className="primary" disabled={a.busy || !pick}>Attach</button>
            </form>
          )}</Async>
        </Card>
      ) : null}
    </div>
  );
}

function ScenariosTab({ d, me, reload }: { d: CaseDetail; me: Me; reload: () => void }): ReactNode {
  const runs = useApi<RunSummary[]>(me.permissions.includes("case.write") && ["open", "analysis"].includes(d.state) ? "/v1/scenarios/runs" : null);
  const a = useAction(reload);
  const [pick, setPick] = useState("");
  const have = new Set(d.scenarios.map(s => s.id));
  return (
    <div className="grid">
      <Card title="Scenario runs on this case" aside={<span className="badge b-gold">Scenario simulation</span>}>
        {d.scenarios.length === 0 ? <div className="empty">No scenario attached.</div> : (
          <Table label="Case scenarios"><thead><tr><th>Run</th><th>Template</th><th>Confidence</th><th>Created</th></tr></thead>
            <tbody>{d.scenarios.map(s => <tr key={s.id}><td><a href={`#/scenarios/runs/${s.id}`} className="mono">{s.id.slice(0, 8)}</a></td><td>{s.templateKey}</td><td><Status value={s.confidence} /></td><td>{dateTime(s.createdAt)}</td></tr>)}</tbody></Table>
        )}
      </Card>
      {["open", "analysis"].includes(d.state) && me.permissions.includes("case.write") ? (
        <Card title="Attach a scenario run">
          <Async state={runs}>{rows => (
            <form className="stack" onSubmit={e => { e.preventDefault(); void a.run(() => api(`/v1/cases/${d.id}/scenarios`, { method: "POST", body: { runId: pick } })).then(ok => ok && setPick("")); }}>
              <label>Run<select required value={pick} onChange={e => setPick(e.target.value)}><option value="">Choose a run…</option>{rows.filter(r => !have.has(r.id)).map(r => <option key={r.id} value={r.id}>{r.id.slice(0, 8)} · {r.template_key} · {r.confidence} confidence</option>)}</select></label>
              {a.error ? <div className="note err" role="alert">{a.error}</div> : null}<button className="primary" disabled={a.busy || !pick}>Attach</button>
              <span className="small muted">Need a new run? <a href="#/scenarios">Open Scenarios</a> and attach it here afterwards.</span>
            </form>
          )}</Async>
        </Card>
      ) : null}
    </div>
  );
}

function OptionsTab({ d, me, reload }: { d: CaseDetail; me: Me; reload: () => void }): ReactNode {
  const mine = d.owner?.id === me.id, canWrite = me.permissions.includes("case.write") && d.state === "analysis";
  const reviewers = useApi<Reviewer[]>(mine && d.state === "analysis" ? "/v1/identity/reviewers" : null);
  const a = useAction(reload), sub = useAction(reload);
  const [f, setF] = useState({ title: "", description: "", actionClass: "advisory", constraints: "", scenarioRunId: "", evidenceIds: [] as string[] });
  const [sel, setSel] = useState<string[]>([]), [rev, setRev] = useState("");
  const [result, setResult] = useState<{ recommendationId: string; outcome: string; results: { ruleId: string; outcome: string; explanation: string }[] }[] | null>(null);
  const drafts = d.recommendations.filter(r => r.status === "draft");
  return (
    <div className="grid">
      <Card title="Options">
        {d.recommendations.length === 0 ? <div className="empty">No options yet. Each option states its evidence, owner, constraints and action class.</div> : d.recommendations.map(r => (
          <div className="opt" key={r.id}>
            <div className="row" style={{ justifyContent: "space-between" }}><h3>{r.title}</h3><span className="row"><span className="badge b-plain">{titleCase(r.actionClass)}</span><span className="badge b-info">{titleCase(r.status)}</span>{r.latestPolicy ? <PolicyBadge value={r.latestPolicy.outcome} /> : null}</span></div>
            <p style={{ margin: "6px 0" }}>{r.description}</p>
            <p className="small muted">Author {r.author?.name ?? "—"} · Owner {r.owner?.name ?? "not set"} · {r.evidenceIds.length} evidence record(s){r.scenarioRunId ? <> · scenario <a href={`#/scenarios/runs/${r.scenarioRunId}`} className="mono">{r.scenarioRunId.slice(0, 8)}</a></> : " · no scenario"}</p>
            {r.constraints ? <p className="small">Constraints: {r.constraints}</p> : null}
            {r.latestPolicy ? <details><summary>Policy v{r.latestPolicy.policyVersion} rule results</summary><RuleList results={r.latestPolicy.results} /></details> : null}
            {mine && d.state === "analysis" && r.status === "draft" ? <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={sel.includes(r.id)} onChange={e => setSel(e.target.checked ? [...sel, r.id] : sel.filter(x => x !== r.id))} />Include when submitting for review</label> : null}
          </div>))}
      </Card>

      {canWrite ? (
        <Card title="Add an option">
          <form className="stack" onSubmit={e => { e.preventDefault(); void a.run(() => api(`/v1/cases/${d.id}/recommendations`, { method: "POST", body: { title: f.title, description: f.description, actionClass: f.actionClass, evidenceIds: f.evidenceIds, ...(f.constraints ? { constraints: f.constraints } : {}), ...(f.scenarioRunId ? { scenarioRunId: f.scenarioRunId } : {}) } })).then(ok => ok && setF({ ...f, title: "", description: "", constraints: "" })); }}>
            <label>Title<input type="text" required minLength={3} value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></label>
            <label>What should happen, and why<textarea required value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
            <label>Action class<select value={f.actionClass} onChange={e => setF({ ...f, actionClass: e.target.value })}>{Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label>Constraints<input type="text" value={f.constraints} onChange={e => setF({ ...f, constraints: e.target.value })} /></label>
            <label>Scenario run<select value={f.scenarioRunId} onChange={e => setF({ ...f, scenarioRunId: e.target.value })}><option value="">None</option>{d.scenarios.map(s => <option key={s.id} value={s.id}>{s.id.slice(0, 8)} · {s.templateKey} · {s.confidence}</option>)}</select></label>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small muted">Evidence this option relies on</legend>
              {d.evidence.map(e => <label key={e.id} className="check"><input type="checkbox" checked={f.evidenceIds.includes(e.id)} onChange={x => setF({ ...f, evidenceIds: x.target.checked ? [...f.evidenceIds, e.id] : f.evidenceIds.filter(i => i !== e.id) })} />{e.title ?? (e.externalKey ?? e.id).slice(0, 50)} <Status value={e.validation} /></label>)}</fieldset>
            {a.error ? <div className="note err" role="alert">{a.error}</div> : null}<button className="primary" disabled={a.busy}>Add option</button>
          </form>
        </Card>
      ) : null}

      {mine && d.state === "analysis" && drafts.length ? (
        <Card title="Submit to a named reviewer" aside={<span className="small muted">Policy is checked first. Anything but PASS stops here with reasons.</span>}>
          <Async state={reviewers}>{rs => (
            <form className="stack" onSubmit={e => { e.preventDefault(); void sub.run(async () => { const r = await api<{ submitted: boolean; evaluations: NonNullable<typeof result> }>(`/v1/cases/${d.id}/submit`, { method: "POST", body: { reviewerId: rev, recommendationIds: sel } }); setResult(r.evaluations); }); }}>
              <label>Reviewer<select required value={rev} onChange={e => setRev(e.target.value)}><option value="">Choose…</option>{rs.filter(r => r.id !== me.id).map(r => <option key={r.id} value={r.id}>{r.name} ({r.roles.join(", ")})</option>)}</select></label>
              <span className="small muted">{sel.length} option(s) selected above.</span>
              {sub.error ? <div className="note err" role="alert">{sub.error}</div> : null}
              <button className="primary" disabled={sub.busy || !rev || sel.length === 0}>Check policy and submit</button>
            </form>
          )}</Async>
          {result ? <div role="status" style={{ marginTop: 12 }}>{result.map(r => <div key={r.recommendationId} className="opt"><PolicyBadge value={r.outcome} /> <span className="small">{d.recommendations.find(x => x.id === r.recommendationId)?.title}</span><RuleList results={r.results.filter(x => x.outcome !== "PASS").length ? r.results.filter(x => x.outcome !== "PASS") : r.results} /></div>)}</div> : null}
        </Card>
      ) : null}
    </div>
  );
}

function DecisionTab({ d, me, reload }: { d: CaseDetail; me: Me; reload: () => void }): ReactNode {
  const a = useAction(reload), h = useAction(reload), cl = useAction(reload);
  const isReviewer = d.reviewer?.id === me.id && d.state === "in_review";
  const submitted = d.recommendations.filter(r => r.status === "submitted");
  const [form, setForm] = useState<Record<string, { decision: string; rationale: string; task: string }>>({});
  const [closing, setClosing] = useState({ rationale: "", outcome: "" });
  const [handoffOutcome, setHandoffOutcome] = useState<Record<string, string>>({});
  const f = (id: string) => form[id] ?? { decision: "approve", rationale: "", task: "" };
  const mine = d.owner?.id === me.id;
  return (
    <div className="grid">
      {d.state === "in_review" ? (
        <Card title={isReviewer ? "Your decision" : "Awaiting decision"}>
          {!isReviewer ? <p>Only the named reviewer, {d.reviewer?.name}, can decide. Policy and authority are re-checked at the moment of decision.</p> : submitted.map(r => (
            <form key={r.id} className="opt stack" onSubmit={e => { e.preventDefault(); void a.run(() => api(`/v1/cases/${d.id}/decision`, { method: "POST", body: { recommendationId: r.id, decision: f(r.id).decision, rationale: f(r.id).rationale, caseVersion: d.version, ...(f(r.id).task ? { handoffTask: f(r.id).task } : {}) } })); }}>
              <div className="row" style={{ justifyContent: "space-between", width: "100%" }}><h3>{r.title}</h3><span className="row"><span className="badge b-plain">{titleCase(r.actionClass)}</span>{r.latestPolicy ? <PolicyBadge value={r.latestPolicy.outcome} /> : null}</span></div>
              <p style={{ margin: 0 }}>{r.description}</p>
              {r.latestPolicy ? <details><summary>Rule results at submission</summary><RuleList results={r.latestPolicy.results} /></details> : null}
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small muted">Decision</legend>
                {[["approve", "Approve"], ["reject", "Reject"], ["defer", "Defer"], ["request_evidence", "Request evidence"]].map(([v, l]) => <label key={v} className="check" style={{ display: "inline-flex", marginInlineEnd: 14 }}><input type="radio" name={`d-${r.id}`} checked={f(r.id).decision === v} onChange={() => setForm({ ...form, [r.id]: { ...f(r.id), decision: v! } })} />{l}</label>)}</fieldset>
              <label>Rationale (recorded with your name, the time and the policy version)<textarea required minLength={10} value={f(r.id).rationale} onChange={e => setForm({ ...form, [r.id]: { ...f(r.id), rationale: e.target.value } })} /></label>
              {r.actionClass === "handoff" && f(r.id).decision === "approve" ? <label>Task wording for the person who will carry it out<input type="text" value={f(r.id).task} onChange={e => setForm({ ...form, [r.id]: { ...f(r.id), task: e.target.value } })} placeholder="Defaults to the option's title and description" /></label> : null}
              {a.error ? <div className="note err" role="alert">{a.error}</div> : null}
              <button className="primary" disabled={a.busy}>Record decision</button>
            </form>))}
        </Card>
      ) : null}

      <Card title="Decisions">
        {d.decisions.length === 0 ? <div className="empty">No decision recorded yet.</div> : (
          <Table label="Decisions"><thead><tr><th>When</th><th>Decision</th><th>By</th><th>Option</th><th>Policy</th><th>Rationale</th></tr></thead>
            <tbody>{d.decisions.map(x => { const pd = d.policyDecisions.find(p => p.id === x.policyDecisionId); return <tr key={x.id}><td>{dateTime(x.createdAt)}</td><td><strong>{titleCase(x.decision)}</strong></td><td>{x.actor?.name}</td><td>{d.recommendations.find(r => r.id === x.recommendationId)?.title}</td><td>{pd ? <><PolicyBadge value={pd.outcome} /><div className="small muted">v{pd.policyVersion}</div></> : "—"}</td><td className="small" style={{ maxWidth: "46ch" }}>{x.rationale}</td></tr>; })}</tbody></Table>
        )}
      </Card>

      {d.handoffs.length ? (
        <Card title="Handoffs" aside={<span className="small muted">Human-owned tasks. Nothing is executed by this system.</span>}>
          <Table label="Handoffs"><thead><tr><th>Task</th><th>Owner</th><th>Status</th><th>Outcome</th></tr></thead>
            <tbody>{d.handoffs.map(x => <tr key={x.id}><td>{x.task}</td><td>{x.owner?.name ?? "Unassigned"}</td><td><span className={`badge ${x.status === "done" ? "b-ok" : x.status === "open" ? "b-warn" : "b-plain"}`}>{titleCase(x.status)}</span></td>
              <td>{x.outcome ?? (me.permissions.includes("handoff.update") ? <form className="row" onSubmit={e => { e.preventDefault(); void h.run(() => api(`/v1/handoffs/${x.id}/update`, { method: "POST", body: { status: "done", outcome: handoffOutcome[x.id] ?? "" } })); }}><input type="text" required minLength={5} aria-label="Outcome" value={handoffOutcome[x.id] ?? ""} onChange={e => setHandoffOutcome({ ...handoffOutcome, [x.id]: e.target.value })} placeholder="What happened" /><button disabled={h.busy}>Mark done</button></form> : "Awaiting operations")}</td></tr>)}</tbody></Table>
          {h.error ? <div className="note err" role="alert" style={{ marginTop: 10 }}>{h.error}</div> : null}
        </Card>
      ) : null}

      {mine && d.state === "decided" ? (
        <Card title="Close the case and write it to memory">
          <form className="stack" onSubmit={e => { e.preventDefault(); void cl.run(() => api(`/v1/cases/${d.id}/close`, { method: "POST", body: { rationale: closing.rationale, ...(closing.outcome ? { outcome: closing.outcome } : {}) } })); }}>
            <label>Closing note<textarea required minLength={10} value={closing.rationale} onChange={e => setClosing({ ...closing, rationale: e.target.value })} /></label>
            <label>Outcome, if known<input type="text" value={closing.outcome} onChange={e => setClosing({ ...closing, outcome: e.target.value })} /></label>
            {cl.error ? <div className="note err" role="alert">{cl.error}</div> : null}<button className="primary" disabled={cl.busy}>Close case</button>
          </form>
        </Card>
      ) : null}
      {d.state === "closed" ? <div className="note ok">Closed{d.disposition ? ` as ${d.disposition}` : ""}. {d.disposition !== "dismissed" ? <a href="#/memory">Find it in Institutional Memory.</a> : null}</div> : null}
    </div>
  );
}

function Activity({ d }: { d: CaseDetail }): ReactNode {
  return (
    <Card title="Activity" aside={<span className="small muted">Append-only. Every entry is also in the hash-chained audit trail.</span>}>
      <ol className="timeline">{d.events.map(e => <li key={e.seq}><strong>{titleCase(e.kind)}</strong> <span className="small muted">· {e.actor?.name} · {dateTime(e.at)}</span>{e.rationale ? <div className="small">{e.rationale}</div> : null}</li>)}</ol>
    </Card>
  );
}
