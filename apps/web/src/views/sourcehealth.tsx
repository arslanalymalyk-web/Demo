import { useState, type ReactNode } from "react";
import { api, type SourceHealthRow, type SourceHealthState, type SourceHealthView } from "../api";
import { Async, Card, PageHead, Table, useAction, useApi } from "../components";
import { date, dateTime, num } from "../format";
import { t, tx } from "../i18n";

const BADGE: Record<SourceHealthState, [string, string]> = { healthy: ["b-ok", tx("Healthy")], stale: ["b-warn", tx("Stale")], failing: ["b-bad", tx("Failing")], paused: ["b-warn", tx("Paused")], no_data: ["b-plain", tx("No data yet")], not_approved: ["b-plain", tx("Not approved")] };
const ORDER: SourceHealthState[] = ["failing", "stale", "paused", "no_data", "healthy", "not_approved"];
const age = (h: number | null) => h === null ? t("never") : h < 48 ? t("{n} hours ago", { n: num(h, 0) }) : t("{n} days ago", { n: num(h / 24, 0) });

function Row({ s, can, reload }: { s: SourceHealthRow; can: boolean; reload: () => void }): ReactNode {
  const [open, setOpen] = useState(false), [ask, setAsk] = useState<"pause" | "resume" | null>(null), [reason, setReason] = useState("");
  const a = useAction(() => { setAsk(null); setReason(""); reload(); });
  const [cls, label] = BADGE[s.health];
  const post = (what: "run" | "pause" | "resume") => a.run(() => api(`/v1/sources/${s.sourceKey}/${what}`, { method: "POST", body: what === "run" ? {} : { reason } }));
  return (
    <>
      <tr>
        <td><button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{s.name}</button><div className="small muted">{s.publisher}{s.openCase ? <> · <a href={`#/cases/${s.openCase.id}`}>{s.openCase.caseKey}</a></> : null}</div></td>
        <td><span className={`badge ${cls}`}>{t(label)}</span></td>
        <td>{s.lastSuccessAt ? <>{age(s.lastSuccessAgeHours)}<div className="small muted">{dateTime(s.lastSuccessAt)}</div></> : <span className="muted">{t("never")}</span>}</td>
        <td>{s.scheduled ? (s.paused ? <span className="muted">{t("paused")}</span> : <>{s.nextRunAt ? dateTime(s.nextRunAt) : "—"}<div className="small muted">{t("every {n} h", { n: s.intervalHours ?? 0 })} · {s.mode}</div></>) : <span className="muted">{t("not scheduled")}</span>}</td>
        <td className="num">{s.consecutiveFailures || "—"}</td>
        <td className="num">{s.evidence.quarantined ? <a href={`#/evidence?source=${s.sourceKey}&status=quarantined`}>{s.evidence.quarantined}</a> : 0} <span className="muted">/ {s.evidence.total}</span></td>
        <td>{can && s.scheduled ? <span className="row">
          {!s.paused ? <button disabled={a.busy} onClick={() => void post("run")}>{t("Run now")}</button> : null}
          {s.paused ? <button disabled={a.busy} onClick={() => setAsk("resume")}>{t("Resume")}</button> : <button disabled={a.busy} onClick={() => setAsk("pause")}>{t("Pause")}</button>}
        </span> : null}</td>
      </tr>
      {ask ? <tr><td colSpan={7}><form className="row" onSubmit={e => { e.preventDefault(); void post(ask); }}>
        <label style={{ flex: 1 }}>{ask === "pause" ? t("Why pause fetching") : t("Why resume fetching")} ({t("recorded")})<input type="text" required minLength={10} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <button className="primary" disabled={a.busy}>{ask === "pause" ? t("Pause") : t("Resume")}</button><button type="button" onClick={() => setAsk(null)}>{t("Cancel")}</button></form></td></tr> : null}
      {a.error ? <tr><td colSpan={7}><div className="note err" role="alert">{a.error}</div></td></tr> : null}
      {open ? <tr><td colSpan={7}>
        {s.reasons.length ? <div className="note" role="status">{s.reasons.map((r, i) => <div key={i}>{r}</div>)}{s.pausedReason ? <div className="small muted">{s.pausedReason}</div> : null}</div> : null}
        {s.lastError ? <p className="small"><strong>{t("Last error")}:</strong> <span className="mono">{s.lastError}</span></p> : null}
        {s.series.length ? <Table label={t("Series of {name}", { name: s.name })}><thead><tr><th>{t("Series")}</th><th>{t("Latest period")}</th><th className="num">{t("Age (days)")}</th><th className="num">{t("Allowed")}</th><th>{t("State")}</th></tr></thead>
          <tbody>{s.series.map(x => <tr key={x.seriesKey}><td><a href={`#/series/${x.seriesKey}`}>{x.title}</a></td><td>{date(x.latestPeriod)}</td><td className="num">{x.ageDays ?? "—"}</td><td className="num">{x.maxAgeDays ?? "—"}</td><td>{x.stale ? <span className="badge b-warn">{t("Stale")}</span> : <span className="badge b-ok">{t("Current")}</span>}</td></tr>)}</tbody></Table> : <p className="small muted">{t("This source has no stored series.")}</p>}
        <Table label={t("Recent runs of {name}", { name: s.name })}><thead><tr><th>{t("Started")}</th><th>{t("How")}</th><th>{t("Outcome")}</th><th className="num">{t("New records")}</th><th className="num">{t("Quarantined")}</th><th>{t("Error")}</th></tr></thead>
          <tbody>{s.lastRuns.length === 0 ? <tr><td colSpan={6} className="muted">{t("No run yet.")}</td></tr> : s.lastRuns.map(r => <tr key={r.id}><td>{dateTime(r.startedAt)}</td><td>{r.trigger}</td><td>{r.status}</td><td className="num">{r.stats.inserted ?? "—"}</td><td className="num">{r.stats.quarantined ?? "—"}</td><td className="small mono">{r.error ?? ""}</td></tr>)}</tbody></Table>
      </td></tr> : null}
    </>
  );
}

export function SourceHealth({ can }: { can: (p: string) => boolean }): ReactNode {
  const view = useApi<SourceHealthView>("/v1/sources/health");
  return (
    <>
      <PageHead title={t("Source health")}>{t("Whether each source is fetched on time and still current, read from the stored records. A source that goes stale or keeps failing is backed off, paused after repeated failures, and, when a steward is named in the schedule, opened as a case.")}</PageHead>
      <Async state={view}>{v => {
        const count = (h: SourceHealthState) => v.sources.filter(s => s.health === h).length;
        const rows = [...v.sources].sort((a, b) => ORDER.indexOf(a.health) - ORDER.indexOf(b.health) || a.name.localeCompare(b.name));
        return (
          <>
            {!v.scheduler.enabled ? <div className="note">{t("Scheduled fetching is not running in this deployment, so sources are fetched only when an operator runs the ingest command. Health below is still read from what is stored.")}</div>
              : v.scheduler.scheduleVersion === null ? <div className="note">{t("Scheduled fetching is running, but no schedule has been activated, so nothing is fetched automatically.")} <a href="#/settings">{t("Settings")}</a></div>
              : <div className="note ok" role="status">{t("Schedule version {v} in force. Checked every {s} s. A source pauses after {n} failed fetches in a row.", { v: v.scheduler.scheduleVersion ?? 0, s: v.scheduler.tickSeconds ?? 0, n: v.scheduler.pauseAfterFailures })}{v.scheduler.lastTickAt ? ` ${t("Last check {when}.", { when: dateTime(v.scheduler.lastTickAt) })}` : ""}</div>}
            <div className="grid g4" style={{ marginBottom: 16 }}>{(["healthy", "stale", "failing", "paused"] as const).map(h => <div key={h} className="card stat"><span className="v">{count(h)}</span><span className="l">{t(BADGE[h][1])}</span></div>)}</div>
            <Card title={t("Sources")} aside={<button onClick={view.reload}>{t("Refresh")}</button>}>
              <Table label={t("Source health")}><thead><tr><th>{t("Source")}</th><th>{t("State")}</th><th>{t("Last success")}</th><th>{t("Next run")}</th><th className="num">{t("Failures")}</th><th className="num">{t("Quarantined / records")}</th><th><span className="sr-only">{t("Actions")}</span></th></tr></thead>
                <tbody>{rows.map(s => <Row key={s.sourceKey} s={s} can={can("ingest.manage")} reload={view.reload} />)}</tbody></Table>
            </Card>
          </>
        );
      }}</Async>
    </>
  );
}
