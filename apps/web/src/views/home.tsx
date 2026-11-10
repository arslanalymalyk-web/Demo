import type { ReactNode } from "react";
import { ageDays, date, dateTime, num } from "../format";
import { Async, Card, DataClass, LazyProvenance, LineChart, PageHead, Stat, Status, Table, useApi } from "../components";
import type { Observation, RunSummary, SeriesRow, SourceRow } from "../api";
import { month } from "../format";
import { t } from "../i18n";

const BRENT = "imf-commodity-prices-monthly|commodity=POILBRE";

export function Home({ can }: { can: (p: string) => boolean }): ReactNode {
  const sources = useApi<SourceRow[]>(can("sources.read") ? "/v1/sources" : null);
  const series = useApi<SeriesRow[]>(can("series.read") ? "/v1/series" : null);
  const runs = useApi<RunSummary[]>(can("scenario.read") ? "/v1/scenarios/runs" : null);
  const audit = useApi<{ ok: boolean; events: number }>(can("audit.verify") ? "/v1/audit/verify" : null);
  const brent = useApi<Observation[]>(can("series.read") ? `/v1/series/imf-commodity-prices-monthly/observations?subject=${encodeURIComponent(BRENT)}&from=2025-01-01T00:00:00Z` : null);

  return (
    <>
      <PageHead title={t("Command Centre")}>{t("What is connected, how fresh it is, and what needs attention. Every figure opens to its source.")}</PageHead>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Async state={sources}>{s => {
          const total = (k: "accepted" | "warned" | "quarantined") => s.reduce((a, x) => a + x[k], 0);
          return <>
            <Stat value={s.filter(x => x.status === "approved").length} label={t("Approved sources")} sub={t("{p} pending rights · {b} blocked", { p: s.filter(x => x.status === "pending_rights").length, b: s.filter(x => x.status === "blocked").length })} />
            <Stat value={total("accepted") + total("warned")} label={t("Evidence records held")} sub={t("{a} accepted · {w} warned", { a: total("accepted"), w: total("warned") })} />
            <Stat value={total("quarantined")} label={t("Quarantined")} sub={t("Held out of every calculation")} />
          </>;
        }}</Async>
        {can("audit.verify") ? <Async state={audit}>{a => <Stat value={a.ok ? t("Intact") : t("Broken")} label={t("Audit chain")} sub={t("{n} events verified", { n: num(a.events, 0) })} />}</Async> : <Stat value={t("Restricted")} label={t("Audit chain")} sub={t("Auditor role required")} />}
      </div>

      <div className="grid g2">
        {can("series.read") ? (
          <Card title={t("Brent crude, monthly")} aside={<DataClass value="public_record" />}>
            <Async state={brent} empty={d => d.length === 0}>{obs => {
              const last = obs[obs.length - 1]!;
              return <>
                <div className="stat" style={{ marginBottom: 10 }}><span className="v">US$ {num(last.value, 1)}</span><span className="l">{t("per barrel, {month}", { month: month(last.validTime) })}</span>
                  <span className="s">{t("IMF primary commodity prices · period {month}", { month: month(last.validTime) })} · <Status value={last.validation} /></span></div>
                <LineChart title={t("Brent crude price")} unit={t("US$ per barrel")} points={obs.map(o => ({ x: new Date(o.validTime).getTime(), y: o.value, label: month(o.validTime) }))} />
                <div style={{ marginTop: 10 }}><LazyProvenance evidenceId={last.evidenceId} /></div>
              </>;
            }}</Async>
          </Card>
        ) : null}
        {can("scenario.read") ? (
          <Card title={t("Recent scenario runs")} aside={<a href="#/scenarios">{t("All scenarios")}</a>}>
            <Async state={runs} empty={d => d.length === 0}>{r => (
              <Table label={t("Recent scenario runs")}><thead><tr><th>{t("Run")}</th><th>{t("Template")}</th><th>{t("Confidence")}</th><th>{t("When")}</th></tr></thead>
                <tbody>{r.slice(0, 6).map(x => <tr key={x.id}><td><a href={`#/scenarios/runs/${x.id}`}>{x.id.slice(0, 8)}</a></td><td>{x.template_key}</td><td><Status value={x.confidence} /></td><td>{dateTime(x.created_at)}</td></tr>)}</tbody></Table>
            )}</Async>
          </Card>
        ) : null}
      </div>

      {can("series.read") ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t("Series freshness")} aside={<span className="small muted">{t("Stale means the latest period is older than the series allows.")}</span>}>
            <Async state={series} empty={d => d.length === 0}>{rows => (
              <Table label={t("Series freshness")}><thead><tr><th>{t("Series")}</th><th>{t("Source")}</th><th>{t("Latest period")}</th><th>{t("Evidence")}</th><th>{t("Freshness")}</th></tr></thead>
                <tbody>{rows.map(s => {
                  const stale = s.latest_period && s.max_age_days ? ageDays(s.latest_period) > s.max_age_days : false;
                  return <tr key={s.series_key}><td><a href={`#/series/${s.series_key}`}>{s.title}</a><div className="small muted">{s.frequency}</div></td><td>{s.source_key}</td><td>{date(s.latest_period)}</td><td><Status value={s.latest_validation} /></td><td>{s.latest_period ? <Status value={stale ? "stale" : "current"} /> : "—"}</td></tr>;
                })}</tbody></Table>
            )}</Async>
          </Card>
        </div>
      ) : null}
    </>
  );
}
