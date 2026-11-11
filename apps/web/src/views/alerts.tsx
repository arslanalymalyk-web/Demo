import { useState, type ReactNode } from "react";
import { api, type AlertAddress, type AlertsView, type MyAlerts } from "../api";
import { Async, Card, PageHead, Table, useAction, useApi } from "../components";
import { dateTime } from "../format";
import { t, tx } from "../i18n";

const CATEGORY: Record<string, string> = { malware: tx("Malware flagged"), source: tx("Data source"), review: tx("Decision waiting"), operations: tx("Operations") };
const KIND: Record<string, string> = { raised: tx("raised"), reminder: tx("reminder"), resolved: tx("resolved"), test: tx("test") };
const STATUS: Record<string, [string, string]> = { sent: ["b-ok", tx("Sent")], failed: ["b-bad", tx("Failed")], skipped: ["b-plain", tx("Skipped")] };
const WHY: Record<string, string> = { "this person has no email address": tx("this person has no email address"), "switched off by the person": tx("switched off by the person"), "hourly limit reached": tx("hourly limit reached") };
const CATEGORY_HELP: Record<string, string> = { malware: tx("Always sent to administrators and auditors."), source: tx("A scheduled source is failing, paused or out of date."), review: tx("A case has been submitted for your decision."), operations: tx("Always sent to administrators and auditors.") };

function Mine(): ReactNode {
  const mine = useApi<MyAlerts>("/v1/alerts/mine");
  const a = useAction(mine.reload);
  return (
    <Card title={t("My alerts")}>
      <Async state={mine}>{m => (
        <>
          <p className="small">{m.email ? t("Notices go to {email}. An administrator sets your address.", { email: m.email }) : t("You have no email address set, so no notice can reach you. Ask an administrator to add it.")}</p>
          {!m.configured ? <div className="note">{t("No alert channel is connected to this deployment yet.")}</div> : null}
          <ul className="plain" style={{ display: "grid", gap: 8, padding: 0, listStyle: "none" }}>{m.categories.map(c => (
            <li key={c.category} className="row"><label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={c.enabled} disabled={!c.mutable || a.busy} onChange={e => void a.run(() => api("/v1/alerts/mine", { method: "PUT", body: { category: c.category, enabled: e.target.checked } }))} />
              <strong>{t(CATEGORY[c.category]!)}</strong></label><span className="small muted">{t(CATEGORY_HELP[c.category]!)}{!c.mutable ? ` ${t("This cannot be switched off.")}` : ""}</span></li>))}</ul>
          {a.error ? <div className="note err" role="alert">{a.error}</div> : null}
          <p className="small muted">{t("A notice names a category, may carry a reference code, and links to TIGERIS. It never contains figures or record content.")}</p>
        </>
      )}</Async>
    </Card>
  );
}

function Addresses({ onChange }: { onChange: () => void }): ReactNode {
  const list = useApi<AlertAddress[]>("/v1/alerts/addresses");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const a = useAction(() => { list.reload(); onChange(); });
  return (
    <Card title={t("Email addresses")} aside={<span className="small muted">{t("Only administrators set these. Each change is audited.")}</span>}>
      <Async state={list} empty={d => d.length === 0}>{rows => (
        <Table label={t("Email addresses")}><thead><tr><th>{t("Person")}</th><th>{t("Roles")}</th><th>{t("Address")}</th><th><span className="sr-only">{t("Actions")}</span></th></tr></thead>
          <tbody>{rows.filter(p => !p.disabled).map(p => { const v = draft[p.id] ?? p.email ?? ""; return (
            <tr key={p.id}><td>{p.name}</td><td className="small">{p.roles.map(r => t(r)).join("، ")}</td>
              <td><input type="email" dir="ltr" aria-label={t("Email address of {name}", { name: p.name })} value={v} onChange={e => setDraft({ ...draft, [p.id]: e.target.value })} placeholder="name@institution.example" /></td>
              <td className="row"><button disabled={a.busy || v === (p.email ?? "") || v.trim() === ""} onClick={() => void a.run(() => api(`/v1/alerts/addresses/${p.id}`, { method: "PUT", body: { email: v.trim() } }))}>{t("Save")}</button>
                {p.email ? <button disabled={a.busy} onClick={() => void a.run(async () => { await api(`/v1/alerts/addresses/${p.id}`, { method: "PUT", body: { email: null } }); setDraft({ ...draft, [p.id]: "" }); })}>{t("Remove address")}</button> : null}</td></tr>); })}</tbody></Table>
      )}</Async>
      {a.error ? <div className="note err" role="alert" style={{ marginTop: 10 }}>{a.error}</div> : null}
    </Card>
  );
}

export function Alerts({ can }: { can: (p: string) => boolean }): ReactNode {
  const log = useApi<AlertsView>(can("alerts.read") ? "/v1/alerts" : null);
  const [test, setTest] = useState<string | null>(null), [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function sendTest() {
    setBusy(true); setErr(null); setTest(null);
    try { const r = await api<{ status: string; reason?: string }>("/v1/alerts/test", { method: "POST", body: {} }); setTest(r.status === "sent" ? t("A test message was sent to your address.") : t("The test message was not sent: {why}", { why: r.reason ?? r.status })); log.reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : t("The test message could not be sent.")); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHead title={t("Alerts")}>{t("A short email when something needs a person: a flagged file, a failing source, a decision waiting, or a system fault. Each condition is announced once, reminded about daily while it stays open, and a note follows when it clears.")}</PageHead>
      <div className="grid g2">
        <Mine />
        {can("alerts.manage") ? <div><Card title={t("Delivery")}>
          <Async state={log}>{v => <>
            <p className="small">{v.configured ? t("Alerts are sent by {transport}.", { transport: v.transport === "log" ? t("a log only (development)") : t("your mail relay") }) : t("No alert channel is connected. Set the mail relay in the configuration.")}{v.lastPassAt ? ` ${t("Last check {when}.", { when: dateTime(v.lastPassAt) })}` : ""}</p>
            <div className="row"><button disabled={busy || !v.configured} onClick={() => void sendTest()}>{t("Send a test to me")}</button></div>
            {test ? <div className="note ok" role="status" style={{ marginTop: 10 }}>{test}</div> : null}{err ? <div className="note err" role="alert" style={{ marginTop: 10 }}>{err}</div> : null}
          </>}</Async></Card></div> : null}
      </div>
      {can("alerts.manage") ? <div style={{ marginTop: 16 }}><Addresses onChange={log.reload} /></div> : null}
      {can("alerts.read") ? (
        <>
          <div style={{ marginTop: 16 }}><Card title={t("Open and recent conditions")}>
            <Async state={log} empty={d => d.conditions.length === 0}>{v => (
              <Table label={t("Alert conditions")}><thead><tr><th>{t("Category")}</th><th>{t("State")}</th><th>{t("Reference")}</th><th>{t("First seen")}</th><th>{t("Last notified")}</th><th className="num">{t("Notices")}</th></tr></thead>
                <tbody>{v.conditions.map(c => <tr key={c.condition_key}><td>{t(CATEGORY[c.category]!)}</td><td>{c.state === "open" ? <span className="badge b-warn">{t("Open")}</span> : <span className="badge b-plain">{t("Cleared")}</span>}</td><td className="mono">{c.ref ?? "—"}</td><td>{dateTime(c.first_seen_at)}</td><td>{c.last_notified_at ? dateTime(c.last_notified_at) : "—"}{c.attempts > 0 ? <div className="small muted">{t("retrying")} ({c.attempts})</div> : null}</td><td className="num">{c.notify_count}</td></tr>)}</tbody></Table>
            )}</Async></Card></div>
          <div style={{ marginTop: 16 }}><Card title={t("Messages")} aside={<span className="small muted">{t("Every attempt is recorded and cannot be changed")}</span>}>
            <Async state={log} empty={d => d.deliveries.length === 0}>{v => (
              <Table label={t("Alert messages")}><thead><tr><th>{t("When")}</th><th>{t("Person")}</th><th>{t("Category")}</th><th>{t("Kind")}</th><th>{t("Result")}</th></tr></thead>
                <tbody>{v.deliveries.map(d => { const [cls, label] = STATUS[d.status]!; return <tr key={d.id}><td>{dateTime(d.created_at)}</td><td>{d.person}</td><td>{t(CATEGORY[d.category] ?? d.category)}</td><td>{t(KIND[d.kind]!)}</td><td><span className={`badge ${cls}`}>{t(label)}</span>{d.reason ? <div className="small muted">{WHY[d.reason] ? t(WHY[d.reason]!) : d.reason}</div> : null}</td></tr>; })}</tbody></Table>
            )}</Async></Card></div>
        </>
      ) : null}
    </>
  );
}
