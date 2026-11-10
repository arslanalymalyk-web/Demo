import type { ReactNode } from "react";
import type { ReadinessView } from "../api";
import { Async, Card, PageHead, useApi } from "../components";
import { t, tx } from "../i18n";

const BADGE = { pass: ["b-ok", tx("Done")], warn: ["b-warn", tx("Needs a decision")], fail: ["b-bad", tx("Blocks use")], manual: ["b-plain", tx("Confirm by hand")] } as const;
const ORDER = ["fail", "warn", "manual", "pass"] as const;

export function Readiness(): ReactNode {
  const view = useApi<ReadinessView>("/v1/readiness");
  return (
    <>
      <PageHead title={t("Readiness")}>{t('What is still open before this deployment is used for real work, read from the stored records and the running configuration. Items marked "Confirm by hand" cannot be checked from inside the system.')}</PageHead>
      <Async state={view}>{v => {
        const n = (s: string) => v.checks.filter(c => c.status === s).length;
        return (
          <>
            {v.ready ? <div className="note ok" role="status">{t("Nothing blocks use. {w} need a decision and {m} need confirming by hand.", { w: n("warn"), m: n("manual") })}</div>
              : <div className="note err" role="alert">{t("{n} block use. Fix those first.", { n: n("fail") })}</div>}
            <Card title={t("Checklist")} aside={<button onClick={view.reload}>{t("Check again")}</button>}>
              <ul className="plain" style={{ display: "grid", gap: 12, padding: 0, listStyle: "none", margin: 0 }}>
                {[...v.checks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).map(c => (
                  <li key={c.id} className="row" style={{ alignItems: "flex-start" }}>
                    <span className={`badge ${BADGE[c.status][0]}`} style={{ minWidth: 130, justifyContent: "center" }}>{t(BADGE[c.status][1])}</span>
                    <div style={{ flex: 1 }}><strong lang="en" dir="auto">{c.title}</strong><div className="small muted" lang="en" dir="auto">{c.detail}</div></div>
                    {c.href ? <a href={c.href}>{t("Open")}</a> : null}
                  </li>))}
              </ul>
            </Card>
          </>
        );
      }}</Async>
    </>
  );
}
