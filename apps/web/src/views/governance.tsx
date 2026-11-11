import { useState, type ReactNode } from "react";
import { api, type HandoffRow, type MemoryRow, type PolicyRow } from "../api";
import { Async, Card, PageHead, PagerBar, Table, useAction, useApi, usePaged } from "../components";
import { dateTime, titleCase } from "../format";

export function Handoffs({ can }: { can: (p: string) => boolean }): ReactNode {
  const list = usePaged<HandoffRow>("/v1/handoffs?limit=50");
  const a = useAction(() => list.reload());
  const [out, setOut] = useState<Record<string, string>>({});
  return (
    <>
      <PageHead title="Handoffs">Tasks a person carries out in the institution's own systems after an authorized decision. This system records them; it never executes them.</PageHead>
      <Async state={list} empty={d => d.length === 0}>{rows => (
        <Table label="Handoffs"><thead><tr><th>Case</th><th>Task</th><th>Status</th><th>Outcome</th></tr></thead>
          <tbody>{rows.map(h => <tr key={h.id}><td><a href={`#/cases/${h.caseId}`}><span className="mono">{h.caseKey}</span></a><div className="small muted">{h.caseTitle}</div></td><td>{h.task}</td><td><span className={`badge ${h.status === "done" ? "b-ok" : h.status === "open" ? "b-warn" : "b-plain"}`}>{titleCase(h.status)}</span></td>
            <td>{h.outcome ?? (can("handoff.update") ? <form className="row" onSubmit={e => { e.preventDefault(); void a.run(() => api(`/v1/handoffs/${h.id}/update`, { method: "POST", body: { status: "done", outcome: out[h.id] ?? "" } })); }}><input type="text" required minLength={5} aria-label="Outcome" value={out[h.id] ?? ""} onChange={e => setOut({ ...out, [h.id]: e.target.value })} placeholder="What happened" /><button disabled={a.busy}>Mark done</button></form> : "Awaiting operations")}</td></tr>)}</tbody></Table>
      )}</Async>
      <PagerBar p={list} />
      {a.error ? <div className="note err" role="alert" style={{ marginTop: 12 }}>{a.error}</div> : null}
    </>
  );
}

export function Memory(): ReactNode {
  const [q, setQ] = useState(""), [term, setTerm] = useState("");
  const list = usePaged<MemoryRow>(`/v1/memory?${new URLSearchParams({ limit: "30", ...(term ? { q: term } : {}) })}`);
  return (
    <>
      <PageHead title="Institutional Memory">Closed cases with a recorded decision and outcome. Only decided, closed work enters memory. Nothing leaves this institution and nothing trains a model.</PageHead>
      <form className="row" style={{ marginBottom: 14 }} onSubmit={e => { e.preventDefault(); setTerm(q); }}><label>Search<input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="exposure, treasury, monitoring…" /></label><button style={{ alignSelf: "flex-end" }}>Search</button></form>
      <Async state={list} empty={d => d.length === 0}>{rows => <div className="grid">{rows.map(m => (
        <Card key={m.id} title={<><span className="mono">{m.case_key}</span> {m.title}</>} aside={<span className="row"><span className={`badge ${m.decision === "approve" ? "b-ok" : "b-plain"}`}>{m.decision === "approve" ? "Approved" : "Rejected"}</span><span className="badge b-plain">{m.domain}</span></span>}>
          <pre style={{ whiteSpace: "pre-wrap", maxHeight: "none", fontFamily: "var(--sans)", fontSize: 14 }}>{m.summary}</pre>
          {m.outcome ? <p><strong>Outcome.</strong> {m.outcome}</p> : <p className="small muted">No outcome recorded.</p>}
          <p className="small muted">Closed {dateTime(m.created_at)} · <a href={`#/cases/${m.case_id}`}>Open the case</a></p>
        </Card>))}</div>}</Async>
      <PagerBar p={list} />
    </>
  );
}

export function Policy({ can }: { can: (p: string) => boolean }): ReactNode {
  const list = useApi<PolicyRow[]>("/v1/policies");
  const a = useAction(() => list.reload());
  const [rules, setRules] = useState(""), [auth, setAuth] = useState("");
  const manage = can("policy.manage");
  return (
    <>
      <PageHead title="Policy">The rules every proposal must pass before it can reach a reviewer, and who may decide each action class. Policy versions never change; a new version is drafted, then activated by a different administrator.</PageHead>
      <Async state={list} empty={d => d.length === 0}>{rows => {
        const active = rows.find(r => r.status === "active");
        return <div className="grid">
          {!active ? <div className="note err" role="alert">No policy is active. Nothing can be submitted for review until an administrator activates one.</div> : null}
          <Card title="Versions">
            <Table label="Policy versions"><thead><tr><th className="num">Version</th><th>Status</th><th>Created by</th><th>Activated by</th><th>Rules</th>{manage ? <th /> : null}</tr></thead>
              <tbody>{rows.map(p => <tr key={p.id}><td className="num">v{p.version}</td><td><span className={`badge ${p.status === "active" ? "b-ok" : p.status === "draft" ? "b-warn" : "b-plain"}`}>{titleCase(p.status)}</span></td><td className="mono small">{p.createdBy.slice(0, 8)}</td><td className="mono small">{p.activatedBy?.slice(0, 8) ?? "—"}</td><td>{p.rules.length}</td>
                {manage ? <td>{p.status === "draft" ? <button disabled={a.busy} onClick={() => void a.run(() => api(`/v1/policies/${p.id}/activate`, { method: "POST", body: {} }))}>Activate</button> : null}</td> : null}</tr>)}</tbody></Table>
          </Card>
          {active ? <Card title={`Rules in force (v${active.version})`}>
            <Table label="Rules"><thead><tr><th>Rule</th><th>Type</th><th>Parameters</th></tr></thead><tbody>{active.rules.map(r => <tr key={r.id}><td className="mono">{r.id}</td><td>{titleCase(r.type)}</td><td className="mono small">{JSON.stringify(r.params)}</td></tr>)}</tbody></Table>
            <h3 style={{ margin: "16px 0 6px" }}>Authority by action class</h3>
            <Table label="Authority"><thead><tr><th>Action class</th><th>Roles that may decide</th></tr></thead><tbody>{Object.entries(active.authority).map(([k, v]) => <tr key={k}><td>{titleCase(k)}</td><td>{v.join(" or ")}</td></tr>)}</tbody></Table>
          </Card> : null}
          {a.error ? <div className="note err" role="alert">{a.error}</div> : null}
          {manage && active ? <Card title="Draft a new version">
            <form className="stack" onSubmit={e => { e.preventDefault(); let r: unknown, au: unknown; try { r = JSON.parse(rules || JSON.stringify(active.rules)); au = JSON.parse(auth || JSON.stringify(active.authority)); } catch { return void a.run(async () => { throw new Error("x"); }); } void a.run(() => api("/v1/policies", { method: "POST", body: { rules: r, authority: au } })); }}>
              <label>Rules (JSON; blank keeps the current rules)<textarea value={rules} onChange={e => setRules(e.target.value)} placeholder={JSON.stringify(active.rules, null, 1).slice(0, 200) + "…"} /></label>
              <label>Authority (JSON; blank keeps the current authority)<textarea value={auth} onChange={e => setAuth(e.target.value)} placeholder={JSON.stringify(active.authority)} /></label>
              <button className="primary" disabled={a.busy}>Save as draft</button><span className="small muted">A draft changes nothing until a different administrator activates it.</span>
            </form>
          </Card> : null}
        </div>;
      }}</Async>
    </>
  );
}
