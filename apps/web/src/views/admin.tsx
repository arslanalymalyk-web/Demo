import { useState, type ReactNode } from "react";
import { api, ApiError, ROLES, type PrincipalRow } from "../api";
import { Async, Card, PageHead, Stat, Table, useApi } from "../components";
import { num } from "../format";

export function Audit(): ReactNode {
  const [n, setN] = useState(0);
  const a = useApi<{ ok: boolean; events: number; firstBadSeq: number | null }>(`/v1/audit/verify${n ? `?v=${n}` : ""}`);
  return (
    <>
      <PageHead title="Audit">Every protected change is written to an append-only, hash-chained trail inside the same transaction. Verification recomputes the whole chain.</PageHead>
      <Async state={a}>{d => (
        <div className="grid g3">
          <Stat value={d.ok ? "Intact" : "Broken"} label="Chain status" sub={d.ok ? "Every event links to the one before it" : `First bad event: ${d.firstBadSeq}`} />
          <Stat value={num(d.events, 0)} label="Events verified" />
          <div className="card"><button onClick={() => setN(x => x + 1)}>Verify again</button></div>
        </div>
      )}</Async>
    </>
  );
}

export function Admin({ can }: { can: (p: string) => boolean }): ReactNode {
  const list = useApi<PrincipalRow[]>("/v1/identity/principals");
  const manage = can("identity.manage");
  const [err, setErr] = useState<string | null>(null), [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ issuer: "", subject: "", displayName: "", roles: [] as string[] });
  const act = async (f: () => Promise<unknown>, ok: string) => { setErr(null); setMsg(null); try { await f(); setMsg(ok); list.reload(); } catch (e) { setErr(e instanceof ApiError ? e.message : "The change failed."); } };
  return (
    <>
      <PageHead title="Administration">People who can sign in, and what each may do. Every change here is written to the audit trail. At least one active administrator must remain.</PageHead>
      {err ? <div className="note err" role="alert">{err}</div> : null}{msg ? <div className="note ok" role="status">{msg}</div> : null}
      <Card title="Principals">
        <Async state={list} empty={d => d.length === 0}>{rows => (
          <Table label="Principals"><thead><tr><th>Person</th><th>Identity provider subject</th><th>Roles</th><th>State</th>{manage ? <th>Actions</th> : null}</tr></thead>
            <tbody>{rows.map(p => <tr key={p.id}><td>{p.displayName ?? "—"}</td><td className="mono">{p.subject}<div className="small muted">{p.issuer}</div></td>
              <td>{manage ? <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="sr-only">Roles for {p.subject}</legend>{ROLES.map(r => <label key={r} style={{ flexDirection: "row", alignItems: "center", marginInlineEnd: 10 }}><input type="checkbox" checked={p.roles.includes(r)} onChange={e => act(() => api(`/v1/identity/principals/${p.id}/roles`, { method: "PUT", body: { roles: e.target.checked ? [...p.roles, r] : p.roles.filter(x => x !== r) } }), "Roles updated.")} />{r}</label>)}</fieldset> : p.roles.join(", ") || "none"}</td>
              <td>{p.disabled ? <span className="badge b-bad">Disabled</span> : <span className="badge b-ok">Active</span>}</td>
              {manage ? <td><button onClick={() => act(() => api(`/v1/identity/principals/${p.id}/${p.disabled ? "enable" : "disable"}`, { method: "POST" }), p.disabled ? "Enabled." : "Disabled.")}>{p.disabled ? "Enable" : "Disable"}</button></td> : null}</tr>)}</tbody></Table>
        )}</Async>
      </Card>
      {manage ? (
        <div style={{ marginTop: 16 }}><Card title="Add a person">
          <form className="row" onSubmit={e => { e.preventDefault(); void act(async () => { await api("/v1/identity/principals", { method: "POST", body: { issuer: form.issuer, subject: form.subject, displayName: form.displayName || null, roles: form.roles } }); setForm({ issuer: form.issuer, subject: "", displayName: "", roles: [] }); }, "Person added."); }}>
            <label>Issuer<input required value={form.issuer} onChange={e => setForm({ ...form, issuer: e.target.value })} placeholder="https://idp.institution.example" /></label>
            <label>Subject<input required value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} /></label>
            <label>Display name<input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} /></label>
            <fieldset style={{ border: 0, padding: 0 }}><legend className="small muted">Roles</legend>{ROLES.map(r => <label key={r} style={{ flexDirection: "row", alignItems: "center", marginInlineEnd: 10 }}><input type="checkbox" checked={form.roles.includes(r)} onChange={e => setForm({ ...form, roles: e.target.checked ? [...form.roles, r] : form.roles.filter(x => x !== r) })} />{r}</label>)}</fieldset>
            <button className="primary" disabled={form.roles.length === 0}>Add</button>
          </form></Card></div>
      ) : null}
    </>
  );
}
