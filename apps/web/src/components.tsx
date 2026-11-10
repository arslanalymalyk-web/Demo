import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Lineage } from "./api";
import { date, dateTime, num, titleCase } from "./format";

export function useApi<T>(path: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [s, set] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: path !== null });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (path === null) { set({ data: null, error: null, loading: false }); return; }
    let live = true;
    set(p => ({ ...p, loading: true, error: null }));
    api<T>(path).then(d => live && set({ data: d, error: null, loading: false }), e => live && set({ data: null, error: e instanceof ApiError ? e.message : "Something went wrong.", loading: false }));
    return () => { live = false; };
  }, [path, n]);
  return { ...s, reload: useCallback(() => setN(x => x + 1), []) };
}

export function Async<T>({ state, children, empty }: { state: { data: T | null; error: string | null; loading: boolean }; children: (d: T) => ReactNode; empty?: (d: T) => boolean }): ReactNode {
  if (state.loading && !state.data) return <div role="status" aria-live="polite"><div className="skeleton" style={{ width: "40%", marginBottom: 8 }} /><div className="skeleton" style={{ width: "80%", marginBottom: 8 }} /><div className="skeleton" style={{ width: "60%" }} /><span className="sr-only">Loading</span></div>;
  if (state.error) return <div className="note err" role="alert">{state.error}</div>;
  if (!state.data) return null;
  if (empty?.(state.data)) return <div className="empty">Nothing to show yet.</div>;
  return <>{children(state.data)}</>;
}

const STATUS: Record<string, [string, string]> = {
  accepted: ["b-ok", "Accepted"], warned: ["b-warn", "Warned"], quarantined: ["b-bad", "Quarantined"], rejected: ["b-bad", "Rejected"],
  approved: ["b-ok", "Approved"], pending_rights: ["b-warn", "Pending rights"], blocked: ["b-bad", "Blocked"],
  low: ["b-bad", "Low confidence"], medium: ["b-warn", "Medium confidence"], high: ["b-ok", "High confidence"],
  current: ["b-ok", "Current"], stale: ["b-warn", "Stale"],
};
export function Status({ value }: { value: string | null | undefined }): ReactNode {
  if (!value) return <span className="muted">—</span>;
  const [cls, label] = STATUS[value] ?? ["b-plain", titleCase(value)];
  return <span className={`badge ${cls}`}><span className="dot" aria-hidden="true" />{label}</span>;
}

const LINK: Record<string, string> = { observed: "b-ok", sourced: "b-ok", inferred: "b-info b-dashed", assumed: "b-warn b-dashed", sample: "b-warn b-hatch b-dashed", calibrated: "b-gold" };
const LINK_HELP: Record<string, string> = { observed: "Observed in stored evidence", sourced: "Taken from a cited source", inferred: "Derived by a stated rule", assumed: "A planning assumption, not sourced", sample: "Sample dataset content", calibrated: "Fitted to one observed episode" };
export function LinkClass({ value }: { value: string }): ReactNode {
  return <span className={`badge ${LINK[value] ?? "b-plain"}`} title={LINK_HELP[value]}>{titleCase(value)}</span>;
}

/** Honest data labelling: public records, sample datasets, snapshots and scenario simulations are always named as such. */
export function DataClass({ value }: { value: string }): ReactNode {
  const m: Record<string, [string, string]> = { public_record: ["b-ok", "Public record"], sample_dataset: ["b-warn b-hatch", "Sample dataset"], scenario_simulation: ["b-gold", "Scenario simulation"] };
  const [cls, label] = m[value] ?? ["b-plain", titleCase(value)];
  return <span className={`badge ${cls}`}>{label}</span>;
}
export const SimulationBadge = (): ReactNode => <span className="badge b-gold" title="Computed from stated assumptions. Not a forecast and not a live feed.">Scenario simulation</span>;
export const SnapshotBadge = ({ at }: { at: string }): ReactNode => <span className="badge b-plain">Snapshot as of {date(at)}</span>;

export function Card({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }): ReactNode {
  return <section className="card">{title || aside ? <header>{title ? <h2>{title}</h2> : <span />}{aside}</header> : null}{children}</section>;
}
export function Stat({ value, label, sub }: { value: ReactNode; label: string; sub?: ReactNode }): ReactNode {
  return <div className="card stat"><span className="v">{value}</span><span className="l">{label}</span>{sub ? <span className="s">{sub}</span> : null}</div>;
}
export const Table = ({ children, label }: { children: ReactNode; label: string }): ReactNode => <div className="tablewrap" role="region" aria-label={label} tabIndex={0}><table>{children}</table></div>;

/** The six provenance fields every displayed number must be able to show. */
export function Provenance({ lineage }: { lineage: Lineage }): ReactNode {
  const p = lineage.provenance;
  return (
    <dl className="prov" aria-label="Provenance">
      <div><dt>1 · Origin</dt><dd>{p.origin.publisher}</dd><dd className="muted">Agency: {p.origin.originalAgency ?? "not stated"}</dd><dd>{p.origin.sourceUrl ? <a href={p.origin.sourceUrl} target="_blank" rel="noreferrer noopener">Original source</a> : "No URL"}</dd><dd className="mono muted">{p.origin.recordKey}</dd></div>
      <div><dt>2 · Time and scope</dt><dd>Event: {p.timeAndScope.eventTime ? date(p.timeAndScope.eventTime) : "not stated"}</dd><dd>Retrieved: {dateTime(p.timeAndScope.retrievedAt)}</dd></div>
      <div><dt>3 · Rights and version</dt><dd>Licence: {p.rightsAndVersion.licence ?? "not recorded"}</dd><dd>{p.rightsAndVersion.licenceVerified ? <span className="badge b-ok">Licence verified</span> : <span className="badge b-warn">Licence unconfirmed</span>}</dd><dd>Version {p.rightsAndVersion.version}</dd><dd className="mono muted">sha256 {p.rightsAndVersion.rawHash.slice(0, 16)}…</dd></div>
      <div><dt>4 · Transformation</dt><dd>{p.transformation}</dd></div>
      <div><dt>5 · Confidence</dt><dd><Status value={p.confidence.validation} /></dd>{p.confidence.checks.slice(0, 6).map((c, i) => <dd key={i} className="small muted">{c.rule}: {c.outcome}{c.detail ? ` — ${c.detail}` : ""}</dd>)}</div>
      <div><dt>6 · Data class</dt><dd><DataClass value={p.dataClass} /></dd></div>
    </dl>
  );
}
export function LazyProvenance({ evidenceId }: { evidenceId: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const l = useApi<Lineage>(open ? `/v1/evidence/${evidenceId}/lineage` : null);
  return <details onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}><summary>Show provenance</summary>{open ? <Async state={l}>{d => <Provenance lineage={d} />}</Async> : null}</details>;
}

export interface Point { x: number; y: number; label: string }
/** Line chart with exact values available as a table. A chart never stands alone. */
export function LineChart({ points, unit, title }: { points: Point[]; unit: string; title: string }): ReactNode {
  const [table, setTable] = useState(false);
  if (points.length === 0) return <div className="empty">No observations in this range.</div>;
  const W = 640, H = 220, P = { l: 48, r: 12, t: 12, b: 28 };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)], lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo || 1) * 0.12, [y0, y1] = [lo - pad, hi + pad];
  const sx = (x: number) => P.l + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - P.l - P.r), sy = (y: number) => H - P.b - ((y - y0) / (y1 - y0)) * (H - P.t - P.b);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const ticks = [0, 1, 2, 3].map(i => y0 + ((y1 - y0) * i) / 3);
  const last = points[points.length - 1]!, first = points[0]!;
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <span className="small muted">{unit}</span>
        <div className="seg" role="group" aria-label="View"><button aria-pressed={!table} onClick={() => setTable(false)}>Chart</button><button aria-pressed={table} onClick={() => setTable(true)}>Table</button></div>
      </div>
      {table ? (
        <Table label={`${title} values`}><thead><tr><th>Period</th><th className="num">{unit}</th></tr></thead><tbody>{[...points].reverse().map(p => <tr key={p.x}><td>{p.label}</td><td className="num">{num(p.y, 2)}</td></tr>)}</tbody></Table>
      ) : (
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${points.length} points from ${first.label} (${num(first.y, 1)}) to ${last.label} (${num(last.y, 1)}). Range ${num(lo, 1)} to ${num(hi, 1)} ${unit}.`} style={{ width: "100%", height: "auto" }}>
          {ticks.map((t, i) => <g key={i}><line className="grid-line" x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} /><text x={P.l - 6} y={sy(t) + 4} textAnchor="end">{num(t, 0)}</text></g>)}
          <path className="area" d={`${d} L${sx(last.x)},${H - P.b} L${sx(first.x)},${H - P.b} Z`} />
          <path className="series-line" d={d} />
          {points.length <= 48 ? points.map(p => <circle key={p.x} className="pt" cx={sx(p.x)} cy={sy(p.y)} r="3"><title>{`${p.label}: ${num(p.y, 2)} ${unit}`}</title></circle>) : null}
          <text x={P.l} y={H - 8}>{first.label}</text><text x={W - P.r} y={H - 8} textAnchor="end">{last.label}</text>
        </svg>
      )}
    </div>
  );
}

/** Tornado: how far each parameter moves one metric when set to its low and high ends, others fixed. */
export function Tornado({ rows, base, unit, fmt }: { rows: { name: string; low: number; high: number; basis: string }[]; base: number; unit: string; fmt: (v: number) => string }): ReactNode {
  const sorted = [...rows].sort((a, b) => Math.abs(b.high - b.low) - Math.abs(a.high - a.low));
  if (sorted.length === 0) return <div className="empty">No ranged parameters.</div>;
  const W = 720, row = 30, L = 230, R = 20, H = sorted.length * row + 34;
  const vals = sorted.flatMap(r => [r.low, r.high, base]), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const sx = (v: number) => L + ((v - lo) / span) * (W - L - R);
  return (
    <svg className="chart tornado" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Sensitivity. Estimate ${fmt(base)}. ${sorted.map(r => `${r.name}: ${fmt(Math.min(r.low, r.high))} to ${fmt(Math.max(r.low, r.high))}`).join("; ")}.`} style={{ width: "100%", height: "auto" }}>
      <line className="axis" x1={sx(base)} x2={sx(base)} y1={6} y2={H - 24} />
      {sorted.map((r, i) => { const y = 10 + i * row, a = Math.min(r.low, r.high), b = Math.max(r.low, r.high); return (
        <g key={r.name}><text x={L - 8} y={y + 14} textAnchor="end">{r.name}{r.basis === "assumed" ? " (assumed)" : ""}</text>
          <rect className="lo" x={sx(a)} y={y} width={Math.max(1, sx(base) - sx(a))} height={18} rx="3"><title>{`${r.name} low end: ${fmt(a)}`}</title></rect>
          <rect className="hi" x={sx(base)} y={y} width={Math.max(1, sx(b) - sx(base))} height={18} rx="3"><title>{`${r.name} high end: ${fmt(b)}`}</title></rect></g>); })}
      <text x={L} y={H - 6}>{fmt(lo)}</text><text x={W - R} y={H - 6} textAnchor="end">{fmt(hi)}</text><text x={sx(base)} y={H - 6} textAnchor="middle">{unit}</text>
    </svg>
  );
}

export const PageHead = ({ title, children, aside }: { title: string; children?: ReactNode; aside?: ReactNode }): ReactNode => <div className="page-head"><div><h1>{title}</h1>{children ? <p>{children}</p> : null}</div>{aside ? <div className="row">{aside}</div> : null}</div>;

const OUTCOME: Record<string, [string, string]> = { PASS: ["b-ok", "PASS"], HOLD: ["b-warn", "HOLD"], BLOCK: ["b-bad", "BLOCK"] };
export function PolicyBadge({ value }: { value: string }): ReactNode { const [c, l] = OUTCOME[value] ?? ["b-plain", value]; return <span className={`badge ${c}`}><span className="dot" aria-hidden="true" />Policy {l}</span>; }
const CASE_STATE: Record<string, [string, string]> = { open: ["b-info", "Open"], analysis: ["b-info", "Analysis"], in_review: ["b-gold", "In review"], decided: ["b-ok", "Decided"], closed: ["b-plain", "Closed"] };
export function CaseState({ value }: { value: string }): ReactNode { const [c, l] = CASE_STATE[value] ?? ["b-plain", value]; return <span className={`badge ${c}`}>{l}</span>; }
export function RuleList({ results }: { results: { ruleId: string; outcome: string; explanation: string }[] }): ReactNode {
  return <ul className="rules">{results.map(r => <li key={r.ruleId}><span className="mono">{r.ruleId}</span> <PolicyBadge value={r.outcome} /> <span className="small">{r.explanation}</span></li>)}</ul>;
}

/** Runs a mutation, shows its error in words, and refreshes. */
export function useAction(after: () => void): { busy: boolean; error: string | null; run: (f: () => Promise<unknown>) => Promise<boolean>; clear: () => void } {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => { setBusy(true); setError(null); try { await f(); after(); return true; } catch (e) { setError(e instanceof ApiError ? e.message : "The action failed."); return false; } finally { setBusy(false); } };
  return { busy, error, run, clear: () => setError(null) };
}
