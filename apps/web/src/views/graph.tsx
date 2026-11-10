import { useEffect, useState, type ReactNode } from "react";
import { Async, Card, LinkClass, PageHead, Table, useApi } from "../components";
import { titleCase } from "../format";
import type { Entity, GraphPath, PathEdge } from "../api";

const R = 150, CX = 260, CY = 190;

function Radial({ center, edges, onPick }: { center: string; edges: PathEdge[]; onPick: (key: string) => void }): ReactNode {
  const out = [...new Map(edges.filter(e => e.from === center).map(e => [e.id, e])).values()];
  const nodes = [...new Map(out.map(e => [e.to, e])).keys()];
  const pos = (i: number) => { const a = (2 * Math.PI * i) / Math.max(nodes.length, 1) - Math.PI / 2; return [CX + R * Math.cos(a) * 1.35, CY + R * Math.sin(a)] as const; };
  const idx = new Map(nodes.map((k, i) => [k, i]));
  return (
    <svg viewBox="0 0 520 380" role="img" aria-label={`${center} has ${nodes.length} direct links. The same links are listed in the table below.`} style={{ width: "100%", height: "auto" }}>
      {out.map(e => { const [x, y] = pos(idx.get(e.to)!); return (
        <g key={e.id}><line className={`edge ${e.linkClass} flow`} x1={CX} y1={CY} x2={x} y2={y}><title>{`${e.from} ${e.predicate} ${e.to} (${e.linkClass})`}</title></line></g>); })}
      <g className="node center"><circle cx={CX} cy={CY} r="34" /><text x={CX} y={CY + 4} textAnchor="middle">{center.split(":").pop()}</text></g>
      {nodes.map(k => { const [x, y] = pos(idx.get(k)!); return (
        <g key={k} className="node" tabIndex={0} role="button" aria-label={`Open ${k}`} style={{ cursor: "pointer" }} onClick={() => onPick(k)} onKeyDown={ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onPick(k); } }}>
          <circle cx={x} cy={y} r="22" /><text x={x} y={y + 4} textAnchor="middle">{k.split(":").pop()}</text></g>); })}
    </svg>
  );
}

export function GraphView(): ReactNode {
  const ents = useApi<Entity[]>("/v1/graph/entities");
  const [key, setKey] = useState<string>(""), [depth, setDepth] = useState(2);
  useEffect(() => { if (!key && ents.data?.length) setKey(ents.data.find(e => e.kind === "chokepoint")?.key ?? ents.data[0]!.key); }, [ents.data, key]);
  const paths = useApi<GraphPath[]>(key ? `/v1/graph/entities/${encodeURIComponent(key)}/paths?depth=${depth}` : null);
  const byKind = new Map<string, Entity[]>();
  for (const e of ents.data ?? []) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
  const entity = ents.data?.find(e => e.key === key);

  return (
    <>
      <PageHead title="Sovereign Intelligence Graph">Entities and the typed links between them. Each link says how we know it: observed in evidence, sourced, inferred by a rule, or assumed. Assumed links are drawn dashed.</PageHead>
      <Async state={ents} empty={d => d.length === 0}>{() => (
        <div className="split">
          <Card title="Entities">
            <ul className="list-pick">{[...byKind].map(([kind, list]) => <li key={kind}><div className="small muted" style={{ margin: "10px 0 4px" }}>{titleCase(kind)}</div>
              <ul className="list-pick">{list.map(e => <li key={e.key}><button aria-current={e.key === key} onClick={() => setKey(e.key)}>{e.name}</button></li>)}</ul></li>)}</ul>
          </Card>
          <div className="grid">
            <Card title={entity?.name ?? key} aside={<label>Depth<select value={depth} onChange={e => setDepth(Number(e.target.value))}>{[1, 2, 3].map(d => <option key={d}>{d}</option>)}</select></label>}>
              <Async state={paths} empty={d => d.length === 0}>{p => <>
                <Radial center={key} edges={p.flatMap(x => x.edges)} onPick={setKey} />
                <div className="row small" style={{ marginTop: 8 }}>{["observed", "sourced", "inferred", "assumed"].map(c => <LinkClass key={c} value={c} />)}</div>
              </>}</Async>
            </Card>
            <Card title="Paths">
              <Async state={paths} empty={d => d.length === 0}>{p => (
                <Table label="Graph paths"><thead><tr><th className="num">Depth</th><th>Path</th><th>Basis</th></tr></thead>
                  <tbody>{p.map((x, i) => <tr key={i}><td className="num">{x.depth}</td>
                    <td>{x.edges.map((e, j) => <span key={e.id}>{j === 0 ? <strong>{e.from}</strong> : null} <span className="muted">—{e.predicate}→</span> <strong>{e.to}</strong></span>)}</td>
                    <td>{x.edges.map(e => <div key={e.id} style={{ marginBottom: 4 }}><LinkClass value={e.linkClass} />{e.rationale ? <div className="small muted" style={{ maxWidth: "52ch" }}>{e.rationale}</div> : null}{e.evidence.map((ev, i) => <a key={`${ev}-${i}`} className="small mono" href={`#/evidence/${ev}`} style={{ marginInlineEnd: 8 }}>evidence {ev.slice(0, 8)}</a>)}</div>)}</td></tr>)}</tbody></Table>
              )}</Async>
            </Card>
          </div>
        </div>
      )}</Async>
    </>
  );
}
