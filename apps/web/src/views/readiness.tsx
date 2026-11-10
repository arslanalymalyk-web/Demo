import type { ReactNode } from "react";
import type { ReadinessView } from "../api";
import { Async, Card, PageHead, useApi } from "../components";

const BADGE = { pass: ["b-ok", "Done"], warn: ["b-warn", "Needs a decision"], fail: ["b-bad", "Blocks use"], manual: ["b-plain", "Confirm by hand"] } as const;
const ORDER = ["fail", "warn", "manual", "pass"] as const;

export function Readiness(): ReactNode {
  const view = useApi<ReadinessView>("/v1/readiness");
  return (
    <>
      <PageHead title="Readiness">What is still open before this deployment is used for real work, read from the stored records and the running configuration. Items marked "Confirm by hand" cannot be checked from inside the system.</PageHead>
      <Async state={view}>{v => {
        const n = (s: string) => v.checks.filter(c => c.status === s).length;
        return (
          <>
            {v.ready ? <div className="note ok" role="status">Nothing blocks use. {n("warn")} item{n("warn") === 1 ? "" : "s"} need a decision and {n("manual")} need confirming by hand.</div>
              : <div className="note err" role="alert">{n("fail")} item{n("fail") === 1 ? "" : "s"} block use. Fix those first.</div>}
            <Card title="Checklist" aside={<button onClick={view.reload}>Check again</button>}>
              <ul className="plain" style={{ display: "grid", gap: 12, padding: 0, listStyle: "none", margin: 0 }}>
                {[...v.checks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).map(c => (
                  <li key={c.id} className="row" style={{ alignItems: "flex-start" }}>
                    <span className={`badge ${BADGE[c.status][0]}`} style={{ minWidth: 130, justifyContent: "center" }}>{BADGE[c.status][1]}</span>
                    <div style={{ flex: 1 }}><strong>{c.title}</strong><div className="small muted">{c.detail}</div></div>
                    {c.href ? <a href={c.href}>Open</a> : null}
                  </li>))}
              </ul>
            </Card>
          </>
        );
      }}</Async>
    </>
  );
}
