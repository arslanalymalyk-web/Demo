import { useState, type ReactNode } from "react";
import { api, ApiError, ROLES, type PrincipalRow } from "../api";
import { Async, Card, PageHead, Stat, Table, useApi } from "../components";
import { dateTime, num } from "../format";

interface GrantRow { id: string; subject: string; displayName: string | null; roles: string[]; status: string; requestedAt: string }

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
      <Checkpoints />
    </>
  );
}

function Checkpoints(): ReactNode {
  const [text, setText] = useState(""), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null), [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => { setBusy(true); setMsg(null); try { await f(); } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : "The request failed." }); } finally { setBusy(false); } };
  const take = () => run(async () => {
    const cp = await api<{ seq: number; events: number }>("/v1/audit/checkpoint");
    const url = URL.createObjectURL(new Blob([JSON.stringify(cp, null, 2)], { type: "application/json" })), a = document.createElement("a");
    a.href = url; a.download = `audit-checkpoint-${cp.events}-events.json`; a.click(); URL.revokeObjectURL(url);
    setMsg({ ok: true, text: `Checkpoint saved: ${cp.events} events, up to event ${cp.seq}. Keep the file where the database administrator cannot change it.` });
  });
  const check = () => run(async () => {
    let cp: unknown; try { cp = JSON.parse(text); } catch { setMsg({ ok: false, text: "That is not a checkpoint file." }); return; }
    const r = await api<{ ok: boolean; events?: number; detail?: string }>("/v1/audit/checkpoint/verify", { method: "POST", body: cp });
    setMsg(r.ok ? { ok: true, text: `Nothing up to the checkpoint has changed. The chain now holds ${r.events} events.` } : { ok: false, text: r.detail ?? "The checkpoint does not match." });
  });
  return (
    <div style={{ marginTop: 16 }}><Card title="Checkpoints">
      <p className="small muted">The chain shows that no event was changed without the next one noticing. A checkpoint also shows that the whole chain was not rewritten, by someone with full database rights, after you took it. Save one regularly and keep it off this server.</p>
      <div className="row"><button onClick={take} disabled={busy}>Take a checkpoint</button></div>
      <form className="stack" style={{ marginTop: 12 }} onSubmit={e => { e.preventDefault(); void check(); }}>
        <label>Check a saved checkpoint<textarea rows={4} value={text} onChange={e => setText(e.target.value)} placeholder="Paste the contents of a checkpoint file" className="mono" /></label>
        <div><button disabled={busy || text.trim() === ""}>Check it</button></div>
      </form>
      {msg ? <div className={`note ${msg.ok ? "ok" : "err"}`} role={msg.ok ? "status" : "alert"} style={{ marginTop: 10 }}>{msg.text}</div> : null}
    </Card></div>
  );
}

function Lockdown(): ReactNode {
  const st = useApi<{ locked: boolean; reason: string | null; changedAt: string | null }>("/v1/lockdown");
  const [reason, setReason] = useState(""), [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const flip = async (locked: boolean) => { setBusy(true); setErr(null); try { await api("/v1/lockdown", { method: "POST", body: { locked, reason } }); setReason(""); st.reload(); } catch (e) { setErr(e instanceof ApiError ? e.message : "The change failed."); } finally { setBusy(false); } };
  return (
    <div style={{ marginTop: 16 }}><Card title="Emergency stop" aside={st.data ? <span className={`badge ${st.data.locked ? "b-bad" : "b-ok"}`}>{st.data.locked ? "Locked down" : "Normal"}</span> : undefined}>
      <p className="small muted">A lockdown refuses every ordinary request: reading, uploads, model calls and scheduled fetches. Administrators and auditors can still see who has access, end sessions, check the audit trail and switch the lockdown off. Both changes are recorded with the reason.</p>
      {st.data?.locked ? <div className="note err" role="status">Locked down: {st.data.reason}</div> : null}
      {st.data ? <form className="row" onSubmit={e => { e.preventDefault(); void flip(!st.data?.locked); }}>
        <label style={{ flex: 1 }}>Reason<input required minLength={5} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <button className={st.data.locked ? "primary" : ""} disabled={busy} style={{ alignSelf: "flex-end" }}>{st.data.locked ? "Release lockdown" : "Start lockdown"}</button>
      </form> : <div className="skeleton" style={{ width: "50%" }} />}
      {err ? <div className="note err" role="alert" style={{ marginTop: 10 }}>{err}</div> : null}
    </Card></div>
  );
}

export function Admin({ can }: { can: (p: string) => boolean }): ReactNode {
  const list = useApi<PrincipalRow[]>("/v1/identity/principals");
  const manage = can("identity.manage");
  const [err, setErr] = useState<string | null>(null), [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ issuer: "", subject: "", displayName: "", roles: [] as string[], expiresAt: "" });
  const requests = useApi<GrantRow[]>(manage ? "/v1/identity/role-requests" : null);
  const held = (r: unknown) => { const g = (r as { pendingGrant?: { roles: string[] } | null } | null)?.pendingGrant; return g ? ` ${g.roles.join(" and ")} is held until a second administrator approves it.` : ""; };
  const act = async (f: () => Promise<unknown>, ok: string | ((r: unknown) => string)) => { setErr(null); setMsg(null); try { const r = await f(); setMsg(typeof ok === "function" ? ok(r) : ok); list.reload(); requests.reload(); } catch (e) { setErr(e instanceof ApiError ? e.message : "The change failed."); } };
  return (
    <>
      <PageHead title="Administration">People who can sign in, and what each may do. Every change here is written to the audit trail. At least one active administrator must remain.</PageHead>
      {err ? <div className="note err" role="alert">{err}</div> : null}{msg ? <div className="note ok" role="status">{msg}</div> : null}
      <Card title="Principals">
        <Async state={list} empty={d => d.length === 0}>{rows => (
          <Table label="Principals"><thead><tr><th>Person</th><th>Identity provider subject</th><th>Roles</th><th>State</th>{manage ? <th>Actions</th> : null}</tr></thead>
            <tbody>{rows.map(p => <tr key={p.id}><td>{p.displayName ?? "—"}</td><td className="mono">{p.subject}<div className="small muted">{p.issuer}</div></td>
              <td>{manage ? <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="sr-only">Roles for {p.subject}</legend>{ROLES.map(r => <label key={r} style={{ flexDirection: "row", alignItems: "center", marginInlineEnd: 10 }}><input type="checkbox" checked={p.roles.includes(r)} onChange={e => act(() => api(`/v1/identity/principals/${p.id}/roles`, { method: "PUT", body: { roles: e.target.checked ? [...p.roles, r] : p.roles.filter(x => x !== r) } }), r => `Roles updated.${held(r)}`)} />{r}</label>)}</fieldset> : p.roles.join(", ") || "none"}</td>
              <td>{p.disabled ? <span className="badge b-bad">Disabled</span> : p.expiresAt && new Date(p.expiresAt) <= new Date() ? <span className="badge b-bad">Expired</span> : <span className="badge b-ok">Active</span>}{p.expiresAt ? <div className="small muted">Access ends {dateTime(p.expiresAt)}</div> : null}</td>
              {manage ? <td><button onClick={() => act(() => api(`/v1/identity/principals/${p.id}/${p.disabled ? "enable" : "disable"}`, { method: "POST" }), p.disabled ? "Enabled." : "Disabled.")}>{p.disabled ? "Enable" : "Disable"}</button> <button onClick={() => { const why = window.prompt(`Why are you ending ${p.displayName ?? p.subject}'s sessions?`); if (why && why.trim().length >= 5) void act(() => api(`/v1/identity/principals/${p.id}/revoke-sessions`, { method: "POST", body: { reason: why } }), "Sessions ended. They must sign in again."); }}>End sessions</button></td> : null}</tr>)}</tbody></Table>
        )}</Async>
      </Card>
      {manage && requests.data && requests.data.some(g => g.status === "pending") ? (
        <div style={{ marginTop: 16 }}><Card title="Roles waiting for a second administrator">
          <Table label="Pending role grants"><thead><tr><th>Person</th><th>Role</th><th>Asked</th><th>Actions</th></tr></thead>
            <tbody>{requests.data.filter(g => g.status === "pending").map(g => <tr key={g.id}><td>{g.displayName ?? g.subject}</td><td>{g.roles.join(", ")}</td><td>{dateTime(g.requestedAt)}</td>
              <td><button className="primary" onClick={() => act(() => api(`/v1/identity/role-requests/${g.id}/approve`, { method: "POST", body: {} }), "Approved. The role is now in effect.")}>Approve</button> <button onClick={() => act(() => api(`/v1/identity/role-requests/${g.id}/reject`, { method: "POST", body: {} }), "Rejected or withdrawn.")}>Reject</button></td></tr>)}</tbody></Table>
          <p className="small muted">You cannot approve a role you asked for or one for yourself. If you made the request, Reject withdraws it.</p>
        </Card></div>
      ) : null}
      {manage ? <Lockdown /> : null}
      {manage ? (
        <div style={{ marginTop: 16 }}><Card title="Add a person">
          <form className="row" onSubmit={e => { e.preventDefault(); void act(async () => { const r = await api("/v1/identity/principals", { method: "POST", body: { issuer: form.issuer, subject: form.subject, displayName: form.displayName || null, roles: form.roles, ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}) } }); setForm({ issuer: form.issuer, subject: "", displayName: "", roles: [], expiresAt: "" }); return r; }, r => `Person added.${held(r)}`); }}>
            <label>Issuer<input required value={form.issuer} onChange={e => setForm({ ...form, issuer: e.target.value })} placeholder="https://idp.institution.example" /></label>
            <label>Subject<input required value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} /></label>
            <label>Access ends (optional)<input type="datetime-local" value={form.expiresAt} onChange={e => setForm({ ...form, expiresAt: e.target.value })} /></label>
            <label>Display name<input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} /></label>
            <fieldset style={{ border: 0, padding: 0 }}><legend className="small muted">Roles</legend>{ROLES.map(r => <label key={r} style={{ flexDirection: "row", alignItems: "center", marginInlineEnd: 10 }}><input type="checkbox" checked={form.roles.includes(r)} onChange={e => setForm({ ...form, roles: e.target.checked ? [...form.roles, r] : form.roles.filter(x => x !== r) })} />{r}</label>)}</fieldset>
            <button className="primary" disabled={form.roles.length === 0}>Add</button>
          </form></Card></div>
      ) : null}
    </>
  );
}
