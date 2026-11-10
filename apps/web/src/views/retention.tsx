import type { ReactNode } from "react";
import type { RetentionReport } from "../api";
import { Async, Card, PageHead, Table, useApi } from "../components";
import { date, dateTime, num } from "../format";

export function Retention(): ReactNode {
  const r = useApi<RetentionReport>("/v1/retention");
  return (
    <>
      <PageHead title="Retention">How long records are kept and what is protected. Decisions, audit and memory are kept for ten years. This system never deletes a record on its own: anything past the horizon is listed here for a person to review.</PageHead>
      <Async state={r}>{d => (
        <div className="grid">
          <div className="note">{d.deletion} Review horizon: records created on or before <strong>{date(d.reviewHorizon)}</strong>. {d.note}</div>
          <Card title="Record classes">
            <Table label="Retention by record class"><thead><tr><th>Class</th><th className="num">Records</th><th>Oldest</th><th>Newest</th><th className="num">Past the horizon</th><th>Basis</th></tr></thead>
              <tbody>{d.classes.map(c => <tr key={c.key}><td>{c.label}</td><td className="num">{num(c.records, 0)}</td><td>{c.oldest ? date(c.oldest) : "—"}</td><td>{c.newest ? date(c.newest) : "—"}</td><td className="num">{c.reviewDue ? <span className="badge b-warn">{num(c.reviewDue, 0)} to review</span> : "0"}</td><td className="small muted" style={{ maxWidth: "40ch" }}>{c.basis}</td></tr>)}</tbody></Table>
          </Card>
          <div className="grid g2">
            <Card title="Legal holds">
              {d.holds.length === 0 ? <div className="empty">No holds.</div> : <Table label="Holds"><thead><tr><th>Case</th><th>Reason</th><th>Status</th></tr></thead>
                <tbody>{d.holds.map(h => <tr key={h.id}><td><a href={`#/cases/${h.caseId}`} className="mono">{h.caseKey}</a></td><td className="small">{h.reason}<div className="muted">Placed {dateTime(h.placedAt)}</div></td><td>{h.releasedAt ? <><span className="badge b-plain">Released</span><div className="small muted">{dateTime(h.releasedAt)}<br />{h.releaseReason}</div></> : <span className="badge b-bad">On hold</span>}</td></tr>)}</tbody></Table>}
            </Card>
            <Card title="Exports">
              {d.exports.length === 0 ? <div className="empty">No record has been exported.</div> : <Table label="Exports"><thead><tr><th>When</th><th>Purpose</th><th>Hash</th></tr></thead>
                <tbody>{d.exports.map(e => <tr key={e.id}><td>{dateTime(e.exportedAt)}</td><td className="small">{e.purpose}</td><td className="mono small">{e.sha256.slice(0, 16)}…<div className="muted">{num(e.bytes / 1024, 0)} KB</div></td></tr>)}</tbody></Table>}
              <p className="small muted" style={{ marginTop: 8 }}>Each export carries a hash over its content, recorded here and in the audit trail, so a copy can be checked against the original.</p>
            </Card>
          </div>
        </div>
      )}</Async>
    </>
  );
}
