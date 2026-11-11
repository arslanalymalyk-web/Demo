import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import { GEO, project } from "../geo/projection";
import type { MapData, MapEntity, MapLink, MapProducer, RunDetail, RunSummary } from "../api";
import { Async, Card, LinkClass, PageHead, Table, useApi } from "../components";
import { month, musd, num } from "../format";

const W = GEO.width, H = GEO.height;
const LABELS: [string, number, number][] = [["SAUDI ARABIA", 24.0, 44.5], ["IRAQ", 32.8, 43.5], ["IRAN", 31.0, 54.0], ["OMAN", 20.8, 56.5], ["YEMEN", 15.8, 47.5], ["UAE", 23.7, 54.4], ["KUWAIT", 29.35, 47.5], ["QATAR", 25.2, 51.3], ["EGYPT", 27.0, 32.6], ["SUDAN", 17.0, 33.5], ["ERITREA", 15.6, 39.0], ["JORDAN", 31.0, 36.7], ["SYRIA", 34.0, 38.5]];
const PRODUCER_FACILITY: Record<string, string> = { SA: "facility:ras-tanura", KW: "facility:mina-al-ahmadi", IQ: "facility:basra-oil-terminal", IR: "facility:kharg", QA: "facility:ras-laffan", AE: "facility:jebel-dhanna", BH: "facility:sitra", OM: "facility:mina-al-fahal" };
type Layer = "lanes" | "assets" | "series" | "propagation";
const LAYERS: { key: Layer; label: string; help: string }[] = [
  { key: "lanes", label: "Chokepoints and sea routes", help: "Schematic lanes through the Strait of Hormuz, Bab-el-Mandeb and Suez" },
  { key: "assets", label: "Terminals, ports and pipelines", help: "With capacities where a public source is cited" },
  { key: "series", label: "Stored series on producers", help: "Latest monthly crude exports from the stored JODI series" },
  { key: "propagation", label: "Scenario propagation", help: "A stored scenario run drawn from the Strait to each producer" },
];

const pt = (lat: number, lon: number) => project(lat, lon);
const polyline = (path: [number, number][]) => path.map(([la, lo], i) => { const [x, y] = pt(la, lo); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join("");
const midpoint = (path: [number, number][]) => { const [la, lo] = path[Math.floor(path.length / 2)]!; return pt(la, lo); };

export function MapView({ can }: { can: (p: string) => boolean }): ReactNode {
  const map = useApi<MapData>("/v1/map");
  const runs = useApi<RunSummary[]>(can("scenario.read") ? "/v1/scenarios/runs?limit=20" : null);
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ lanes: true, assets: true, series: true, propagation: false });
  const [mode, setMode] = useState<"map" | "list">("map");
  const [sel, setSel] = useState<string | null>(null);
  const [runId, setRunId] = useState(""), [hz, setHz] = useState("90d");
  const hormuzRuns = (runs.data ?? []).filter(r => r.template_key === "hormuz-transit-restriction");
  const run = useApi<RunDetail>(layers.propagation && runId ? `/v1/scenarios/runs/${runId}` : null);
  return (
    <>
      <PageHead title="Map" aside={<span className="row"><span className="badge b-ok">Public record</span><span className="badge b-warn b-hatch">No live vessel feed</span></span>}>
        Gulf geography from public records, with the stored export series drawn on each producer. Positions are approximate and routes are schematic. No vessel positions are shown, because no live vessel feed is connected.
      </PageHead>
      <Async state={map}>{d => (
        <div className="split map-split">
          <div className="grid">
            <Card title="Layers">
              <fieldset className="layers"><legend className="sr-only">Map layers</legend>
                {LAYERS.map(l => <label key={l.key} className="check"><input type="checkbox" checked={layers[l.key]} onChange={e => setLayers({ ...layers, [l.key]: e.target.checked })} /><span>{l.label}<span className="small muted" style={{ display: "block" }}>{l.help}</span></span></label>)}
              </fieldset>
              {layers.propagation ? (
                <div className="stack" style={{ marginTop: 12 }}>
                  <label>Scenario run<select value={runId} onChange={e => setRunId(e.target.value)}><option value="">Choose a Hormuz run…</option>{hormuzRuns.map(r => <option key={r.id} value={r.id}>{r.id.slice(0, 8)} · {r.confidence} confidence</option>)}</select></label>
                  <label>Horizon<select value={hz} onChange={e => setHz(e.target.value)}>{["72h", "90d", "1y", "5y"].map(h => <option key={h}>{h}</option>)}</select></label>
                  {hormuzRuns.length === 0 ? <span className="small muted">No Hormuz scenario has been run yet. <a href="#/scenarios">Run one in Scenarios.</a></span> : null}
                </div>
              ) : null}
            </Card>
            <Legend />
            <Detail d={d} sel={sel} onClose={() => setSel(null)} />
          </div>
          <div className="grid">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="seg" role="group" aria-label="View"><button aria-pressed={mode === "map"} onClick={() => setMode("map")}>Map</button><button aria-pressed={mode === "list"} onClick={() => setMode("list")}>List</button></div>
              <span className="badge b-gold">{layers.propagation && runId ? "Scenario simulation" : "Public record"}</span>
            </div>
            {mode === "map" ? <Canvas d={d} layers={layers} sel={sel} setSel={setSel} run={layers.propagation ? run.data : null} hz={hz} /> : <FeatureList d={d} onPick={k => { setSel(k); setMode("map"); }} />}
            {layers.propagation && run.error ? <div className="note err" role="alert">{run.error}</div> : null}
            {layers.propagation && run.data ? <PropagationTable d={d} run={run.data} hz={hz} /> : null}
            <p className="small muted">{d.notes.positions} {d.notes.lanes} {d.notes.vessels} Base geography: Natural Earth (public domain). Pipeline capacities and the Hormuz flow figure: U.S. Energy Information Administration, 21 November 2023, opened from each feature's evidence link.</p>
          </div>
        </div>
      )}</Async>
    </>
  );
}

function Legend(): ReactNode {
  return (
    <Card title="Key">
      <ul className="plain small">
        <li><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="34" y2="5" className="m-lane" /></svg> Sea route (schematic)</li>
        <li><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="34" y2="5" className="m-pipe sourced" /></svg> Pipeline, capacity from a cited source</li>
        <li><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="34" y2="5" className="m-pipe assumed" /></svg> Pipeline, not tied to a source</li>
        <li><svg width="14" height="14" aria-hidden="true"><path d="M7 1 13 7 7 13 1 7Z" className="m-choke" /></svg> Chokepoint</li>
        <li><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" className="m-fac" /></svg> Terminal or port (approximate position)</li>
        <li><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" className="m-bubble" /></svg> Producer's latest monthly exports</li>
      </ul>
    </Card>
  );
}

function Detail({ d, sel, onClose }: { d: MapData; sel: string | null; onClose: () => void }): ReactNode {
  const e = d.entities.find(x => x.key === sel);
  if (!e) return <Card title="Details"><p className="small muted" style={{ margin: 0 }}>Choose a marker or a route on the map, or a row in the list, to see how we know what we show.</p></Card>;
  const links = d.links.filter(l => l.from === e.key || l.to === e.key), name = (k: string) => d.entities.find(x => x.key === k)?.name ?? k.split(":").pop()!;
  const prod = d.producers.find(p => PRODUCER_FACILITY[p.code] === e.key);
  return (
    <Card title={e.name} aside={<button onClick={onClose} aria-label="Close details">Close</button>}>
      <p className="small muted" style={{ margin: "0 0 8px" }}>{e.kind === "chokepoint" ? "Chokepoint" : e.kind === "route" ? (e.attrs.routeKind === "pipeline" ? "Pipeline" : "Sea route") : e.attrs.role}{e.attrs.country ? ` · ${e.attrs.country}` : ""}</p>
      {e.attrs.note ? <p className="small">{e.attrs.note}</p> : null}
      {typeof e.attrs.capacityKbd === "number" ? <p className="small"><strong>Capacity {num(e.attrs.capacityKbd / 1000, 1)} million b/d</strong>{e.attrs.temporaryMaxKbd ? `. ${e.attrs.temporaryNote}.` : ""}{e.attrs.note ? "" : ""}</p> : null}
      {e.attrs.flow ? <p className="small"><strong>About {num(e.attrs.flow.kbd / 1000, 0)} million b/d of oil in {e.attrs.flow.year}</strong>, about {num(e.attrs.flow.shareOfGlobalLiquidsConsumption * 100, 0)}% of global petroleum liquids consumption. <a href={`#/evidence/${e.attrs.flow.evidenceId}`}>{e.attrs.flow.source}</a></p> : null}
      {prod ? <p className="small"><strong>{prod.name}: {num(prod.exportsKbd, 0)} kb/d</strong> crude exports in {month(prod.period)}{prod.lagging ? <> (<span className="muted">no data since {month(prod.period)}</span>)</> : prod.changePct !== null ? `, ${prod.changePct < 0 ? "−" : "+"}${num(Math.abs(prod.changePct) * 100, 1)}% against the 12-month median` : ""}. <a href={`#/evidence/${prod.evidenceId}`}>Source record</a></p> : null}
      <p className="small muted">{e.attrs.positionBasis ?? e.attrs.pathBasis}</p>
      {links.length ? <Table label="Links"><thead><tr><th>Link</th><th>Basis</th></tr></thead><tbody>{groupLinks(links, e.key, name).map(g => <tr key={g.key}><td className="small">{g.text}<div className="small muted">{g.names.join(", ")}</div></td>
        <td><LinkClass value={g.linkClass} />{g.rationale ? <div className="small muted">{g.rationale}</div> : null}{g.evidence.map(ev => <a key={ev} href={`#/evidence/${ev}`} className="small mono" style={{ marginInlineEnd: 8 }}>evidence {ev.slice(0, 8)}</a>)}</td></tr>)}</tbody></Table> : null}
    </Card>
  );
}
/** Links that share a predicate, class and rationale are shown once, with the names they apply to. */
function groupLinks(links: MapLink[], self: string, name: (k: string) => string): { key: string; text: string; names: string[]; linkClass: string; rationale: string | null; evidence: string[] }[] {
  const m = new Map<string, { key: string; text: string; names: string[]; linkClass: string; rationale: string | null; evidence: string[] }>();
  for (const l of links) {
    const out = l.from === self, other = name(out ? l.to : l.from), verb = l.predicate.replace(/_/g, " ");
    const key = `${out}|${l.predicate}|${l.linkClass}|${l.rationale}|${[...l.evidence].sort().join(",")}`;
    const g = m.get(key) ?? { key, text: out ? `${verb} …` : `… ${verb} this`, names: [], linkClass: l.linkClass, rationale: l.rationale, evidence: l.evidence };
    g.names.push(other); m.set(key, g);
  }
  return [...m.values()];
}

function FeatureList({ d, onPick }: { d: MapData; onPick: (k: string) => void }): ReactNode {
  return (
    <Card title="Features">
      <Table label="Map features"><thead><tr><th>Feature</th><th>Kind</th><th>Position or path</th><th className="num">Capacity (kb/d)</th><th>Links</th></tr></thead>
        <tbody>{d.entities.map(e => <tr key={e.key}><td><button className="link" onClick={() => onPick(e.key)}>{e.name}</button></td><td>{e.kind === "route" ? (e.attrs.routeKind === "pipeline" ? "Pipeline" : "Sea route") : e.kind === "chokepoint" ? "Chokepoint" : "Terminal or port"}</td>
          <td className="small mono">{typeof e.attrs.lat === "number" ? `${e.attrs.lat.toFixed(2)}°N ${e.attrs.lon.toFixed(2)}°E (approx.)` : Array.isArray(e.attrs.path) ? "Schematic path" : "No drawn path"}</td><td className="num">{typeof e.attrs.capacityKbd === "number" ? num(e.attrs.capacityKbd, 0) : "—"}</td>
          <td className="small">{[...new Set(d.links.filter(l => l.from === e.key || l.to === e.key).map(l => l.linkClass))].map(c => <LinkClass key={c} value={c} />)}</td></tr>)}</tbody></Table>
    </Card>
  );
}

function PropagationTable({ d, run, hz }: { d: MapData; run: RunDetail; hz: string }): ReactNode {
  const rows = run.results.filter(r => r.horizon === hz && r.metric.startsWith("revenue_delta_musd:")).map(r => ({ code: r.metric.split(":")[1]!, value: r.value }));
  const lost = run.results.find(r => r.horizon === hz && r.metric === "lost_supply_kbd");
  return (
    <Card title={`Scenario ${run.id.slice(0, 8)} at ${hz}`} aside={<span className="badge b-gold">Scenario simulation</span>}>
      <p className="small">Supply lost while the event lasts: <strong>{lost ? `${num(lost.value, 0)} kb/d` : "—"}</strong>. Confidence: {run.confidence.level}. The values below are the run's stored export revenue change by country. <a href={`#/scenarios/runs/${run.id}`}>Open the run</a>.</p>
      <Table label="Propagation values"><thead><tr><th>Producer</th><th className="num">Export revenue change</th></tr></thead><tbody>{rows.map(r => <tr key={r.code}><td>{d.producers.find(p => p.code === r.code)?.name ?? r.code}</td><td className="num">{musd(r.value)}</td></tr>)}</tbody></Table>
    </Card>
  );
}

function Canvas({ d, layers, sel, setSel, run, hz }: { d: MapData; layers: Record<Layer, boolean>; sel: string | null; setSel: (k: string | null) => void; run: RunDetail | null; hz: string }): ReactNode {
  const [view, setView] = useState({ z: 1.7, cx: pt(26.5, 52.5)[0], cy: pt(26.5, 52.5)[1] });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null>(null), svg = useRef<SVGSVGElement>(null);
  const vw = W / view.z, vh = H / view.z;
  const clamp = (z: number, cx: number, cy: number) => ({ z, cx: Math.min(W - W / z / 2, Math.max(W / z / 2, cx)), cy: Math.min(H - H / z / 2, Math.max(H / z / 2, cy)) });
  const zoom = (f: number) => setView(v => clamp(Math.min(8, Math.max(1, v.z * f)), v.cx, v.cy));
  // The pointer is captured only once it has moved, so a plain click still reaches the marker under it.
  const onDown = (e: PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false, id: e.pointerId }; };
  const onMove = (e: PointerEvent) => {
    const d0 = drag.current; if (!d0 || !svg.current) return;
    if (!d0.moved) { if (Math.hypot(e.clientX - d0.x, e.clientY - d0.y) < 5) return; d0.moved = true; svg.current.setPointerCapture(d0.id); }
    const r = svg.current.getBoundingClientRect(), s = vw / r.width; setView(v => clamp(v.z, d0.cx - (e.clientX - d0.x) * s, d0.cy - (e.clientY - d0.y) * s));
  };
  const onKey = (e: KeyboardEvent) => { const step = vw * 0.12; if (e.key === "+" || e.key === "=") zoom(1.4); else if (e.key === "-") zoom(1 / 1.4); else if (e.key === "ArrowLeft") setView(v => clamp(v.z, v.cx - step, v.cy)); else if (e.key === "ArrowRight") setView(v => clamp(v.z, v.cx + step, v.cy)); else if (e.key === "ArrowUp") setView(v => clamp(v.z, v.cx, v.cy - step)); else if (e.key === "ArrowDown") setView(v => clamp(v.z, v.cx, v.cy + step)); else if (e.key === "0") setView({ z: 1, cx: W / 2, cy: H / 2 }); else return; e.preventDefault(); };
  const onWheel = (e: WheelEvent) => { zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); };
  const ents = useMemo(() => new Map(d.entities.map(e => [e.key, e])), [d]);
  const scale = 1 / view.z; // keep markers and text a constant size on screen as the map zooms
  const delta = new Map<string, number>(run ? run.results.filter(r => r.horizon === hz && r.metric.startsWith("revenue_delta_musd:")).map(r => [r.metric.split(":")[1]!, r.value]) : []);
  const hormuz = ents.get("chokepoint:hormuz");
  const pipeLink = (key: string): MapLink | undefined => d.links.find(l => l.from === key && l.predicate === "bypasses");
  const bubble = (p: MapProducer) => 5 + Math.sqrt(p.exportsKbd) * 0.42;

  return (
    <div className="mapbox">
      <div className="mapctl" role="group" aria-label="Zoom"><button onClick={() => zoom(1.4)} aria-label="Zoom in">+</button><button onClick={() => zoom(1 / 1.4)} aria-label="Zoom out">−</button><button onClick={() => setView({ z: 1, cx: W / 2, cy: H / 2 })} aria-label="Show the whole region">Reset</button></div>
      <svg ref={svg} className="map" viewBox={`${view.cx - vw / 2} ${view.cy - vh / 2} ${vw} ${vh}`} role="application" tabIndex={0} aria-label="Gulf oil map. Arrow keys move, plus and minus zoom, zero resets. The same features are in the list view."
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onKeyDown={onKey} onWheel={onWheel}>
        <rect x="-2000" y="-2000" width="6000" height="6000" className="m-water" onClick={() => setSel(null)} />
        {GEO.countries.map(c => <path key={c.name} d={c.d} className="m-land" />)}
        {LABELS.map(([n, la, lo]) => { const [x, y] = pt(la, lo); return <text key={n} x={x} y={y} className="m-country" textAnchor="middle" style={{ fontSize: 11 * scale }}>{n}</text>; })}

        {layers.lanes ? d.entities.filter(e => e.kind === "route" && e.attrs.routeKind === "sea-lane").map(e => (
          <g key={e.key}><path d={polyline(e.attrs.path)} className="m-lane" style={{ strokeWidth: 2.2 * scale }} /><path d={polyline(e.attrs.path)} className="m-hit" onClick={() => setSel(e.key)} tabIndex={0} role="button" aria-label={e.name} onKeyDown={k => { if (k.key === "Enter") setSel(e.key); }} /></g>)) : null}

        {layers.assets ? d.entities.filter(e => e.kind === "route" && e.attrs.routeKind === "pipeline" && Array.isArray(e.attrs.path)).map(e => {
          const l = pipeLink(e.key), [mx, my] = midpoint(e.attrs.path);
          return <g key={e.key}><path d={polyline(e.attrs.path)} className={`m-pipe ${l?.linkClass === "sourced" ? "sourced" : "assumed"}`} style={{ strokeWidth: 3 * scale }} /><path d={polyline(e.attrs.path)} className="m-hit" onClick={() => setSel(e.key)} tabIndex={0} role="button" aria-label={e.name} onKeyDown={k => { if (k.key === "Enter") setSel(e.key); }} />
            <text x={mx} y={my - 6 * scale} className="m-label" textAnchor="middle" style={{ fontSize: 10 * scale }}>{num((e.attrs.capacityKbd as number) / 1000, 1)} mb/d</text></g>; }) : null}

        {layers.propagation && run && hormuz ? [...delta].map(([code, v]) => {
          const f = ents.get(PRODUCER_FACILITY[code] ?? ""); if (!f) return null;
          const [x1, y1] = pt(hormuz.attrs.lat, hormuz.attrs.lon), [x2, y2] = pt(f.attrs.lat, f.attrs.lon), cx = (x1 + x2) / 2 + (y2 - y1) * 0.18, cy = (y1 + y2) / 2 - (x2 - x1) * 0.18;
          return <g key={code}><path d={`M${x1},${y1}Q${cx},${cy} ${x2},${y2}`} className={`edge flow m-prop ${v < 0 ? "loss" : "gain"}`} style={{ strokeWidth: 2.6 * scale }} />
            <text x={cx} y={cy - 4 * scale} className="m-label" textAnchor="middle" style={{ fontSize: 10 * scale }}>{musd(v)}</text></g>; }) : null}

        {layers.assets ? d.entities.filter(e => e.kind === "facility").map(e => { const [x, y] = pt(e.attrs.lat, e.attrs.lon); return (
          <g key={e.key} onClick={() => setSel(e.key)} tabIndex={0} role="button" aria-label={`${e.name}, approximate position`} onKeyDown={k => { if (k.key === "Enter") setSel(e.key); }} className={sel === e.key ? "m-sel" : ""} style={{ cursor: "pointer" }}>
            <circle cx={x} cy={y} r={4.5 * scale} className="m-fac" /><text x={x + 7 * scale} y={y + 3.5 * scale} className="m-label" style={{ fontSize: 10 * scale }}>{e.name.replace(/ terminal$/, "")}</text></g>); }) : null}

        {layers.series ? d.producers.map(p => { const f = ents.get(PRODUCER_FACILITY[p.code] ?? ""); if (!f) return null; const [x, y] = pt(f.attrs.lat, f.attrs.lon), r = (p.lagging ? 7 : bubble(p)) * scale; return (
          <g key={p.code} onClick={() => setSel(f.key)} style={{ cursor: "pointer" }}>
            <circle cx={x} cy={y} r={r} className={`m-bubble${p.lagging ? " lag" : ""}`}><title>{`${p.name}: ${num(p.exportsKbd, 0)} kb/d in ${month(p.period)}${p.lagging ? " (no recent data)" : ""}`}</title></circle>
            <text x={x} y={y - r - 3 * scale} className="m-value" textAnchor="middle" style={{ fontSize: 10.5 * scale }}>{p.code} {p.lagging ? "no data" : `${num(p.exportsKbd, 0)}${p.changePct !== null ? ` ${p.changePct < 0 ? "▼" : "▲"}${num(Math.abs(p.changePct) * 100, 0)}%` : ""}`}</text></g>); }) : null}

        {layers.lanes ? d.entities.filter(e => e.kind === "chokepoint").map(e => { const [x, y] = pt(e.attrs.lat, e.attrs.lon), s = 7 * scale; return (
          <g key={e.key} onClick={() => setSel(e.key)} tabIndex={0} role="button" aria-label={e.name} onKeyDown={k => { if (k.key === "Enter") setSel(e.key); }} className={sel === e.key ? "m-sel" : ""} style={{ cursor: "pointer" }}>
            <path d={`M${x},${y - s}L${x + s},${y}L${x},${y + s}L${x - s},${y}Z`} className="m-choke" /><text x={x + 10 * scale} y={y - 6 * scale} className="m-label strong" style={{ fontSize: 11 * scale }}>{e.name}</text></g>); }) : null}
      </svg>
    </div>
  );
}
