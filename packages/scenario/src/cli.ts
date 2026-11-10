import pg from "pg";
import { PostgresGraph, seedOilStructure } from "../../graph/src/index.js";
import { withTenant } from "../../ingest/src/store.js";
import { TEMPLATES } from "./templates.js";
import { EPISODE, createRun, episodeBacktest, getRun, latestBaselineMonth, replayRun } from "./service.js";

const [cmd, ...rest] = process.argv.slice(2);
const institutionId = process.env.TIGERIS_INSTITUTION_ID;
if (!process.env.DATABASE_URL || !institutionId) { console.error("DATABASE_URL and TIGERIS_INSTITUTION_ID are required"); process.exit(2); }
const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const sets = Object.fromEntries(rest.flatMap((a, i) => a === "--set" ? [rest[i + 1]!.split("=") as [string, string]] : []).map(([k, v]) => [k, Number(v)]));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const print = (x: unknown) => console.log(JSON.stringify(x, null, 1));
try {
  if (cmd === "seed-graph") print(await withTenant(pool, institutionId, async c => ({ ...(await seedOilStructure(c, institutionId)), snapshot: await new PostgresGraph(c, institutionId).snapshot() })));
  else if (cmd === "backtest") print(await withTenant(pool, institutionId, c => episodeBacktest(c, institutionId, EPISODE.baseline, EPISODE.months, 100000)));
  else if (cmd === "run" && rest[0]) {
    const run = await withTenant(pool, institutionId, async c => createRun(c, institutionId, { templateKey: rest[0]!, overrides: sets, createdBy: "cli", ...(opt("month") ? { baselineMonth: opt("month")! } : {}) }));
    print({ id: run.id, template: run.templateKey, baselineMonth: run.baseline.month, confidence: run.confidence, manifestHash: run.manifestHash, resultsHash: run.resultsHash,
      headline: run.metrics.filter(m => m.metric === TEMPLATES[run.templateKey]!.headline.metric || ["brent_end_usd", "gulf_revenue_delta_musd", "sa_reserve_drawdown_pct", "lost_supply_kbd", "reserves_remaining_pct", "runway_years", "change_pct", "delta_pct_of_annual_gdp"].includes(m.metric)).map(m => ({ horizon: m.horizon, metric: m.metric, value: Math.round(m.value * 100) / 100, unit: m.unit, band: run.bands[`${m.horizon}|${m.metric}`] })),
      topSensitivities: run.sensitivity.map(s => ({ param: s.param, basis: s.basis, swingOnHeadline: (() => { const e = s.effects[`${TEMPLATES[run.templateKey]!.headline.horizon}|${TEMPLATES[run.templateKey]!.headline.metric}`]!; return Math.abs(e[1] - e[0]); })() })).sort((a, b) => b.swingOnHeadline - a.swingOnHeadline).slice(0, 5) });
  }
  else if (cmd === "replay" && rest[0]) print(await withTenant(pool, institutionId, c => replayRun(c, rest[0]!)));
  else if (cmd === "show" && rest[0]) print(await withTenant(pool, institutionId, c => getRun(c, rest[0]!)));
  else if (cmd === "latest-month") print(await withTenant(pool, institutionId, c => latestBaselineMonth(c)));
  else { console.error("usage: seed-graph | backtest | run <template> [--set k=v] [--month YYYY-MM] | replay <id> | show <id> | latest-month"); process.exit(2); }
} finally { await pool.end(); }
