import { useState, type ReactNode } from "react";
import { api, ApiError, type Backtest, type Param, type ReplayResult, type ResultRow, type RunDetail, type RunSummary, type TemplateInfo } from "../api";
import { Async, Card, LinkClass, PageHead, SimulationBadge, Stat, Status, Table, Tornado, useApi } from "../components";
import { dateTime, month, musd, num, pct, short } from "../format";

const HORIZONS = ["72h", "90d", "1y", "5y"] as const;
const LABEL: Record<string, string> = {
  brent_end_usd: "Brent at end of horizon", brent_avg_usd: "Brent average over horizon", lost_supply_kbd: "Supply lost while the event lasts", gulf_revenue_delta_musd: "Gulf crude export revenue change", sa_reserve_drawdown_pct: "Saudi reserve draw",
  reserves_remaining_musd: "Reserve assets remaining", reserves_remaining_pct: "Reserve assets remaining, share of today's", liquid_assets_remaining_musd: "Liquid assets remaining", runway_years: "Reserve runway", liquid_runway_years: "Liquid-asset runway",
  crude_export_revenue_musd: "Saudi crude export revenue", delta_musd: "Change in crude export revenue", delta_pct_of_annual_gdp: "Change, as a share of one year's GDP", crude_export_revenue_share_of_gdp_pct: "Crude export revenue, share of annual GDP", oil_activity_share_of_gdp_pct: "Oil activities, share of GDP",
  reserves_value_musd: "Reserve assets after the shock", change_musd: "Change in reserve value", change_pct: "Change in reserve value, share", liquid_share_pct: "Liquid assets, share of reserves", securities_share_pct: "Foreign securities, share of reserves",
};
const HEADLINE_ORDER = Object.keys(LABEL);
const NAMES: Record<string, string> = {
  restrictionPct: "Share of transit restricted", durationDays: "Duration (days)", rerouteEfficiency: "Bypass usable (share)", hormuzShareScale: "Hormuz exposure scale", bypassScale: "Bypass capacity scale",
  priceFlexibility: "Price flexibility", halfLifeDays: "Premium half-life (days)", globalSupplyKbd: "Global supply (kb/d)", reserveDrawShare: "Reserve draw share", usdPerSar: "US$ per riyal", priceShockPct: "Price change (%)",
  curtailmentPct: "Output withheld (%)", participation: "Share of the cut delivered", annualGapUsdBn: "Annual financing gap (US$ bn)", reserveFundingShare: "Share met from reserves", assetReturnPct: "Return on reserves (% a year)",
  priceChangePct: "Price change (%)", volumeChangePct: "Export volume change (%)", gdpUnitScale: "GDP unit scale (assumed million SAR)", securitiesShockPct: "Foreign securities shock (%)", depositsShockPct: "Deposits abroad shock (%)", goldShockPct: "Gold shock (%)", otherShockPct: "IMF position and SDR shock (%)", recoveryHalfLifeDays: "Recovery half-life (days)",
};
const human = (k: string): string => NAMES[k] ?? k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());
const isChange = (metric: string): boolean => /delta|change/.test(metric);
const fmtValue = (unit: string, v: number, metric = "delta"): string => unit === "million US$" ? (isChange(metric) ? musd(v) : musd(v).replace(/^[+−]/, v < 0 ? "−" : "")) : unit.startsWith("US$") ? `US$ ${num(v, 1)}` : unit.startsWith("%") ? `${num(v, 2)}%` : unit === "years" ? (v >= 99 ? "99+ years" : `${num(v, 1)} years`) : num(v, 0);
const metricLabel = (m: string): string => LABEL[m] ?? (m.startsWith("revenue_delta_musd:") ? `Export revenue change, ${m.split(":")[1]}` : m);

export function Scenarios({ can }: { can: (p: string) => boolean }): ReactNode {
  const tpl = useApi<TemplateInfo[]>("/v1/scenarios/templates");
  const runs = useApi<RunSummary[]>("/v1/scenarios/runs");
  const bt = useApi<Backtest | { available: false; reason: string }>("/v1/scenarios/backtest");
  return (
    <>
      <PageHead title="Scenarios" aside={<SimulationBadge />}>Deterministic calculators run over four horizons. Every parameter shows whether it is assumed, sourced or calibrated, and every result carries a range and a replayable record.</PageHead>
      {can("scenario.run") ? <Async state={tpl}>{t => <Builder templates={t} />}</Async> : <div className="note">Your role can read scenarios but not run them.</div>}
      <div className="grid g2" style={{ marginTop: 16 }}>
        <Card title="Past runs">
          <Async state={runs} empty={d => d.length === 0}>{r => (
            <Table label="Scenario runs"><thead><tr><th>Run</th><th>Template</th><th>Confidence</th><th>Created</th></tr></thead>
              <tbody>{r.map(x => <tr key={x.id}><td><a href={`#/scenarios/runs/${x.id}`} className="mono">{x.id.slice(0, 8)}</a></td><td>{x.template_key}</td><td><Status value={x.confidence} /></td><td>{dateTime(x.created_at)}</td></tr>)}</tbody></Table>
          )}</Async>
        </Card>
        <Card title="Back-test of the Mar–May 2026 episode" aside={<span className="badge b-warn">In-sample</span>}>
          <Async state={bt}>{b => "available" in b ? <div className="note" role="status">{b.reason}</div> : <>
            <p className="small">{b.statement}</p>
            <Table label="Back-test"><thead><tr><th>Month</th><th className="num">Lost kb/d</th><th className="num">Observed</th><th className="num">Model</th></tr></thead>
              <tbody>{b.rows.map(r => <tr key={r.month}><td style={{ whiteSpace: "nowrap" }}>{r.month}</td><td className="num">{num(r.lostKbd, 0)}</td><td className="num">{pct(r.observedPremium, 1)}</td><td className="num">{pct(r.modelPremium, 1)}</td></tr>)}</tbody></Table>
            <p className="small muted" style={{ marginTop: 8 }}>Fitted flexibility {b.flexibility ? num(b.flexibility, 1) : "n/a"} · mean absolute error {b.meanAbsError !== null ? `${num(b.meanAbsError * 100, 1)} points` : "n/a"} · baseline {b.baselineMonth} at US$ {num(b.baselinePrice, 1)}</p>
          </>}</Async>
        </Card>
      </div>
    </>
  );
}

function Builder({ templates }: { templates: TemplateInfo[] }): ReactNode {
  const [key, setKey] = useState(templates[0]?.key ?? ""), [vals, setVals] = useState<Record<string, string>>({}), [mon, setMon] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const t = templates.find(x => x.key === key)!;
  const changed = Object.entries(vals).filter(([k, v]) => v !== "" && Number(v) !== t.parameters[k]?.value);
  async function run() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: string }>("/v1/scenarios/runs", { method: "POST", body: { template: key, ...(mon ? { baselineMonth: mon } : {}), overrides: Object.fromEntries(changed.map(([k, v]) => [k, Number(v)])) } });
      location.hash = `#/scenarios/runs/${r.id}`;
    } catch (e) { setErr(e instanceof ApiError ? e.message : "The run failed."); setBusy(false); }
  }
  return (
    <Card title="Run a scenario">
      {[...new Set(templates.map(x => x.packName))].map(pack => (
        <div key={pack} style={{ marginBottom: 10 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>{pack}</div>
          <div className="row" role="radiogroup" aria-label={`${pack} templates`}>
            {templates.filter(x => x.packName === pack).map(x => <button key={x.key} role="radio" aria-checked={x.key === key} className={x.key === key ? "primary" : ""} onClick={() => { setKey(x.key); setVals({}); }}>{x.title}</button>)}
          </div>
        </div>
      ))}
      <p>{t.description}</p>
      <div className="row" style={{ margin: "10px 0" }}>
        <label>Baseline month (blank for latest)<input type="month" value={mon} onChange={e => setMon(e.target.value)} /></label>
      </div>
      <Table label="Parameters"><thead><tr><th>Parameter</th><th className="num">Value</th><th className="num">Range</th><th>Basis</th><th>What it means</th></tr></thead>
        <tbody>{Object.entries(t.parameters).map(([k, p]: [string, Param]) => <tr key={k}><td>{human(k)}</td>
          <td className="num"><input type="number" step="any" aria-label={human(k)} value={vals[k] ?? String(p.value)} onChange={e => setVals(v => ({ ...v, [k]: e.target.value }))} /></td>
          <td className="num">{p.low === p.high ? "fixed" : `${num(p.low, 2)} – ${num(p.high, 2)}`}</td><td><LinkClass value={p.basis} /></td><td className="small muted" style={{ maxWidth: "50ch" }}>{p.note}</td></tr>)}</tbody></Table>
      {err ? <div className="note err" role="alert" style={{ marginTop: 12 }}>{err}</div> : null}
      <div className="row" style={{ marginTop: 14 }}><button className="primary" disabled={busy} onClick={run}>{busy ? "Running…" : "Run scenario"}</button><span className="small muted">{changed.length ? `${changed.length} parameter${changed.length > 1 ? "s" : ""} changed from the defaults.` : "Defaults."}</span></div>
    </Card>
  );
}

export function RunView({ id }: { id: string }): ReactNode {
  const r = useApi<RunDetail>(`/v1/scenarios/runs/${id}`);
  return <>
    <PageHead title="Scenario run" aside={<><SimulationBadge /><a className="btn" href="#/scenarios">All scenarios</a></>}>A stored, immutable calculation. Replay recomputes it from its own stored inputs and checks the hashes.</PageHead>
    <Async state={r}>{d => <RunBody run={d} />}</Async>
  </>;
}

function RunBody({ run }: { run: RunDetail }): ReactNode {
  const metrics = [...new Set(run.results.map(x => x.metric))];
  const tpl = useApi<TemplateInfo[]>("/v1/scenarios/templates");
  const info = tpl.data?.find(t => t.key === run.template);
  const [metricPick, setMetric] = useState<string | null>(null), [hzPick, setHz] = useState<string | null>(null);
  const metric = metricPick ?? info?.headline.metric ?? metrics[0]!, hz = hzPick ?? info?.headline.horizon ?? "90d";
  const [replay, setReplay] = useState<ReplayResult | null>(null), [rerr, setRerr] = useState<string | null>(null);
  const get = (h: string, m: string): ResultRow | undefined => run.results.find(x => x.horizon === h && x.metric === m);
  const headline = HEADLINE_ORDER.filter(m => metrics.includes(m));
  const countries = metrics.filter(m => m.startsWith("revenue_delta_musd:"));
  const base = get(hz, metric);
  const rows = run.sensitivity.map(s => ({ name: human(s.param), basis: s.basis, low: s.effects[`${hz}|${metric}`]?.[0] ?? 0, high: s.effects[`${hz}|${metric}`]?.[1] ?? 0 }));
  const c = run.confidence;
  async function doReplay() { setRerr(null); try { setReplay(await api<ReplayResult>(`/v1/scenarios/runs/${run.id}/replay`, { method: "POST" })); } catch (e) { setRerr(e instanceof ApiError ? e.message : "Replay failed."); } }
  return (
    <div className="grid">
      <div className="grid g3">
        <div className="card stat"><span className="l">Template</span><span className="v" style={{ fontSize: "1.3rem" }}>{run.template}</span><span className="s">v{run.templateVersion} · {run.formulaVersion}</span></div>
        <div className="card stat"><span className="l">Confidence</span><span><Status value={c.level} /></span><span className="s">Score {num(c.score, 2)} of 1</span></div>
        <div className="card stat"><span className="l">Baseline</span><span className="v" style={{ fontSize: "1.3rem" }}>{month(`${run.inputs.baseline.month}-01T00:00:00Z`)}</span><span className="s">{run.inputs.baseline.priceUsd !== null ? `Brent US$ ${num(run.inputs.baseline.priceUsd, 1)} · ` : ""}{run.inputs.baseline.reserves ? `reserves as of ${run.inputs.baseline.reserves.quarter} · ` : ""}run {dateTime(run.createdAt)}</span></div>
      </div>

      <Card title="Why this confidence">
        {c.notes.length ? <ul style={{ margin: "0 0 12px", paddingInlineStart: 20 }}>{c.notes.map(n => <li key={n}>{n}</li>)}</ul> : <p>No caveats recorded.</p>}
        <Table label="Confidence components"><thead><tr><th>Component</th><th className="num">Value</th><th>Meaning</th></tr></thead><tbody>
          <tr><td>Assumed share</td><td className="num">{pct(c.basis.assumedShare)}</td><td className="small muted">Share of parameters that are planning assumptions. Lower is better.</td></tr>
          <tr><td>Source validation</td><td className="num">{pct(c.basis.sourceValidation)}</td><td className="small muted">Accepted inputs score 1, warned 0.5.</td></tr>
          <tr><td>Recency</td><td className="num">{pct(c.basis.recency)}</td><td className="small muted">Age of the baseline month.</td></tr>
          <tr><td>Sensitivity</td><td className="num">{pct(c.basis.sensitivity)}</td><td className="small muted">How narrow the range is against the estimate.</td></tr></tbody></Table>
      </Card>

      <Card title="Headline results" aside={<span className="small muted">Value, with range from one-at-a-time sensitivity</span>}>
        <Table label="Headline results"><thead><tr><th>Measure</th>{HORIZONS.map(h => <th key={h} className="num">{h}</th>)}</tr></thead>
          <tbody>{headline.map(m => <tr key={m}><td>{metricLabel(m)}</td>{HORIZONS.map(h => { const x = get(h, m); return <td key={h} className="num">{x ? <><strong>{fmtValue(x.unit, x.value, m)}</strong><div className="small muted">{fmtValue(x.unit, x.lineage.band.low, m)} to {fmtValue(x.unit, x.lineage.band.high, m)}</div></> : "—"}</td>; })}</tr>)}</tbody></Table>
      </Card>

      <div className="grid">
        {countries.length ? <Card title="By country: export revenue change">
          <Table label="Revenue change by country"><thead><tr><th>Country</th>{HORIZONS.map(h => <th key={h} className="num">{h}</th>)}</tr></thead>
            <tbody>{countries.map(m => <tr key={m}><td>{m.split(":")[1]}</td>{HORIZONS.map(h => { const x = get(h, m); return <td key={h} className="num">{x ? musd(x.value) : "—"}</td>; })}</tr>)}</tbody></Table>
        </Card> : null}
        <Card title="Sensitivity" aside={<div className="row"><label>Measure<select value={metric} onChange={e => setMetric(e.target.value)}>{metrics.map(m => <option key={m} value={m}>{metricLabel(m)}</option>)}</select></label><label>Horizon<select value={hz} onChange={e => setHz(e.target.value)}>{HORIZONS.map(h => <option key={h}>{h}</option>)}</select></label></div>}>
          {base ? <>
            <Tornado rows={rows} base={base.value} unit={base.unit} fmt={v => fmtValue(base.unit, v, metric)} />
            <Table label="Sensitivity values"><thead><tr><th>Parameter</th><th>Basis</th><th className="num">At low end</th><th className="num">At high end</th></tr></thead>
              <tbody>{rows.map(r => <tr key={r.name}><td>{r.name}</td><td><LinkClass value={r.basis} /></td><td className="num">{fmtValue(base.unit, r.low, metric)}</td><td className="num">{fmtValue(base.unit, r.high, metric)}</td></tr>)}</tbody></Table>
          </> : null}
        </Card>
      </div>

      <Card title="Assumptions and inputs">
        <Table label="Parameters used"><thead><tr><th>Parameter</th><th className="num">Value</th><th className="num">Range</th><th>Basis</th><th>Note</th></tr></thead>
          <tbody>{Object.entries(run.assumptions).sort(([a], [b]) => a.localeCompare(b)).map(([k, p]) => <tr key={k}><td>{human(k)}</td><td className="num">{num(p.value, 3)}</td><td className="num">{p.low === p.high ? "fixed" : `${num(p.low, 2)} – ${num(p.high, 2)}`}</td><td><LinkClass value={p.basis} /></td><td className="small muted">{p.note}</td></tr>)}</tbody></Table>
        <h3 style={{ margin: "16px 0 8px" }}>Baseline from stored evidence</h3>
        {run.inputs.baseline.reserves ? <Table label="Reserve assets"><thead><tr><th>Class (published {run.inputs.baseline.reserves.quarter})</th><th className="num">Million SAR</th><th className="num">Share</th></tr></thead><tbody>
          {([["Foreign currency and deposits abroad", run.inputs.baseline.reserves.liquidMillionSar], ["Foreign securities", run.inputs.baseline.reserves.securitiesMillionSar], ["Monetary gold", run.inputs.baseline.reserves.goldMillionSar], ["IMF reserve position and SDR", run.inputs.baseline.reserves.otherMillionSar], ["Total", run.inputs.baseline.reserves.totalMillionSar]] as [string, number][]).map(([n, v]) => <tr key={n}><td>{n}</td><td className="num">{num(v, 0)}</td><td className="num">{pct(v / run.inputs.baseline.reserves!.totalMillionSar, 1)}</td></tr>)}</tbody></Table> : null}
        {run.inputs.baseline.gdp ? <Table label="GDP"><thead><tr><th>Nominal GDP, four quarters to {run.inputs.baseline.gdp.quarter}</th><th className="num">Million SAR</th></tr></thead><tbody>
          {([["Oil activities", run.inputs.baseline.gdp.annualOilMillion], ["Non-oil activities", run.inputs.baseline.gdp.annualNonOilMillion], ["Government activities", run.inputs.baseline.gdp.annualGovernmentMillion]] as [string, number][]).map(([n, v]) => <tr key={n}><td>{n}</td><td className="num">{num(v, 0)}</td></tr>)}</tbody></Table> : null}
        {run.inputs.baseline.countries.length ? <Table label="Baseline inputs"><thead><tr><th>Country</th><th className="num">Exports (kb/d)</th><th className="num">Hormuz share</th><th className="num">Spare bypass (kb/d)</th><th>Exposure basis</th><th>Evidence</th></tr></thead>
          <tbody>{run.inputs.baseline.countries.map(x => <tr key={x.code}><td>{x.name}</td><td className="num">{num(x.exportsKbd, 0)}</td><td className="num">{pct(x.hormuzShare)}</td><td className="num">{num(x.spareBypassKbd, 0)}</td><td><LinkClass value={x.linkClass} /></td><td>{x.refs.map((r, i) => <a key={`${r.evidenceId}-${i}`} className="mono small" href={`#/evidence/${r.evidenceId}`} style={{ marginInlineEnd: 8 }}>{short(r.evidenceId, 8)}</a>)}</td></tr>)}</tbody></Table> : null}
      </Card>

      <Card title="Replay and integrity">
        <dl className="prov"><div><dt>Manifest hash</dt><dd className="mono">{run.manifestHash}</dd></div><div><dt>Results hash</dt><dd className="mono">{run.resultsHash}</dd></div><div><dt>Graph snapshot</dt><dd className="mono">{run.graphSnapshotId ?? "none"}</dd></div></dl>
        <div className="row" style={{ marginTop: 12 }}><button onClick={doReplay}>Replay this run</button>
          {replay ? <span role="status">{replay.manifestMatches && replay.resultsMatch && replay.storedRowsMatch ? <span className="badge b-ok">Exact match: inputs, results and stored rows</span> : <span className="badge b-bad">Mismatch</span>}</span> : null}
          {rerr ? <span className="badge b-bad" role="alert">{rerr}</span> : null}</div>
      </Card>
      <p className="small muted">Scenario simulation. Computed from the assumptions above. Not a forecast, not a live feed, and not a statement about any institution's actual exposure.</p>
    </div>
  );
}
