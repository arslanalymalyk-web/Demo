import { useState, type ReactNode } from "react";
import { ApiError, api, type CaseListRow, type Figure, type Me, type RunSummary, type SectorView, type Signal, type TemplateInfo } from "../api";
import { Async, Card, CaseState, DataClass, LazyProvenance, LineChart, PageHead, Status, Table, useApi } from "../components";
import { ageDays, date, dateTime, month, num, pct } from "../format";

const DOMAINS: Record<"energy" | "sovereign", string[]> = { energy: ["energy"], sovereign: ["sovereign capital", "treasury"] };
const PACK_TEMPLATES: Record<"energy" | "sovereign", string> = { energy: "energy", sovereign: "sovereign" };

function sar(v: number): string { return v >= 1_000_000 ? `SAR ${num(v / 1_000_000, 2)} trillion` : v >= 1000 ? `SAR ${num(v / 1000, 1)} billion` : `SAR ${num(v, 0)} million`; }
export function show(f: { unit: string; value: number }): string {
  if (f.unit === "US$ per barrel") return `US$ ${num(f.value, 1)}`;
  if (f.unit === "thousand barrels per day") return `${num(f.value, 0)} kb/d`;
  if (f.unit === "million SAR") return sar(f.value);
  if (f.unit.startsWith("%")) return `${num(f.value, 1)}%`;
  return num(f.value, 1);
}
export const ARROW = { up: "▲", down: "▼", flat: "▬" } as const;

function FigureCard({ f }: { f: Figure }): ReactNode {
  return (
    <div className="card figure">
      <span className="l">{f.label}</span>
      <span className="v">{show(f)}</span>
      <span className="s">{[f.unit === "thousand barrels per day" ? "thousand barrels per day" : f.unit.startsWith("%") ? f.unit.replace(/^%\s*/, "") : "", month(f.period)].filter(Boolean).join(" · ")}</span>
      {f.change ? <span className={`chg ${f.change.direction}`}><span aria-hidden="true">{ARROW[f.change.direction]}</span> {f.change.text}</span> : null}
      <span className="row small"><DataClass value="public_record" /><Status value={f.validation} /></span>
      {f.note ? <span className="small muted">{f.note}</span> : null}
      <LazyProvenance evidenceId={f.evidenceId} />
    </div>
  );
}

function SignalRow({ s, pack, can, caseFor, reload }: { s: Signal; pack: string; can: (p: string) => boolean; caseFor: CaseListRow | undefined; reload: () => void }): ReactNode {
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  async function open() {
    setBusy(true); setErr(null);
    try { const r = await api<{ id: string }>(`/v1/sectors/${pack}/signals/${encodeURIComponent(s.id)}/case`, { method: "POST", body: {} }); reload(); location.hash = `#/cases/${r.id}`; }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not open a case."); setBusy(false); }
  }
  return (
    <li className={`signal sev-${s.severity}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row"><span className={`badge ${s.severity === "alert" ? "b-bad" : "b-warn"}`}><span className="dot" aria-hidden="true" />{s.severity === "alert" ? "Alert" : "Watch"}</span><strong>{s.title}</strong></span>
        <span className="small muted mono">rule {s.ruleId} · {month(s.observedAt)}</span>
      </div>
      <p className="small" style={{ margin: "6px 0 8px" }}>{s.detail}</p>
      <div className="row small">
        {s.evidenceIds.map(e => <a key={e} href={`#/evidence/${e}`} className="mono">evidence {e.slice(0, 8)}</a>)}
        <span className="grow" style={{ flex: 1 }} />
        {caseFor ? <a className="btn" href={`#/cases/${caseFor.id}`}>Case {caseFor.case_key} · <CaseState value={caseFor.state} /></a> : can("case.write") ? <button disabled={busy} onClick={() => void open()}>{busy ? "Opening…" : "Open a case"}</button> : null}
      </div>
      {err ? <div className="note err" role="alert" style={{ marginTop: 8 }}>{err}</div> : null}
    </li>
  );
}

export function SectorCentre({ pack, me, can }: { pack: "energy" | "sovereign"; me: Me; can: (p: string) => boolean }): ReactNode {
  const view = useApi<SectorView>(`/v1/sectors/${pack}`);
  const cases = useApi<CaseListRow[]>(can("case.read") ? "/v1/cases" : null);
  const runs = useApi<RunSummary[]>(can("scenario.read") ? "/v1/scenarios/runs" : null);
  const tpl = useApi<TemplateInfo[]>(can("scenario.read") ? "/v1/scenarios/templates" : null);
  const mine = (cases.data ?? []).filter(c => DOMAINS[pack].includes(c.domain));
  const bySignal = new Map((cases.data ?? []).filter(c => c.signal_id && c.state !== "closed").map(c => [c.signal_id!, c]));
  return (
    <Async state={view}>{v => (
      <>
        <PageHead title={v.name} aside={<span className="row"><DataClass value="public_record" /><span className="badge b-plain">Computed {dateTime(v.asOf)}</span></span>}>
          What changed, what needs attention, and what is open. Every figure is read from stored public records and opens to its source. Institution-specific exposure appears here once client data is connected; until then any such content is labelled Sample dataset.
        </PageHead>

        {v.figures.length === 0 ? <div className="note">No data for this pack is stored yet. Ingest its sources first.</div> : <div className="grid g3" style={{ marginBottom: 16 }}>{v.figures.map(f => <FigureCard key={f.id} f={f} />)}</div>}

        <Card title="Attention queue" aside={<span className="small muted">{v.signals.length} active · rules {v.rulesVersion}</span>}>
          {v.signals.length === 0 ? <div className="empty">No rule is firing on the stored data. Nothing needs attention from these checks.</div> : <ul className="signals">{v.signals.map(s => <SignalRow key={s.id} s={s} pack={pack} can={can} caseFor={bySignal.get(s.id)} reload={cases.reload} />)}</ul>}
          <details style={{ marginTop: 12 }}><summary>How signals are made</summary>
            <p className="small muted">Fixed rules over stored series. No model decides what is surfaced. Thresholds are first-release defaults, to be set by the institution.</p>
            <Table label="Signal rules"><thead><tr><th>Rule</th><th>Checks</th><th>Thresholds</th></tr></thead><tbody>{v.rules.map(r => <tr key={r.id}><td className="mono">{r.id}</td><td><strong>{r.title}</strong><div className="small muted">{r.description}</div></td><td className="small">{r.thresholds}</td></tr>)}</tbody></Table>
          </details>
        </Card>

        <div className="grid g2" style={{ margin: "16px 0" }}>{v.trends.map(t => (
          <Card key={t.id} title={t.title} aside={<DataClass value="public_record" />}>
            <LineChart title={t.title} unit={t.unit} points={t.points.map(p => ({ x: new Date(p.t).getTime(), y: p.v, label: month(p.t) }))} />
            <p className="small muted" style={{ marginTop: 8 }}>Latest point {month(t.points[t.points.length - 1]!.t)} · <a href={`#/evidence/${t.evidenceId}`}>source record</a></p>
          </Card>))}</div>

        {v.countries ? (
          <Card title="Gulf producers" aside={<span className="small muted">Latest month against the median of the 12 months before</span>}>
            <Table label="Gulf producers"><thead><tr><th>Country</th><th className="num">Exports (kb/d)</th><th className="num">12-month median</th><th className="num">Change</th><th className="num">Production (kb/d)</th><th>Period</th></tr></thead>
              <tbody>{v.countries.map(c => <tr key={c.code} style={c.lagging ? { opacity: 0.7 } : undefined}><td><a href={`#/evidence/${c.evidenceId}`}>{c.name}</a></td><td className="num">{num(c.exportsKbd, 0)}</td><td className="num">{num(c.medianKbd, 0)}</td><td className={`num chg ${c.changePct === null ? "flat" : c.changePct < -0.0005 ? "down" : c.changePct > 0.0005 ? "up" : "flat"}`}>{c.lagging ? <span className="muted small">No data since {month(c.period)}</span> : c.changePct === null ? "—" : `${c.changePct > 0 ? "+" : c.changePct < 0 ? "−" : ""}${num(Math.abs(c.changePct) * 100, 1)}%`}</td><td className="num">{c.productionKbd === null ? "—" : num(c.productionKbd, 0)}</td><td>{month(c.period)}</td></tr>)}</tbody></Table>
          </Card>
        ) : null}

        {v.composition ? (
          <Card title={`Reserve assets by class, ${month(v.composition.quarter)}`} aside={<span className="small muted">Published composition. Shares need no unit assumption.</span>}>
            <div className="stackbar" role="img" aria-label={v.composition.rows.map(r => `${r.label} ${pct(r.share, 1)}`).join(", ")}>{v.composition.rows.filter(r => r.share > 0.004).map((r, i) => <span key={r.label} className={`seg-${i % 5}`} style={{ width: `${r.share * 100}%` }} title={`${r.label}: ${pct(r.share, 1)}`} />)}</div>
            <Table label="Reserve composition"><thead><tr><th>Class</th><th className="num">Million SAR</th><th className="num">Share</th></tr></thead>
              <tbody>{v.composition.rows.map((r, i) => <tr key={r.label}><td><span className={`swatch seg-${i % 5}`} aria-hidden="true" /> <a href={`#/evidence/${r.evidenceId}`}>{r.label}</a></td><td className="num">{num(r.millionSar, 0)}</td><td className="num">{pct(r.share, 1)}</td></tr>)}</tbody></Table>
          </Card>
        ) : null}

        <div className="grid g2" style={{ margin: "16px 0" }}>
          <Card title="Scenarios in this pack" aside={<a href="#/scenarios">Open Scenarios</a>}>
            <Async state={tpl}>{ts => (
              <ul className="plain">{ts.filter(t => t.pack === PACK_TEMPLATES[pack]).map(t => {
                const last = (runs.data ?? []).find(r => r.template_key === t.key);
                return <li key={t.key} className="opt"><div className="row" style={{ justifyContent: "space-between" }}><strong>{t.title}</strong>{last ? <Status value={last.confidence} /> : <span className="small muted">Not run yet</span>}</div>
                  <p className="small muted" style={{ margin: "4px 0 0" }}>{last ? <>Latest run <a href={`#/scenarios/runs/${last.id}`} className="mono">{last.id.slice(0, 8)}</a>, {dateTime(last.created_at)}</> : t.description}</p></li>;
              })}</ul>
            )}</Async>
            <span className="badge b-gold">Scenario simulation</span>
          </Card>
          <Card title="Cases" aside={<a href="#/cases">All cases</a>}>
            <Async state={cases} empty={() => mine.length === 0}>{() => <>
              {mine.filter(c => c.state === "in_review" && c.reviewer_id === me.id).length ? <div className="note" role="status"><strong>Waiting for your decision:</strong> {mine.filter(c => c.state === "in_review" && c.reviewer_id === me.id).map(c => <a key={c.id} href={`#/cases/${c.id}`} style={{ marginInlineEnd: 10 }}>{c.case_key}</a>)}</div> : null}
              <Table label="Cases in this pack"><thead><tr><th>Case</th><th>State</th><th>Updated</th></tr></thead>
                <tbody>{mine.slice(0, 8).map(c => <tr key={c.id}><td><a href={`#/cases/${c.id}`}><span className="mono">{c.case_key}</span> {c.title}</a></td><td><CaseState value={c.state} /></td><td>{date(c.updated_at)}</td></tr>)}</tbody></Table></>}</Async>
          </Card>
        </div>

        <Card title="Data freshness" aside={<span className="small muted">Stale means the latest period is older than the series allows</span>}>
          <Table label="Freshness"><thead><tr><th>Series</th><th>Source</th><th>Latest period</th><th>Evidence</th><th>Freshness</th></tr></thead>
            <tbody>{v.freshness.map(s => { const stale = s.latestPeriod && s.maxAgeDays ? ageDays(s.latestPeriod, new Date(v.asOf).getTime()) > s.maxAgeDays : false; return <tr key={s.seriesKey}><td><a href={`#/series/${s.seriesKey}`}>{s.title}</a><div className="small muted">{s.frequency}</div></td><td>{s.sourceKey}</td><td>{date(s.latestPeriod)}</td><td><Status value={s.validation} /></td><td>{s.latestPeriod ? <Status value={stale ? "stale" : "current"} /> : "—"}</td></tr>; })}</tbody></Table>
        </Card>
      </>
    )}</Async>
  );
}
