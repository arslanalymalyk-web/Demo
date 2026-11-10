import { useState, type ReactNode } from "react";
import { type Briefing } from "../api";
import { Async, CaseState, DataClass, LazyProvenance, PageHead, Status, useApi } from "../components";
import { date, dateTime, month } from "../format";
import { ARROW, show } from "./sector";

const LEVEL: Record<Briefing["headline"]["level"], string> = { attention: "Needs attention", watch: "On watch", clear: "Clear", no_data: "No data" };

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }): ReactNode {
  return <section className="brief-sec" style={{ animationDelay: `${n * 90}ms` }}><h2>{title}</h2>{children}</section>;
}

export function BriefingView({ pack }: { pack: "energy" | "sovereign" }): ReactNode {
  const state = useApi<Briefing>(`/v1/briefings/${pack}`);
  const [msg, setMsg] = useState<string | null>(null);
  function save(b: Briefing) {
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `briefing-${b.pack}-${b.asOf.slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(a.href);
    setMsg("Saved. The file carries its own content hash, so a copy can be checked later.");
  }
  return (
    <Async state={state}>{b => (
      <article className="brief">
        <PageHead title={`Briefing: ${b.name}`} aside={<span className="row no-print"><DataClass value="public_record" /><button onClick={() => window.print()}>Print</button><button onClick={() => save(b)}>Save a copy</button><button onClick={state.reload}>Refresh</button></span>}>
          Composed by fixed code from stored public records, the cases you may see, and stored scenario runs. No model wrote any sentence here.
        </PageHead>
        {msg ? <div className="note ok no-print" role="status">{msg}</div> : null}

        <div className={`brief-head level-${b.headline.level}`} role="status">
          <span className="badge b-plain">{LEVEL[b.headline.level]}</span>
          <p>{b.headline.text}</p>
          <span className="small muted">As of {dateTime(b.asOf)} · rules {b.rulesVersion}{b.settingsVersion !== null ? ` · settings v${b.settingsVersion}` : " · default thresholds"}</span>
        </div>

        <Section n={1} title="What changed">
          {b.changes.length === 0 ? <p className="muted">No stored figure carries a comparison yet.</p> : <ul className="plain brief-changes">{b.changes.map(c => (
            <li key={c.id}><span className="l">{c.label}</span> <strong>{show(c)}</strong> <span className={`chg ${c.direction}`}><span aria-hidden="true">{ARROW[c.direction]}</span> {c.change}</span> <span className="small muted">{month(c.period)}</span> <LazyProvenance evidenceId={c.evidenceId} /></li>))}</ul>}
        </Section>

        <Section n={2} title="What needs attention">
          {b.signals.length === 0 ? <p className="muted">No rule is firing on the stored data.</p> : <ul className="plain">{b.signals.map(s => (
            <li key={s.id} className={`signal sev-${s.severity}`}>
              <div className="row"><span className={`badge ${s.severity === "alert" ? "b-bad" : "b-warn"}`}><span className="dot" aria-hidden="true" />{s.severity === "alert" ? "Alert" : "Watch"}</span><strong>{s.title}</strong></div>
              <p className="small" style={{ margin: "6px 0" }}>{s.detail}</p>
              <div className="row small"><span className="muted mono">rule {s.ruleId}</span>{s.evidenceIds.map(e => <a key={e} className="mono" href={`#/evidence/${e}`}>evidence {e.slice(0, 8)}</a>)}{s.caseId ? <a href={`#/cases/${s.caseId}`}>Case {s.caseKey}</a> : <span className="muted">No case opened</span>}</div>
            </li>))}</ul>}
        </Section>

        {b.openCases ? (
          <Section n={3} title="Open decisions">
            {b.openCases.length === 0 ? <p className="muted">No open case in this pack.</p> : <ul className="plain">{b.openCases.map(c => (
              <li key={c.id} className="row"><a href={`#/cases/${c.id}`}><span className="mono">{c.caseKey}</span> {c.title}</a><CaseState value={c.state} />{c.waitingFor ? <span className="small muted">waiting for the reviewer</span> : null}<span className="small muted">updated {date(c.updatedAt)}</span></li>))}</ul>}
          </Section>
        ) : null}

        {b.scenarios ? (
          <Section n={4} title="Scenarios">
            <ul className="plain">{b.scenarios.map(s => (
              <li key={s.key} className="row"><strong>{s.title}</strong>{s.runId ? <><Status value={s.confidence} /><a className="mono" href={`#/scenarios/runs/${s.runId}`}>{s.runId.slice(0, 8)}</a><span className="small muted">{dateTime(s.ranAt!)}</span></> : <span className="small muted">Not run yet</span>}<span className="badge b-gold">{s.label}</span></li>))}</ul>
          </Section>
        ) : null}

        <Section n={5} title="Read with care">
          {b.caveats.length === 0 ? <p className="muted">No data caveat applies.</p> : <ul className="plain">{b.caveats.map((c, i) => <li key={i} className="small"><span className="badge b-plain">{c.kind}</span> {c.text} {c.evidenceId ? <a className="mono" href={`#/evidence/${c.evidenceId}`}>source</a> : null}</li>)}</ul>}
        </Section>

        <footer className="small muted brief-foot">Content hash <span className="mono">{b.contentHash}</span>. Confidential. Property of Tiger Capital AI.</footer>
      </article>
    )}</Async>
  );
}
