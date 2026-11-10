import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Async, Card, DataClass, LineChart, PageHead, Provenance, Status, Table, useApi } from "../components";
import { date, dateTime, month, num } from "../format";
import type { EvidenceRow, Lineage, Observation, SeriesRow, SourceRow } from "../api";

export function Sources(): ReactNode {
  const s = useApi<SourceRow[]>("/v1/sources");
  return (
    <>
      <PageHead title="Data & Sources">The registry of every source: who publishes it, what we may do with it, and how much of it passed validation. A source that is not approved cannot be ingested.</PageHead>
      <Async state={s}>{rows => (
        <Table label="Source registry"><thead><tr><th>Source</th><th>Publisher</th><th>Status</th><th>Licence</th><th>Class</th><th className="num">Accepted</th><th className="num">Warned</th><th className="num">Quarantined</th></tr></thead>
          <tbody>{rows.map(r => <tr key={r.source_key}>
            <td><strong>{r.name}</strong><div className="small muted mono">{r.source_key} · {r.platform_type}</div>{r.rights_note ? <div className="small muted" style={{ maxWidth: "46ch" }}>{r.rights_note}</div> : null}</td>
            <td>{r.publisher}<div className="small muted">{r.original_agency}</div></td>
            <td><Status value={r.status} /></td>
            <td>{r.licence_name ?? "Not recorded"}<div>{r.licence_verified ? <span className="badge b-ok">Verified</span> : <span className="badge b-warn">Unconfirmed</span>}</div></td>
            <td><DataClass value={r.data_class} /></td>
            <td className="num">{num(r.accepted, 0)}</td><td className="num">{num(r.warned, 0)}</td><td className="num">{num(r.quarantined, 0)}</td>
          </tr>)}</tbody></Table>
      )}</Async>
    </>
  );
}

export function Evidence({ id }: { id: string | null }): ReactNode {
  return id ? <EvidenceDetail id={id} /> : <EvidenceList />;
}

function EvidenceList(): ReactNode {
  const [source, setSource] = useState(""), [status, setStatus] = useState("");
  const sources = useApi<SourceRow[]>("/v1/sources");
  const q = new URLSearchParams({ limit: "100", ...(source ? { source } : {}), ...(status ? { status } : {}) });
  const ev = useApi<EvidenceRow[]>(`/v1/evidence?${q}`);
  return (
    <>
      <PageHead title="Evidence">Every record is stored unchanged with a hash and a version. Open one to see its six provenance fields and the checks it passed.</PageHead>
      <div className="row" style={{ marginBottom: 14 }}>
        <label>Source<select value={source} onChange={e => setSource(e.target.value)}><option value="">All sources</option>{sources.data?.map(s => <option key={s.source_key} value={s.source_key}>{s.name}</option>)}</select></label>
        <label>Validation<select value={status} onChange={e => setStatus(e.target.value)}><option value="">Any</option>{["accepted", "warned", "quarantined", "rejected"].map(x => <option key={x}>{x}</option>)}</select></label>
      </div>
      <Async state={ev} empty={d => d.length === 0}>{rows => (
        <Table label="Evidence records"><thead><tr><th>Record</th><th>Source</th><th>Event</th><th>Retrieved</th><th className="num">Ver.</th><th>Validation</th></tr></thead>
          <tbody>{rows.map(r => <tr key={r.id}><td><a href={`#/evidence/${r.id}`} className={r.title ? "" : "mono"}>{r.title ?? (r.external_key.length > 52 ? `${r.external_key.slice(0, 52)}…` : r.external_key)}</a></td><td>{r.source_key}</td><td>{date(r.event_time)}</td><td>{dateTime(r.retrieved_at)}</td><td className="num">{r.version}</td><td><Status value={r.validation_status} /></td></tr>)}</tbody></Table>
      )}</Async>
      <p className="small muted" style={{ marginTop: 10 }}>Showing the 100 most recent records.</p>
    </>
  );
}

function EvidenceDetail({ id }: { id: string }): ReactNode {
  const l = useApi<Lineage>(`/v1/evidence/${id}/lineage`);
  return (
    <>
      <PageHead title="Evidence record" aside={<a className="btn" href="#/evidence">All evidence</a>}>Provenance, validation and stored content for one record.</PageHead>
      <Async state={l}>{d => (
        <div className="grid">
          <Card title="Provenance"><Provenance lineage={d} /></Card>
          <Card title="Facts extracted" aside={<span className="small muted">{d.facts.length} facts</span>}>
            <Table label="Facts"><thead><tr><th>Subject</th><th>Predicate</th><th className="num">Value</th><th>Unit</th><th>Period</th></tr></thead>
              <tbody>{(d.facts as { subject: string; predicate: string; value: unknown; unit: string | null; valid_time: string | null }[]).slice(0, 25).map((f, i) => <tr key={i}><td className="mono">{f.subject}</td><td>{f.predicate}</td><td className="num">{typeof f.value === "number" ? num(f.value, 2) : String(f.value)}</td><td>{f.unit ?? "—"}</td><td>{f.valid_time ? date(f.valid_time) : "—"}</td></tr>)}</tbody></Table>
            {d.facts.length > 25 ? <p className="small muted" style={{ marginTop: 8 }}>First 25 of {d.facts.length} shown.</p> : null}
          </Card>
          <Card title="Stored content"><details><summary>Show stored record</summary><pre>{JSON.stringify(d.payload, null, 2).slice(0, 20000)}</pre></details></Card>
        </div>
      )}</Async>
    </>
  );
}

export function SeriesView({ seriesKey }: { seriesKey: string | null }): ReactNode {
  return seriesKey ? <SeriesDetail seriesKey={seriesKey} /> : <SeriesList />;
}
function SeriesList(): ReactNode {
  const s = useApi<SeriesRow[]>("/v1/series");
  return (
    <>
      <PageHead title="Series">Time series of public records. Revisions are kept as new versions; views show the latest version of each point.</PageHead>
      <Async state={s} empty={d => d.length === 0}>{rows => (
        <Table label="Series"><thead><tr><th>Series</th><th>Source</th><th>Frequency</th><th className="num">Tracks</th><th>Latest period</th><th>Evidence</th></tr></thead>
          <tbody>{rows.map(r => <tr key={r.series_key}><td><a href={`#/series/${r.series_key}`}>{r.title}</a>{r.description ? <div className="small muted" style={{ maxWidth: "52ch" }}>{r.description}</div> : null}</td><td>{r.source_key}</td><td>{r.frequency}</td><td className="num">{r.tracks}</td><td>{date(r.latest_period)}</td><td><Status value={r.latest_validation} /></td></tr>)}</tbody></Table>
      )}</Async>
    </>
  );
}

function SeriesDetail({ seriesKey }: { seriesKey: string }): ReactNode {
  const latest = useApi<Observation[]>(`/v1/series/${encodeURIComponent(seriesKey)}/latest`);
  const [track, setTrack] = useState<string>("");
  useEffect(() => { if (latest.data?.length && !track) setTrack(`${latest.data[0]!.subject}\u0000${latest.data[0]!.predicate}`); }, [latest.data, track]);
  const [subject, predicate] = track.split("\u0000");
  const obs = useApi<Observation[]>(track ? `/v1/series/${encodeURIComponent(seriesKey)}/observations?subject=${encodeURIComponent(subject!)}&predicate=${encodeURIComponent(predicate!)}&limit=600` : null);
  const cur = useMemo(() => latest.data?.find(o => `${o.subject}\u0000${o.predicate}` === track), [latest.data, track]);
  return (
    <>
      <PageHead title={seriesKey} aside={<a className="btn" href="#/series">All series</a>}>Pick a track to see its history. Exact values are in the table view.</PageHead>
      <Async state={latest}>{tracks => (
        <div className="grid">
          <Card>
            <label style={{ width: "100%" }}>Track<select value={track} onChange={e => setTrack(e.target.value)}>{tracks.map(t => <option key={`${t.subject}${t.predicate}`} value={`${t.subject}\u0000${t.predicate}`}>{t.subject.split("|").slice(1).join(" · ") || t.subject} — {t.predicate}</option>)}</select></label>
          </Card>
          <Card title={cur ? `${cur.predicate}` : "History"} aside={cur ? <span className="row"><DataClass value="public_record" /><Status value={cur.validation} /></span> : null}>
            <Async state={obs} empty={d => d.length === 0}>{rows => <>
              <LineChart title={`${seriesKey} ${cur?.predicate ?? ""}`} unit={rows[0]?.unit ?? ""} points={rows.map(o => ({ x: new Date(o.validTime).getTime(), y: o.value, label: month(o.validTime) }))} />
              <p className="small muted" style={{ marginTop: 10 }}>Latest point {month(rows[rows.length - 1]!.validTime)} · evidence <a href={`#/evidence/${rows[rows.length - 1]!.evidenceId}`} className="mono">{rows[rows.length - 1]!.evidenceId.slice(0, 8)}</a> · version {rows[rows.length - 1]!.version}</p>
            </>}</Async>
          </Card>
        </div>
      )}</Async>
    </>
  );
}
