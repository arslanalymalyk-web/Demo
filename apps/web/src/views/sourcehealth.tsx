import { useState, type ReactNode } from "react";
import { api, type SourceHealthRow, type SourceHealthState, type SourceHealthView } from "../api";
import { Async, Card, PageHead, Table, useAction, useApi } from "../components";
import { date, dateTime, num } from "../format";

const BADGE: Record<SourceHealthState, [string, string]> = { healthy: ["b-ok", "Healthy"], stale: ["b-warn", "Stale"], failing: ["b-bad", "Failing"], paused: ["b-warn", "Paused"], no_data: ["b-plain", "No data yet"], not_approved: ["b-plain", "Not approved"] };
const ORDER: SourceHealthState[] = ["failing", "stale", "paused", "no_data", "healthy", "not_approved"];
const age = (h: number | null) => h === null ? "never" : h < 48 ? `${num(h, 0)} hours ago` : `${num(h / 24, 0)} days ago`;

function Row({ s, can, reload }: { s: SourceHealthRow; can: boolean; reload: () => void }): ReactNode {
  const [open, setOpen] = useState(false), [ask, setAsk] = useState<"pause" | "resume" | null>(null), [reason, setReason] = useState("");
  const a = useAction(() => { setAsk(null); setReason(""); reload(); });
  const [cls, label] = BADGE[s.health];
  const post = (what: "run" | "pause" | "resume") => a.run(() => api(`/v1/sources/${s.sourceKey}/${what}`, { method: "POST", body: what === "run" ? {} : { reason } }));
  return (
    <>
      <tr>
        <td><button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{s.name}</button><div className="small muted">{s.publisher}{s.openCase ? <> · <a href={`#/cases/${s.openCase.id}`}>{s.openCase.caseKey}</a></> : null}</div></td>
        <td><span className={`badge ${cls}`}>{label}</span></td>
        <td>{s.lastSuccessAt ? <>{age(s.lastSuccessAgeHours)}<div className="small muted">{dateTime(s.lastSuccessAt)}</div></> : <span className="muted">never</span>}</td>
        <td>{s.scheduled ? (s.paused ? <span className="muted">paused</span> : <>{s.nextRunAt ? dateTime(s.nextRunAt) : "—"}<div className="small muted">every {s.intervalHours} h · {s.mode}</div></>) : <span className="muted">not scheduled</span>}</td>
        <td className="num">{s.consecutiveFailures || "—"}</td>
        <td className="num">{s.evidence.quarantined ? <a href={`#/evidence?source=${s.sourceKey}&status=quarantined`}>{s.evidence.quarantined}</a> : 0} <span className="muted">/ {s.evidence.total}</span></td>
        <td>{can && s.scheduled ? <span className="row">
          {!s.paused ? <button disabled={a.busy} onClick={() => void post("run")}>Run now</button> : null}
          {s.paused ? <button disabled={a.busy} onClick={() => setAsk("resume")}>Resume</button> : <button disabled={a.busy} onClick={() => setAsk("pause")}>Pause</button>}
        </span> : null}</td>
      </tr>
      {ask ? <tr><td colSpan={7}><form className="row" onSubmit={e => { e.preventDefault(); void post(ask); }}>
        <label style={{ flex: 1 }}>{ask === "pause" ? "Why pause fetching" : "Why resume fetching"} (recorded)<input type="text" required minLength={10} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <button className="primary" disabled={a.busy}>{ask === "pause" ? "Pause" : "Resume"}</button><button type="button" onClick={() => setAsk(null)}>Cancel</button></form></td></tr> : null}
      {a.error ? <tr><td colSpan={7}><div className="note err" role="alert">{a.error}</div></td></tr> : null}
      {open ? <tr><td colSpan={7}>
        {s.reasons.length ? <div className="note" role="status">{s.reasons.map((r, i) => <div key={i}>{r}</div>)}{s.pausedReason ? <div className="small muted">{s.pausedReason}</div> : null}</div> : null}
        {s.lastError ? <p className="small"><strong>Last error:</strong> <span className="mono">{s.lastError}</span></p> : null}
        {s.series.length ? <Table label={`Series of ${s.name}`}><thead><tr><th>Series</th><th>Latest period</th><th className="num">Age (days)</th><th className="num">Allowed</th><th>State</th></tr></thead>
          <tbody>{s.series.map(x => <tr key={x.seriesKey}><td><a href={`#/series/${x.seriesKey}`}>{x.title}</a></td><td>{date(x.latestPeriod)}</td><td className="num">{x.ageDays ?? "—"}</td><td className="num">{x.maxAgeDays ?? "—"}</td><td>{x.stale ? <span className="badge b-warn">Stale</span> : <span className="badge b-ok">Current</span>}</td></tr>)}</tbody></Table> : <p className="small muted">This source has no stored series.</p>}
        <Table label={`Recent runs of ${s.name}`}><thead><tr><th>Started</th><th>How</th><th>Outcome</th><th className="num">New records</th><th className="num">Quarantined</th><th>Error</th></tr></thead>
          <tbody>{s.lastRuns.length === 0 ? <tr><td colSpan={6} className="muted">No run yet.</td></tr> : s.lastRuns.map(r => <tr key={r.id}><td>{dateTime(r.startedAt)}</td><td>{r.trigger}</td><td>{r.status}</td><td className="num">{r.stats.inserted ?? "—"}</td><td className="num">{r.stats.quarantined ?? "—"}</td><td className="small mono">{r.error ?? ""}</td></tr>)}</tbody></Table>
      </td></tr> : null}
    </>
  );
}

export function SourceHealth({ can }: { can: (p: string) => boolean }): ReactNode {
  const view = useApi<SourceHealthView>("/v1/sources/health");
  return (
    <>
      <PageHead title="Source health">Whether each source is fetched on time and still current, read from the stored records. A source that goes stale or keeps failing is backed off, paused after repeated failures, and, when a steward is named in the schedule, opened as a case.</PageHead>
      <Async state={view}>{v => {
        const count = (h: SourceHealthState) => v.sources.filter(s => s.health === h).length;
        const rows = [...v.sources].sort((a, b) => ORDER.indexOf(a.health) - ORDER.indexOf(b.health) || a.name.localeCompare(b.name));
        return (
          <>
            {!v.scheduler.enabled ? <div className="note">Scheduled fetching is not running in this deployment, so sources are fetched only when an operator runs the ingest command. Health below is still read from what is stored.</div>
              : v.scheduler.scheduleVersion === null ? <div className="note">Scheduled fetching is running, but no schedule has been activated, so nothing is fetched automatically. Draft one under <a href="#/settings">Settings</a>; a second administrator activates it.</div>
              : <div className="note ok" role="status">Schedule version {v.scheduler.scheduleVersion} in force. Checked every {v.scheduler.tickSeconds} s{v.scheduler.lastTickAt ? `, last at ${dateTime(v.scheduler.lastTickAt)}` : ""}. A source pauses after {v.scheduler.pauseAfterFailures} failed fetches in a row.</div>}
            <div className="grid g4" style={{ marginBottom: 16 }}>{(["healthy", "stale", "failing", "paused"] as const).map(h => <div key={h} className="card stat"><span className="v">{count(h)}</span><span className="l">{BADGE[h][1]}</span></div>)}</div>
            <Card title="Sources" aside={<button onClick={view.reload}>Refresh</button>}>
              <Table label="Source health"><thead><tr><th>Source</th><th>State</th><th>Last success</th><th>Next run</th><th className="num">Failures</th><th className="num">Quarantined / records</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>{rows.map(s => <Row key={s.sourceKey} s={s} can={can("ingest.manage")} reload={view.reload} />)}</tbody></Table>
            </Card>
          </>
        );
      }}</Async>
    </>
  );
}
