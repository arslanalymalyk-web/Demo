import { useState, type ReactNode } from "react";
import { api, type Me, type Param, type SettingVersion, type SettingsView } from "../api";
import { Async, Card, LinkClass, PageHead, Table, useAction, useApi } from "../components";
import { dateTime, num } from "../format";

type Scope = SettingVersion["scope"];
const TABS: { scope: Scope; label: string }[] = [{ scope: "signal_rules", label: "Signal thresholds" }, { scope: "scenario_defaults", label: "Scenario defaults" }, { scope: "hormuz_exposure", label: "Hormuz exposure" }, { scope: "ingestion_schedule", label: "Ingestion schedule" }];

export function Settings({ me, can }: { me: Me; can: (p: string) => boolean }): ReactNode {
  const view = useApi<SettingsView>("/v1/settings");
  const [scope, setScope] = useState<Scope>("signal_rules");
  return (
    <>
      <PageHead title="Settings">The numbers Tiger decides: when a signal fires, what a scenario assumes, and how exposed each producer is to the Strait. A change is drafted by one administrator and activated by another. Every version is kept, and every run records the version it used.</PageHead>
      <div className="tabs" role="tablist" aria-label="Settings">{TABS.map(t => <button key={t.scope} role="tab" aria-selected={scope === t.scope} onClick={() => setScope(t.scope)}>{t.label}</button>)}</div>
      <Async state={view}>{v => {
        const s = v.scopes.find(x => x.scope === scope)!;
        return (
          <div className="grid">
            <p style={{ margin: 0 }}>{s.description}</p>
            <Card title="In force" aside={s.active ? <span className="badge b-ok">Version {s.active.version}</span> : <span className="badge b-plain">Code defaults</span>}>
              {s.active ? <p className="small" style={{ margin: 0 }}>{s.active.note}<br /><span className="muted">Drafted by <span className="mono">{s.active.createdBy.slice(0, 8)}</span> · activated by <span className="mono">{s.active.activatedBy?.slice(0, 8)}</span> · {s.active.activatedAt ? dateTime(s.active.activatedAt) : ""}</span></p> : <p className="small muted" style={{ margin: 0 }}>No institution setting has been activated. The first-release defaults in the code apply, and runs and signals say so.</p>}
            </Card>
            {can("settings.manage") ? (
              <Card title="Draft a change" aside={<span className="small muted">A draft changes nothing until a different administrator activates it</span>}>
                {scope === "signal_rules" ? <SignalForm s={s} reload={view.reload} /> : scope === "scenario_defaults" ? <ScenarioForm v={v} reload={view.reload} /> : scope === "hormuz_exposure" ? <ExposureForm v={v} reload={view.reload} /> : <ScheduleForm v={v} s={s} reload={view.reload} />}
              </Card>
            ) : <div className="note">Your role can read settings but not change them.</div>}
            <Versions versions={s.versions} me={me} manage={can("settings.manage")} reload={view.reload} />
            <p className="small muted">Policy rules and the authority required to decide each action class are managed on the <a href="#/policy">Policy</a> page under the same two-person rule.</p>
          </div>
        );
      }}</Async>
    </>
  );
}

function Versions({ versions, me, manage, reload }: { versions: SettingVersion[]; me: Me; manage: boolean; reload: () => void }): ReactNode {
  const a = useAction(reload);
  return (
    <Card title="Versions">
      {versions.length === 0 ? <div className="empty">No versions yet.</div> : (
        <Table label="Settings versions"><thead><tr><th className="num">Version</th><th>Status</th><th>Why</th><th>Drafted</th><th>Activated</th><th /></tr></thead>
          <tbody>{versions.map(x => <tr key={x.id}><td className="num">v{x.version}</td><td><span className={`badge ${x.status === "active" ? "b-ok" : x.status === "draft" ? "b-warn" : "b-plain"}`}>{x.status === "draft" ? "Draft" : x.status === "active" ? "Active" : "Retired"}</span></td>
            <td className="small" style={{ maxWidth: "36ch" }}>{x.note}<details><summary>Values</summary><pre>{JSON.stringify(x.payload, null, 1)}</pre></details></td>
            <td className="small"><span className="mono">{x.createdBy.slice(0, 8)}</span>{x.createdBy === me.id ? " (you)" : ""}<div className="muted">{dateTime(x.createdAt)}</div></td>
            <td className="small">{x.activatedBy ? <><span className="mono">{x.activatedBy.slice(0, 8)}</span><div className="muted">{x.activatedAt ? dateTime(x.activatedAt) : ""}</div></> : "—"}</td>
            <td>{x.status === "draft" && manage ? (x.createdBy === me.id ? <span className="small muted">Another administrator must activate</span> : <button disabled={a.busy} onClick={() => void a.run(() => api(`/v1/settings/versions/${x.id}/activate`, { method: "POST", body: {} }))}>Activate</button>) : null}</td></tr>)}</tbody></Table>
      )}
      {a.error ? <div className="note err" role="alert" style={{ marginTop: 10 }}>{a.error}</div> : null}
    </Card>
  );
}

function Note({ value, set }: { value: string; set: (v: string) => void }): ReactNode {
  return <label>Why this change (recorded with the version)<textarea required minLength={10} value={value} onChange={e => set(e.target.value)} /></label>;
}

const SIGNAL_FIELDS: { rule: string; key: string; label: string; pct: boolean }[] = [
  { rule: "E1", key: "minMedian", label: "Smallest median worth reading (kb/d)", pct: false }, { rule: "E1", key: "watch", label: "Country exports below recent level: watch (%)", pct: true }, { rule: "E1", key: "alert", label: "Country exports below recent level: alert (%)", pct: true },
  { rule: "E2", key: "watch", label: "Brent monthly move: watch (%)", pct: true }, { rule: "E2", key: "alert", label: "Brent monthly move: alert (%)", pct: true },
  { rule: "E3", key: "watch", label: "Gulf total exports below recent level: watch (%)", pct: true }, { rule: "E3", key: "alert", label: "Gulf total exports below recent level: alert (%)", pct: true },
  { rule: "S1", key: "watch", label: "Quarterly change in reserves: watch (%)", pct: true }, { rule: "S1", key: "alert", label: "Quarterly change in reserves: alert (%)", pct: true },
  { rule: "S2", key: "watchBelow", label: "Liquid share of reserves: watch below (%)", pct: true }, { rule: "S2", key: "alertBelow", label: "Liquid share of reserves: alert below (%)", pct: true },
  { rule: "S3", key: "watchBelowMedian", label: "Trade balance below its median: watch (%)", pct: true },
  { rule: "S4", key: "watch", label: "Inflation rate: watch (%)", pct: false }, { rule: "S4", key: "alert", label: "Inflation rate: alert (%)", pct: false },
];

function SignalForm({ s, reload }: { s: SettingsView["scopes"][number]; reload: () => void }): ReactNode {
  const base = s.active?.payload ?? s.defaults;
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(SIGNAL_FIELDS.map(f => [`${f.rule}.${f.key}`, String(f.pct ? +(base[f.rule][f.key] * 100).toFixed(2) : base[f.rule][f.key])])));
  const [note, setNote] = useState("");
  const a = useAction(reload);
  const submit = () => { const p: any = {}; for (const f of SIGNAL_FIELDS) { (p[f.rule] ??= {})[f.key] = f.pct ? Number(vals[`${f.rule}.${f.key}`]) / 100 : Number(vals[`${f.rule}.${f.key}`]); } return a.run(() => api("/v1/settings/signal_rules", { method: "POST", body: { payload: p, note } })); };
  return (
    <form className="stack" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <Table label="Signal thresholds"><thead><tr><th>Rule</th><th>Threshold</th><th className="num">Code default</th><th className="num">New value</th></tr></thead>
        <tbody>{SIGNAL_FIELDS.map(f => <tr key={`${f.rule}.${f.key}`}><td className="mono">{f.rule}</td><td>{f.label}</td><td className="num">{f.pct ? +(s.defaults[f.rule][f.key] * 100).toFixed(2) : s.defaults[f.rule][f.key]}</td>
          <td className="num"><input type="number" step="any" aria-label={f.label} value={vals[`${f.rule}.${f.key}`]} onChange={e => setVals({ ...vals, [`${f.rule}.${f.key}`]: e.target.value })} /></td></tr>)}</tbody></Table>
      <Note value={note} set={setNote} />
      {a.error ? <div className="note err" role="alert">{a.error}</div> : null}
      <button className="primary" disabled={a.busy}>Save as draft</button>
    </form>
  );
}

interface Edit { on: boolean; value: string; low: string; high: string; basis: "assumed" | "sourced"; evidenceId: string; note: string }

function ScenarioForm({ v, reload }: { v: SettingsView; reload: () => void }): ReactNode {
  const active = v.scopes.find(x => x.scope === "scenario_defaults")!.active?.payload ?? {};
  const [tpl, setTpl] = useState(v.catalog[0]!.key), [edits, setEdits] = useState<Record<string, Edit>>({}), [note, setNote] = useState("");
  const a = useAction(reload);
  const t = v.catalog.find(x => x.key === tpl)!;
  const get = (k: string, p: Param): Edit => edits[`${tpl}.${k}`] ?? (active[tpl]?.[k] ? { on: true, value: String(active[tpl][k].value), low: String(active[tpl][k].low), high: String(active[tpl][k].high), basis: active[tpl][k].basis, evidenceId: active[tpl][k].evidenceId ?? "", note: active[tpl][k].note } : { on: false, value: String(p.value), low: String(p.low), high: String(p.high), basis: "assumed", evidenceId: "", note: "" });
  const set = (k: string, p: Param, patch: Partial<Edit>) => setEdits({ ...edits, [`${tpl}.${k}`]: { ...get(k, p), ...patch } });
  const submit = () => {
    const payload: any = JSON.parse(JSON.stringify(active));
    for (const tt of v.catalog) for (const k of Object.keys(tt.parameters)) {
      const e = edits[`${tt.key}.${k}`]; if (!e) continue;
      if (!e.on) { if (payload[tt.key]) { delete payload[tt.key][k]; if (!Object.keys(payload[tt.key]).length) delete payload[tt.key]; } continue; }
      (payload[tt.key] ??= {})[k] = { value: Number(e.value), low: Number(e.low), high: Number(e.high), basis: e.basis, note: e.note, ...(e.basis === "sourced" ? { evidenceId: e.evidenceId } : {}) };
    }
    return a.run(() => api("/v1/settings/scenario_defaults", { method: "POST", body: { payload, note } }));
  };
  return (
    <form className="stack" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label>Template<select value={tpl} onChange={e => setTpl(e.target.value)}>{v.catalog.map(x => <option key={x.key} value={x.key}>{x.title}</option>)}</select></label>
      <Table label="Parameters"><thead><tr><th>Set</th><th>Parameter</th><th className="num">Code default</th><th className="num">Value</th><th className="num">Low</th><th className="num">High</th><th>Basis</th><th>Evidence id (sourced)</th><th>Where it comes from</th></tr></thead>
        <tbody>{Object.entries(t.parameters).map(([k, p]) => { const e = get(k, p); return (
          <tr key={k}><td><input type="checkbox" aria-label={`Set ${k}`} checked={e.on} onChange={x => set(k, p, { on: x.target.checked })} /></td><td>{k}<div className="small muted" style={{ maxWidth: "32ch" }}>{p.note}</div></td><td className="num">{num(p.value, 3)}<div className="small muted">{num(p.low, 2)}–{num(p.high, 2)}</div></td>
            {(["value", "low", "high"] as const).map(f => <td key={f} className="num"><input type="number" step="any" disabled={!e.on} aria-label={`${k} ${f}`} value={e[f]} onChange={x => set(k, p, { [f]: x.target.value })} /></td>)}
            <td><select disabled={!e.on} value={e.basis} onChange={x => set(k, p, { basis: x.target.value as Edit["basis"] })}><option value="assumed">Assumed</option><option value="sourced">Sourced</option></select></td>
            <td><input type="text" disabled={!e.on || e.basis !== "sourced"} value={e.evidenceId} onChange={x => set(k, p, { evidenceId: x.target.value })} placeholder="evidence record id" /></td>
            <td><input type="text" disabled={!e.on} value={e.note} onChange={x => set(k, p, { note: x.target.value })} placeholder="Tiger's note" /></td></tr>); })}</tbody></Table>
      <p className="small muted">A new version keeps everything already set and changes only what is ticked here. Unticking a parameter returns it to the code default.</p>
      <Note value={note} set={setNote} />
      {a.error ? <div className="note err" role="alert">{a.error}</div> : null}
      <button className="primary" disabled={a.busy}>Save as draft</button>
    </form>
  );
}

interface Ex { on: boolean; share: string; bypass: string; basis: "assumed" | "sourced"; evidenceId: string; rationale: string }
function ExposureForm({ v, reload }: { v: SettingsView; reload: () => void }): ReactNode {
  const [rows, setRows] = useState<Record<string, Ex>>({}), [note, setNote] = useState("");
  const a = useAction(reload);
  const get = (c: SettingsView["exposure"][number]): Ex => rows[c.code] ?? { on: false, share: String(+(c.hormuzShare * 100).toFixed(1)), bypass: String(c.spareBypassKbd), basis: "assumed", evidenceId: "", rationale: "" };
  const set = (c: SettingsView["exposure"][number], patch: Partial<Ex>) => setRows({ ...rows, [c.code]: { ...get(c), ...patch } });
  const submit = () => { const p: any = {}; for (const c of v.exposure) { const e = rows[c.code]; if (e?.on) p[c.code] = { hormuzShare: Number(e.share) / 100, spareBypassKbd: Number(e.bypass), basis: e.basis, rationale: e.rationale, ...(e.basis === "sourced" ? { evidenceId: e.evidenceId } : {}) }; } return a.run(() => api("/v1/settings/hormuz_exposure", { method: "POST", body: { payload: p, note } })); };
  return (
    <form className="stack" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <Table label="Hormuz exposure"><thead><tr><th>Set</th><th>Country</th><th>Now in the graph</th><th className="num">Share through Hormuz (%)</th><th className="num">Spare bypass (kb/d)</th><th>Basis</th><th>Evidence id (sourced)</th><th>Rationale</th></tr></thead>
        <tbody>{v.exposure.map(c => { const e = get(c); return (
          <tr key={c.code}><td><input type="checkbox" aria-label={`Set ${c.name}`} checked={e.on} onChange={x => set(c, { on: x.target.checked })} /></td><td>{c.name}</td><td className="small">{+(c.hormuzShare * 100).toFixed(1)}% · {num(c.spareBypassKbd, 0)} kb/d <LinkClass value={c.linkClass} /></td>
            <td className="num"><input type="number" step="any" disabled={!e.on} aria-label={`${c.name} share`} value={e.share} onChange={x => set(c, { share: x.target.value })} /></td>
            <td className="num"><input type="number" step="any" disabled={!e.on} aria-label={`${c.name} bypass`} value={e.bypass} onChange={x => set(c, { bypass: x.target.value })} /></td>
            <td><select disabled={!e.on} value={e.basis} onChange={x => set(c, { basis: x.target.value as Ex["basis"] })}><option value="assumed">Assumed</option><option value="sourced">Sourced</option></select></td>
            <td><input type="text" disabled={!e.on || e.basis !== "sourced"} value={e.evidenceId} onChange={x => set(c, { evidenceId: x.target.value })} placeholder="evidence record id" /></td>
            <td><input type="text" disabled={!e.on} value={e.rationale} onChange={x => set(c, { rationale: x.target.value })} placeholder="at least 10 characters" /></td></tr>); })}</tbody></Table>
      <p className="small muted">Activation rewrites these links in the graph with the basis stated here, retires the old links, and takes effect for every new scenario run. A sourced value must cite an evidence record.</p>
      <Note value={note} set={setNote} />
      {a.error ? <div className="note err" role="alert">{a.error}</div> : null}
      <button className="primary" disabled={a.busy}>Save as draft</button>
    </form>
  );
}

interface Sch { on: boolean; hours: string; mode: "series" | "catalog" }
function ScheduleForm({ v, s, reload }: { v: SettingsView; s: SettingsView["scopes"][number]; reload: () => void }): ReactNode {
  const cur = (s.active?.payload ?? { steward: null, pauseAfterFailures: 6, sources: {} }) as { steward: string | null; pauseAfterFailures: number; sources: Record<string, { intervalHours: number; mode: "series" | "catalog" }> };
  const [rows, setRows] = useState<Record<string, Sch>>({}), [steward, setSteward] = useState<string>(cur.steward ?? ""), [after, setAfter] = useState(String(cur.pauseAfterFailures)), [note, setNote] = useState("");
  const a = useAction(reload);
  const get = (k: string, modes: string[]): Sch => rows[k] ?? { on: !!cur.sources[k], hours: String(cur.sources[k]?.intervalHours ?? 24), mode: cur.sources[k]?.mode ?? (modes[0] as Sch["mode"]) };
  const set = (k: string, modes: string[], p: Partial<Sch>) => setRows({ ...rows, [k]: { ...get(k, modes), ...p } });
  const submit = () => { const sources: Record<string, { intervalHours: number; mode: string }> = {}; for (const x of v.schedule.sources) { const r = get(x.key, x.modes); if (r.on) sources[x.key] = { intervalHours: Number(r.hours), mode: r.mode }; } return a.run(() => api("/v1/settings/ingestion_schedule", { method: "POST", body: { payload: { steward: steward || null, pauseAfterFailures: Number(after), sources }, note } })); };
  return (
    <form className="stack" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <Table label="Ingestion schedule"><thead><tr><th>Fetch</th><th>Source</th><th>Platform</th><th className="num">Every (hours)</th><th>Mode</th></tr></thead>
        <tbody>{v.schedule.sources.map(x => { const r = get(x.key, x.modes); return (
          <tr key={x.key}><td><input type="checkbox" aria-label={`Fetch ${x.name}`} checked={r.on} onChange={e => set(x.key, x.modes, { on: e.target.checked })} /></td><td>{x.name}<div className="small muted mono">{x.key}</div></td><td>{x.platform}</td>
            <td className="num"><input type="number" min={1} max={8760} disabled={!r.on} aria-label={`${x.name} interval`} value={r.hours} onChange={e => set(x.key, x.modes, { hours: e.target.value })} /></td>
            <td><select disabled={!r.on} value={r.mode} onChange={e => set(x.key, x.modes, { mode: e.target.value as Sch["mode"] })}>{x.modes.map(m => <option key={m} value={m}>{m}</option>)}</select></td></tr>); })}</tbody></Table>
      <div className="grid g2">
        <label>Steward, who owns the cases opened for a stale or failing source<select value={steward} onChange={e => setSteward(e.target.value)}><option value="">No automatic cases</option>{v.schedule.stewards.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Pause a source after this many failed fetches in a row<input type="number" min={3} max={20} value={after} onChange={e => setAfter(e.target.value)} /></label>
      </div>
      <p className="small muted">Only approved sources appear. After a failure the next try comes after 15 minutes, then 30, 60 and so on, never later than the normal interval. A paused source stays paused until a person resumes it on the Source health page. The fetch is rate limited and follows each source's terms.</p>
      <Note value={note} set={setNote} />
      {a.error ? <div className="note err" role="alert">{a.error}</div> : null}
      <button className="primary" disabled={a.busy}>Save as draft</button>
    </form>
  );
}
