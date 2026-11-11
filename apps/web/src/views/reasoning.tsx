import { useState, type ReactNode } from "react";
import { ApiError, api, type CaseListRow, type ReasoningCall, type ReasoningConfig, type ReasoningResult } from "../api";
import { Async, Card, PageHead, PagerBar, Table, useApi, usePaged } from "../components";
import { dateTime } from "../format";
import { t, tx } from "../i18n";

type Mode = "summary_briefing" | "summary_case" | "questions_case" | "recommendation_case" | "answer";
const MODES: { key: Mode; label: string; help: string }[] = [
  { key: "summary_briefing", label: tx("Summarise a briefing"), help: tx("Plain-language summary of a pack's briefing.") },
  { key: "summary_case", label: tx("Summarise a case"), help: tx("Summary of the stored evidence attached to a case.") },
  { key: "questions_case", label: tx("Questions and missing evidence"), help: tx("What an analyst could ask next, and what record seems to be missing.") },
  { key: "recommendation_case", label: tx("Draft a recommendation"), help: tx("A draft for a person to rewrite and submit. It is not a recommendation until a person files it.") },
  { key: "answer", label: tx("Ask a question"), help: tx("Answered only from stored records. If they do not say, it refuses.") },
];
void [tx("public record"), tx("sample dataset"), tx("scenario simulation")];
const VERDICT: Record<ReasoningResult["verdict"], [string, string]> = { accepted: ["b-ok", tx("Verified")], rejected: ["b-bad", tx("Failed verification")], refused: ["b-warn", tx("Not supported by the records")], blocked: ["b-warn", tx("Blocked by data class")], error: ["b-bad", tx("Model error")] };

function Result({ r, caseId }: { r: ReasoningResult; caseId: string | null }): ReactNode {
  const [v, label] = VERDICT[r.verdict], byRef = new Map(r.facts.map(f => [f.ref, f]));
  const [copied, setCopied] = useState(false);
  return (
    <Card title={<span className="row"><span className={`badge ${v}`}>{t(label)}</span><span className="small muted">{r.provider} · {r.model} · {dateTime(r.at)}</span></span>}>
      <p className="small muted" style={{ marginTop: 0 }}>{t("Drafted by a model, then checked by code against stored records. Every number must appear in a record the item cites. A draft is not a decision.")}</p>
      {r.output ? (
        <>
          {r.output.title ? <h3 style={{ margin: "4px 0 8px" }}>{r.output.title}</h3> : null}
          <ul className="plain" style={{ display: "grid", gap: 10, padding: 0, listStyle: "none" }}>{r.output.items.map((i, n) => (
            <li key={n}>
              {i.type !== "statement" ? <span className="badge b-plain" style={{ marginInlineEnd: 6 }}>{i.type === "question" ? t("Question") : t("Missing evidence")}</span> : null}<span lang="en" dir="auto">{i.text}</span>
              <div className="row small">{i.cites.map(c => { const f = byRef.get(c)!; return f.evidenceId ? <a key={c} className="mono" href={`#/evidence/${f.evidenceId}`} title={f.text}>{c} · {t("evidence")} {f.evidenceId.slice(0, 8)}</a> : <span key={c} className="mono muted" title={f.text}>{c} · {t("computed by the system")}</span>; })}</div>
            </li>))}</ul>
          {r.output.description ? <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => { void navigator.clipboard?.writeText(`${r.output!.title}\n\n${r.output!.description}`).then(() => setCopied(true)); }}>{copied ? t("Copied") : t("Copy the draft")}</button>
            {caseId ? <a className="btn" href={`#/cases/${caseId}`}>{t("Open the case to file it")}</a> : null}
          </div> : null}
        </>
      ) : <div className="note" role="status">{r.reasons.map((x, i) => <div key={i} lang="en" dir="auto">{x}</div>)}<div className="small muted">{t("Nothing from the model is shown.")}</div></div>}
      <details style={{ marginTop: 12 }}><summary>{t("What the model was given ({n} stored facts)", { n: r.facts.length })}{r.withheld ? `, ${t("{n} withheld by data class", { n: r.withheld })}` : ""}</summary>
        <ul className="small">{r.facts.map(f => <li key={f.ref}><span className="mono">{f.ref}</span> <span lang="en" dir="auto">{f.text}</span> <span className="muted">· {t(f.dataClass.replace(/_/g, " "))}</span></li>)}</ul>
        <p className="small muted mono" style={{ wordBreak: "break-all" }}>{t("prompt")} {r.promptHash} · {t("facts")} {r.factsHash}</p></details>
    </Card>
  );
}

export function Assistant({ can }: { can: (p: string) => boolean }): ReactNode {
  const cfg = useApi<ReasoningConfig>("/v1/reasoning/config");
  const cases = useApi<CaseListRow[]>(can("case.read") ? "/v1/cases?limit=100&active=1" : null);
  const log = usePaged<ReasoningCall>(can("reasoning.read") ? "/v1/reasoning/calls?limit=25" : null);
  const [mode, setMode] = useState<Mode>("summary_briefing"), [pack, setPack] = useState<"energy" | "sovereign">("energy"), [caseId, setCaseId] = useState(""), [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null), [result, setResult] = useState<{ r: ReasoningResult; caseId: string | null } | null>(null);
  const needsCase = mode.endsWith("_case"), ready = mode === "answer" ? question.trim().length >= 5 : needsCase ? caseId !== "" : true;
  async function run() {
    setBusy(true); setErr(null); setResult(null);
    try { const body = mode === "summary_briefing" ? { task: mode, pack } : mode === "answer" ? { task: mode, question } : { task: mode, caseId }; setResult({ r: await api<ReasoningResult>("/v1/reasoning/run", { method: "POST", body }), caseId: needsCase ? caseId : null }); log.reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : t("The draft could not be made.")); }
    finally { setBusy(false); }
  }
  return (
    <>
      <PageHead title={t("Assistant")}>{t("A model drafts plain-language text from stored records. Fixed code then checks every figure and citation, and only verified text is shown. Models never compute or decide anything here.")}</PageHead>
      <Async state={cfg}>{c => !c.enabled ? <div className="note">{t("No model is connected to this deployment. An operator connects one in the configuration; until then nothing is sent anywhere.")}</div> : (
        <>
          <div className="note" role="note">{t("Connected")}: <strong>{c.provider}</strong> · {c.model}. {t("Only data classed {classes} is ever placed in a prompt. Text people typed into cases is never sent. Limit: {n} drafts per person per hour.", { classes: c.sentClasses.map(x => t(x.replace(/_/g, " "))).join("، "), n: c.perHour })}</div>
          {!can("reasoning.use") ? <div className="note">{t("Your role can read the call log but cannot draft.")}</div> : <Card title={t("New draft")}>
            <div className="grid g2">
              <label>{t("What to draft")}<select value={mode} onChange={e => { setMode(e.target.value as Mode); setResult(null); }}>{MODES.map(m => <option key={m.key} value={m.key}>{t(m.label)}</option>)}</select><span className="small muted">{t(MODES.find(m => m.key === mode)!.help)}</span></label>
              {mode === "summary_briefing" ? <label>{t("Pack")}<select value={pack} onChange={e => setPack(e.target.value as "energy" | "sovereign")}><option value="energy">{t("Energy and Oil")}</option><option value="sovereign">{t("Sovereign Capital and Treasury")}</option></select></label> : null}
              {needsCase ? <label>{t("Case")}<select value={caseId} onChange={e => setCaseId(e.target.value)}><option value="">{t("Choose a case")}</option>{(cases.data ?? []).map(k => <option key={k.id} value={k.id}>{k.case_key} · {k.title.slice(0, 70)}</option>)}</select></label> : null}
              {mode === "answer" ? <label style={{ gridColumn: "1 / -1" }}>{t("Question")}<textarea rows={3} maxLength={500} value={question} onChange={e => setQuestion(e.target.value)} placeholder={t("For example: how far are Saudi crude exports below their recent level?")} /></label> : null}
            </div>
            <div className="row" style={{ marginTop: 12 }}><button disabled={busy || !ready} onClick={() => void run()}>{busy ? t("Drafting and checking…") : t("Draft")}</button></div>
            {err ? <div className="note err" role="alert" style={{ marginTop: 10 }}>{err}</div> : null}
          </Card>}
          {result ? <div style={{ marginTop: 16 }}><Result r={result.r} caseId={result.caseId} /></div> : null}
        </>
      )}</Async>
      {can("reasoning.read") ? (
        <div style={{ marginTop: 16 }}><Card title={t("Call log")} aside={<span className="small muted">{t("Every call is recorded and cannot be changed")}</span>}>
          <Async state={log} empty={d => d.length === 0}>{rows => (
            <Table label={t("Model calls")}><thead><tr><th>{t("When")}</th><th>{t("Task")}</th><th>{t("Model")}</th><th>{t("Verdict")}</th><th className="num">{t("Facts")}</th><th>{t("Notes")}</th></tr></thead>
              <tbody>{rows.map(r => <tr key={r.id}><td>{dateTime(r.created_at)}</td><td>{r.task.replace(/_/g, " ")}</td><td>{r.provider} · {r.model}</td><td>{r.verdict}</td><td className="num">{r.fact_count}</td><td className="small">{r.reasons.join("; ")}</td></tr>)}</tbody></Table>
          )}</Async>
          <PagerBar p={log} />
        </Card></div>
      ) : null}
    </>
  );
}
