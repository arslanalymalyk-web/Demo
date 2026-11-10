import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, upload, type DocConfig, type DocDetail, type DocHit, type DocRow } from "../api";
import { Async, Card, DataClass, PageHead, Table, useApi } from "../components";
import { dateTime, num } from "../format";

const STATE: Record<string, [string, string]> = { queued: ["b-info", "Queued"], processing: ["b-info", "Reading"], ready: ["b-ok", "Ready"], failed: ["b-bad", "Failed"], quarantined: ["b-bad", "Quarantined"] };
const DocState = ({ v }: { v: string }): ReactNode => { const [c, l] = STATE[v] ?? ["b-plain", v]; return <span className={`badge ${c}`}><span className="dot" aria-hidden="true" />{l}</span>; };
const METHOD: Record<string, string> = { "text-layer": "Text layer", ocr: "OCR (scanned)", plain: "Plain text", docx: "Word text" };
const LANGS: Record<string, string> = { ar: "Arabic", en: "English", mixed: "Arabic and English", unknown: "Not determined" };
const kb = (n: number): string => n < 1024 ? `${n} B` : n > 1024 * 1024 ? `${num(n / 1024 / 1024, 1)} MB` : `${num(n / 1024, 0)} KB`;

/** Search snippets mark hits with ⟦ ⟧. The text comes from an uploaded file, so it is shown as text and never as markup. */
function Snippet({ text }: { text: string }): ReactNode {
  return <span dir="auto">{text.split(/(⟦[^⟧]*⟧)/).map((p, i) => p.startsWith("⟦") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>)}</span>;
}

function usePolling(rows: DocRow[] | null, reload: () => void): void {
  const active = rows?.some(r => r.status === "queued" || r.status === "processing") ?? false;
  useEffect(() => { if (!active) return; const t = setInterval(reload, 2500); return () => clearInterval(t); }, [active, reload]);
}

export function Documents({ can }: { can: (p: string) => boolean }): ReactNode {
  const list = useApi<DocRow[]>("/v1/documents");
  const cfg = useApi<DocConfig>("/v1/documents/config");
  usePolling(list.data, list.reload);
  const [q, setQ] = useState(""), [term, setTerm] = useState("");
  const hits = useApi<DocHit[]>(term.length >= 2 ? `/v1/documents/search?q=${encodeURIComponent(term)}` : null);
  return (
    <>
      <PageHead title="Documents">Reports, scans and files become evidence. Each one is stored unchanged, read with deterministic tools, and keeps its page-by-page record of how the text was obtained. No model reads or rewrites the content.</PageHead>
      <Async state={cfg}>{c => <>
        {c.scan.infected > 0 ? <div className="note err" role="alert"><strong>{c.scan.infected} file{c.scan.infected === 1 ? " was" : "s were"} flagged by the malware scanner.</strong> Flagged files are recorded but not opened, searched or downloadable, and their contents are not kept. They are listed below.</div> : null}
        {c.scanner.configured && !c.scanner.reachable ? <div className="note err" role="alert">The malware scanner is not answering. New uploads are held, unopened, and retried until it is back.</div> : null}
        {!c.scanner.configured ? <div className="note" role="status">No malware scanner is connected to this deployment, so uploaded files are not scanned. Institution documents cannot be uploaded until one is.</div> : <div className="small muted" style={{ marginBottom: 8 }}>Malware scanner: {c.scanner.engine} · {c.scanner.reachable ? c.scanner.version : "not answering"}.{c.scan.pending + c.scan.error > 0 ? ` ${c.scan.pending + c.scan.error} waiting for a scan.` : ""}</div>}
      </>}</Async>
      {can("document.upload") ? <Async state={cfg}>{c => <UploadForm cfg={c} onDone={list.reload} />}</Async> : <div className="note">Your role can read documents but not add them.</div>}
      <form className="row" style={{ margin: "18px 0 14px" }} onSubmit={e => { e.preventDefault(); setTerm(q.trim()); }}>
        <label>Search inside documents<input type="search" minLength={2} value={q} onChange={e => setQ(e.target.value)} placeholder="Kuwait, برنت, reserves…" dir="auto" /></label><button style={{ alignSelf: "flex-end" }}>Search</button>
      </form>
      {term ? <Card title={`Results for “${term}”`}><Async state={hits} empty={d => d.length === 0}>{rows => (
        <Table label="Search results"><thead><tr><th>Document</th><th>Page</th><th>Passage</th></tr></thead>
          <tbody>{rows.map(h => <tr key={`${h.id}-${h.page_no}`}><td><a href={`#/documents/${h.id}`}>{h.title}</a><div><DataClass value={h.data_class} /></div></td><td className="num">{h.page_no}</td><td><Snippet text={h.snippet} /><div className="small muted">{METHOD[h.method] ?? h.method}</div></td></tr>)}</tbody></Table>
      )}</Async></Card> : null}
      <div style={{ marginTop: 16 }}>
        <Card title="All documents">
          <Async state={list} empty={d => d.length === 0}>{rows => (
            <Table label="Documents"><thead><tr><th>Document</th><th>Class</th><th>Status</th><th className="num">Pages</th><th>Text from</th><th>Added</th></tr></thead>
              <tbody>{rows.map(d => <tr key={d.id}><td><a href={`#/documents/${d.id}`}>{d.title}</a><div className="small muted">{d.filename} · {kb(d.size_bytes)}</div></td><td><DataClass value={d.data_class} /></td><td><DocState v={d.status} />{d.scan_status === "pending" || d.scan_status === "error" ? <div className="small muted">Waiting for a malware scan{d.scan_attempts > 0 ? ` (tried ${d.scan_attempts}×)` : ""}</div> : null}{d.scan_status === "infected" ? <div><span className="badge b-bad">Malware flagged</span></div> : null}{d.error ? <div className="small muted" style={{ maxWidth: "34ch" }}>{d.error}</div> : null}</td>
                <td className="num">{d.page_count ?? "—"}</td><td>{d.status === "ready" || d.status === "quarantined" ? (d.ocr_used ? <>OCR{d.avg_confidence !== null ? <span className="small muted"> · {num(d.avg_confidence, 0)}% confidence</span> : null}</> : "Text layer") : "—"}</td><td>{dateTime(d.created_at)}</td></tr>)}</tbody></Table>
          )}</Async>
        </Card>
      </div>
    </>
  );
}

function UploadForm({ cfg, onDone }: { cfg: DocConfig; onDone: () => void }): ReactNode {
  const file = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ title: "", dataClass: "public_record", agency: "", rights: "", sourceUrl: "", lang: "eng" });
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null), [msg, setMsg] = useState<string | null>(null);
  const langs = cfg.ocr.available ? cfg.ocr.languages : [];
  async function submit(e: FormEvent) {
    e.preventDefault(); const picked = file.current?.files?.[0]; if (!picked) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await upload<{ id: string; duplicate: boolean }>("/v1/documents", picked, { "x-filename": picked.name, "x-title": f.title, "x-data-class": f.dataClass, "x-original-agency": f.agency, "x-rights": f.rights, "x-source-url": f.sourceUrl, "x-languages": f.lang });
      setMsg(r.body.duplicate ? "This exact file is already stored. Showing the existing record in the list." : "Uploaded. It is being read now."); if (file.current) file.current.value = ""; setF({ ...f, title: "" }); onDone();
    } catch (x) { setErr(x instanceof ApiError ? x.message : "The upload failed."); } finally { setBusy(false); }
  }
  return (
    <Card title="Add a document" aside={<span className="small muted">{cfg.accepted.join(", ")} · up to {cfg.maxMegabytes} MB and {cfg.maxPages} pages</span>}>
      <form className="stack" onSubmit={submit}>
        <label>File<input ref={file} type="file" required accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.docx,.txt,.md,.csv" /></label>
        <label>Title<input type="text" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="Defaults to the file name" /></label>
        <div className="row">
          <label>What kind of material is it?<select value={f.dataClass} onChange={e => setF({ ...f, dataClass: e.target.value })}>
            <option value="public_record">Public record</option><option value="sample_dataset">Sample dataset</option>{cfg.clientDataEnabled ? <option value="institution_own">Institution document</option> : null}</select></label>
          <label>Text language for scans<select value={f.lang} onChange={e => setF({ ...f, lang: e.target.value })}>
            <option value="eng">English</option>{langs.includes("ara") ? <option value="ara">Arabic</option> : null}{langs.includes("ara") && langs.includes("eng") ? <option value="eng+ara">English and Arabic</option> : null}</select></label>
        </div>
        <label>Publishing agency{f.dataClass === "public_record" ? " (required for a public record)" : ""}<input type="text" value={f.agency} onChange={e => setF({ ...f, agency: e.target.value })} required={f.dataClass === "public_record"} dir="auto" /></label>
        <label>Rights: under what terms may this be used?<input type="text" required minLength={3} value={f.rights} onChange={e => setF({ ...f, rights: e.target.value })} placeholder="e.g. Public report, open licence" dir="auto" /></label>
        <label>Original web address, if any<input type="url" value={f.sourceUrl} onChange={e => setF({ ...f, sourceUrl: e.target.value })} /></label>
        {!cfg.clientDataEnabled ? <p className="small muted">Institution documents are switched off on this deployment. Public sources only until the NDA and a data processing agreement are in place.</p> : null}
        {!cfg.ocr.available ? <p className="small muted">Scanned files cannot be read: no OCR engine is installed on this deployment.</p> : null}
        {err ? <div className="note err" role="alert">{err}</div> : null}{msg ? <div className="note ok" role="status">{msg}</div> : null}
        <button className="primary" disabled={busy}>{busy ? "Uploading…" : "Upload"}</button>
        <span className="small muted">The rights you state are recorded as declared by you. TIGERIS does not verify them, so the evidence is marked “warned” until someone confirms the licence.</span>
      </form>
    </Card>
  );
}

export function DocumentDetail({ id, can }: { id: string; can: (p: string) => boolean }): ReactNode {
  const d = useApi<DocDetail>(`/v1/documents/${id}`);
  const active = d.data && (d.data.status === "queued" || d.data.status === "processing");
  useEffect(() => { if (!active) return; const t = setInterval(d.reload, 2500); return () => clearInterval(t); }, [active, d.reload]);
  const [page, setPage] = useState(1);
  const pg = useApi<{ page_no: number; method: string; text: string; confidence: number | null }>(d.data && d.data.pages.length ? `/v1/documents/${id}/pages/${page}` : null);
  const retry = async () => { await api(`/v1/documents/${id}/retry`, { method: "POST", body: {} }); d.reload(); };
  return (
    <>
      <PageHead title="Document" aside={<a className="btn" href="#/documents">All documents</a>}>Stored unchanged and hashed. The page record shows exactly how each page of text was obtained.</PageHead>
      <Async state={d}>{x => (
        <div className="grid">
          <Card title={x.title} aside={<span className="row"><DocState v={x.status} /><DataClass value={x.data_class} /></span>}>
            {x.error ? <div className="note err" role="alert">{x.error}{can("document.upload") ? <> <button className="link" onClick={() => void retry()}>Try again</button></> : null}</div> : null}
            {x.scan_status === "infected" ? <div className="note err" role="alert">The malware scanner flagged this file ({x.scan_signature}). It was not opened, its contents were not kept, and it cannot be downloaded. Nothing in the system can release it.</div> : null}
            {x.scan_status === "pending" || x.scan_status === "error" ? <div className="note" role="status">Waiting for a malware scan{x.scan_error ? `: ${x.scan_error}` : ""}. The file stays unopened until a scan passes.</div> : null}
            {x.status === "quarantined" && x.scan_status !== "infected" ? <div className="note err" role="alert">This document failed validation and is held out of every calculation. Open its evidence record to see why.</div> : null}
            <dl className="prov">
              <div><dt>File</dt><dd>{x.filename}</dd><dd className="muted">{x.mime} · {kb(x.size_bytes)}</dd><dd className="mono muted">sha256 {x.sha256.slice(0, 20)}…</dd></div>
              <div><dt>Origin</dt><dd>{x.original_agency ?? "Not stated"}</dd><dd>{x.source_url ? <a href={x.source_url} target="_blank" rel="noreferrer noopener">Original source</a> : "No web address"}</dd><dd className="muted">Added by {x.uploaded_by_name ?? "—"} · {dateTime(x.created_at)}</dd></div>
              <div><dt>Rights, as declared</dt><dd dir="auto">{x.rights_statement}</dd><dd><span className="badge b-warn">Not verified by TIGERIS</span></dd></div>
              <div><dt>Content</dt><dd>{x.page_count ?? "—"} page(s)</dd><dd>Language: {x.language ? LANGS[x.language] : "—"}</dd><dd>{x.ocr_used ? "Some or all text from OCR" : x.status === "ready" ? "No OCR used" : ""}</dd></div>
              <div><dt>Malware scan</dt><dd>{({ clean: "Clean", infected: "Flagged", pending: "Waiting", error: "Waiting (scanner did not answer)", not_scanned: "Not scanned" } as const)[x.scan_status]}</dd><dd className="muted">{x.scan_engine ?? ""}</dd></div>
              <div><dt>Evidence</dt><dd>{x.evidence_id ? <><a href={`#/evidence/${x.evidence_id}`}>Open the evidence record</a><div className="small muted">Provenance, validation and case attachment work as for any evidence.</div></> : "Created when reading finishes"}</dd></div>
              <div><dt>Original</dt><dd>{(x.scan_status === "clean" || x.scan_status === "not_scanned") && (x.status === "ready" || x.status === "quarantined") ? <DownloadLink id={x.id} name={x.filename} /> : "—"}</dd><dd className="small muted">Each download is recorded in the audit trail.</dd></div>
            </dl>
          </Card>
          {x.pages.length ? (
            <div className="grid g2">
              <Card title="How each page was read">
                <Table label="Pages"><thead><tr><th className="num">Page</th><th>Method</th><th className="num">Characters</th><th className="num">OCR confidence</th></tr></thead>
                  <tbody>{x.pages.map(p => <tr key={p.page_no}><td className="num"><button className="link" onClick={() => setPage(p.page_no)} aria-current={p.page_no === page}>{p.page_no}</button></td><td>{METHOD[p.method] ?? p.method}</td><td className="num">{num(p.char_count, 0)}</td><td className="num">{p.confidence !== null ? `${num(p.confidence, 0)}%` : "—"}</td></tr>)}</tbody></Table>
                {x.ocr_used ? <p className="small muted" style={{ marginTop: 10 }}>OCR can misread characters, especially in low-quality scans. Check anything important against the original.</p> : null}
              </Card>
              <Card title={`Page ${page}`} aside={pg.data ? <span className="badge b-plain">{METHOD[pg.data.method] ?? pg.data.method}</span> : null}>
                <Async state={pg}>{p => p.text ? <div dir="auto" style={{ whiteSpace: "pre-wrap", maxHeight: 460, overflow: "auto", lineHeight: 1.6 }} tabIndex={0} aria-label={`Text of page ${page}`}>{p.text}</div> : <div className="empty">No text was found on this page.</div>}</Async>
              </Card>
            </div>
          ) : null}
          <p className="small muted">Read with {x.tools.pdftotext ?? "no PDF reader"} and {x.tools.tesseract ?? "no OCR engine"}.</p>
        </div>
      )}</Async>
    </>
  );
}

/** The file route needs the bearer token, so the download goes through fetch and a temporary link. */
function DownloadLink({ id, name }: { id: string; name: string }): ReactNode {
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try {
      const { downloadBlob } = await import("../download");
      const url = URL.createObjectURL(await downloadBlob(`/v1/documents/${id}/file`));
      const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Download failed."); } finally { setBusy(false); }
  }
  return <><button className="link" disabled={busy} onClick={() => void go()}>Download the original</button>{err ? <span className="small" role="alert"> {err}</span> : null}</>;
}
