import { useState, type ReactNode } from "react";
import { type Briefing } from "../api";
import { Async, CaseState, DataClass, LazyProvenance, PageHead, Status, useApi } from "../components";
import { date, dateTime, month } from "../format";
import { t, tx } from "../i18n";
import { ARROW, show } from "./sector";

const LEVEL: Record<Briefing["headline"]["level"], string> = { attention: tx("Needs attention"), watch: tx("On watch"), clear: tx("Clear"), no_data: tx("No data") };
const KIND: Record<string, string> = { stale: tx("stale"), lagging: tx("lagging"), unvalidated: tx("unvalidated"), note: tx("note") };

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }): ReactNode {
  return <section className="brief-sec" style={{ animationDelay: `${n * 90}ms` }}><h2>{title}</h2>{children}</section>;
}
/** Sentences composed from stored records are English in this release. They keep their own direction inside an Arabic page. */
const Data = ({ children }: { children: ReactNode }): ReactNode => <span lang="en" dir="auto">{children}</span>;

export function BriefingView({ pack }: { pack: "energy" | "sovereign" }): ReactNode {
  const state = useApi<Briefing>(`/v1/briefings/${pack}`);
  const [msg, setMsg] = useState<string | null>(null);
  function save(b: Briefing) {
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `briefing-${b.pack}-${b.asOf.slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(a.href);
    setMsg(t("Saved. The file carries its own content hash, so a copy can be checked later."));
  }
  return (
    <Async state={state}>{b => (
      <article className="brief">
        <PageHead title={t("Briefing: {name}", { name: b.pack === "energy" ? t("Energy and Oil") : t("Sovereign Capital and Treasury") })} aside={<span className="row no-print"><DataClass value="public_record" /><button onClick={() => window.print()}>{t("Print")}</button><button onClick={() => save(b)}>{t("Save a copy")}</button><button onClick={state.reload}>{t("Refresh")}</button></span>}>
          {t("Composed by fixed code from stored public records, the cases you may see, and stored scenario runs. No model wrote any sentence here.")}
        </PageHead>
        {msg ? <div className="note ok no-print" role="status">{msg}</div> : null}

        <div className={`brief-head level-${b.headline.level}`} role="status">
          <span className="badge b-plain">{t(LEVEL[b.headline.level])}</span>
          <p><Data>{b.headline.text}</Data></p>
          <span className="small muted">{t("As of {when}", { when: dateTime(b.asOf) })} · {t("rules")} {b.rulesVersion}{b.settingsVersion !== null ? ` · ${t("settings v{n}", { n: b.settingsVersion })}` : ` · ${t("default thresholds")}`}</span>
        </div>

        <Section n={1} title={t("What changed")}>
          {b.changes.length === 0 ? <p className="muted">{t("No stored figure carries a comparison yet.")}</p> : <ul className="plain brief-changes">{b.changes.map(c => (
            <li key={c.id}><span className="l"><Data>{c.label}</Data></span> <strong><Data>{show(c)}</Data></strong> <span className={`chg ${c.direction}`}><span aria-hidden="true">{ARROW[c.direction]}</span> <Data>{c.change}</Data></span> <span className="small muted">{month(c.period)}</span> <LazyProvenance evidenceId={c.evidenceId} /></li>))}</ul>}
        </Section>

        <Section n={2} title={t("What needs attention")}>
          {b.signals.length === 0 ? <p className="muted">{t("No rule is firing on the stored data.")}</p> : <ul className="plain">{b.signals.map(s => (
            <li key={s.id} className={`signal sev-${s.severity}`}>
              <div className="row"><span className={`badge ${s.severity === "alert" ? "b-bad" : "b-warn"}`}><span className="dot" aria-hidden="true" />{s.severity === "alert" ? t("Alert") : t("Watch")}</span><strong><Data>{s.title}</Data></strong></div>
              <p className="small" style={{ margin: "6px 0" }}><Data>{s.detail}</Data></p>
              <div className="row small"><span className="muted mono">{t("rule")} {s.ruleId}</span>{s.evidenceIds.map(e => <a key={e} className="mono" href={`#/evidence/${e}`}>{t("evidence")} {e.slice(0, 8)}</a>)}{s.caseId ? <a href={`#/cases/${s.caseId}`}>{t("Case")} {s.caseKey}</a> : <span className="muted">{t("No case opened")}</span>}</div>
            </li>))}</ul>}
        </Section>

        {b.openCases ? (
          <Section n={3} title={t("Open decisions")}>
            {b.openCases.length === 0 ? <p className="muted">{t("No open case in this pack.")}</p> : <ul className="plain">{b.openCases.map(c => (
              <li key={c.id} className="row"><a href={`#/cases/${c.id}`}><span className="mono">{c.caseKey}</span> {c.title}</a><CaseState value={c.state} />{c.waitingFor ? <span className="small muted">{t("waiting for the reviewer")}</span> : null}<span className="small muted">{t("updated {when}", { when: date(c.updatedAt) })}</span></li>))}</ul>}
          </Section>
        ) : null}

        {b.scenarios ? (
          <Section n={4} title={t("Scenarios")}>
            <ul className="plain">{b.scenarios.map(s => (
              <li key={s.key} className="row"><strong>{s.title}</strong>{s.runId ? <><Status value={s.confidence} /><a className="mono" href={`#/scenarios/runs/${s.runId}`}>{s.runId.slice(0, 8)}</a><span className="small muted">{dateTime(s.ranAt!)}</span></> : <span className="small muted">{t("Not run yet")}</span>}<span className="badge b-gold">{t(s.label)}</span></li>))}</ul>
          </Section>
        ) : null}

        <Section n={5} title={t("Read with care")}>
          {b.caveats.length === 0 ? <p className="muted">{t("No data caveat applies.")}</p> : <ul className="plain">{b.caveats.map((c, i) => <li key={i} className="small"><span className="badge b-plain">{t(KIND[c.kind] ?? c.kind)}</span> <Data>{c.text}</Data> {c.evidenceId ? <a className="mono" href={`#/evidence/${c.evidenceId}`}>{t("source")}</a> : null}</li>)}</ul>}
        </Section>

        <footer className="small muted brief-foot">{t("Content hash")} <span className="mono">{b.contentHash}</span>. {t("Confidential. Property of Tiger Capital AI.")}</footer>
      </article>
    )}</Async>
  );
}
