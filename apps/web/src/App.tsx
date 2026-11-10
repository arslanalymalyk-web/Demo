import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, setToken, setUnauthorizedHandler, type Me } from "./api";
import { completeLogin, startLogin } from "./auth";
import { NAV, parseRoute } from "./route";
import { usePrefs } from "./prefs";
import { Home } from "./views/home";
import { Evidence, Sources, SeriesView } from "./views/data";
import { GraphView } from "./views/graph";
import { RunView, Scenarios } from "./views/scenarios";
import { Admin, Audit } from "./views/admin";
import { CaseList, CaseWorkspace } from "./views/cases";
import { Handoffs, Memory, Policy } from "./views/governance";
import { DocumentDetail, Documents } from "./views/documents";
import { SectorCentre } from "./views/sector";
import { Settings } from "./views/settings";

type Phase = { name: "starting" } | { name: "signed-out"; error?: string } | { name: "denied"; message: string } | { name: "ready"; me: Me };

function SignIn({ error }: { error?: string }): ReactNode {
  return (
    <main className="signin" id="main">
      <div className="card panel">
        <h1>TIGERIS</h1>
        <p className="tag">AI-native Sovereign Intelligence Operating System</p>
        {error ? <div className="note err" role="alert">{error}</div> : null}
        <button className="primary" onClick={() => void startLogin().catch(() => location.reload())}>Sign in with your institution</button>
        <p className="small muted" style={{ marginTop: 18 }}>Access is granted by your institution's identity provider and by the roles assigned to you here. Every action is recorded.</p>
      </div>
    </main>
  );
}

export default function App(): ReactNode {
  const prefs = usePrefs();
  const [phase, setPhase] = useState<Phase>({ name: "starting" });
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const f = () => setHash(location.hash); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = (error?: string) => { setToken(null); setPhase({ name: "signed-out", ...(error ? { error } : {}) }); };
    setUnauthorizedHandler(() => out("Your session ended. Sign in again."));
    (async () => {
      try {
        const s = await completeLogin();
        if (!s) { out(); return; }
        setToken(s.token);
        timer = setTimeout(() => out("Your session expired. Sign in again."), Math.max(0, s.expiresAt - Date.now() - 5000));
        setPhase({ name: "ready", me: await api<Me>("/v1/identity/me") });
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) { setPhase({ name: "denied", message: e.message }); return; }
        out(e instanceof Error ? e.message : "Sign-in failed.");
      }
    })();
    return () => clearTimeout(timer);
  }, []);

  const route = useMemo(() => parseRoute(hash), [hash]);
  useEffect(() => { document.getElementById("main")?.focus({ preventScroll: true }); window.scrollTo(0, 0); }, [hash]);

  if (phase.name === "starting") return <div className="signin" role="status">Signing in…</div>;
  if (phase.name === "signed-out") return <SignIn {...(phase.error ? { error: phase.error } : {})} />;
  if (phase.name === "denied") return <main className="signin" id="main"><div className="card panel"><h1>TIGERIS</h1><div className="note err" role="alert">{phase.message}</div><p>Your identity is valid, but you have not been given access to this institution. Ask an administrator to add you.</p><button onClick={() => { setToken(null); setPhase({ name: "signed-out" }); }}>Back</button></div></main>;

  const me = phase.me, can = (p: string) => me.permissions.includes(p);
  const allowed = (need: string | null) => need === null || can(need);
  const nav = NAV.filter(n => allowed(n.need));
  const matches = (n: (typeof NAV)[number]) => n.view.includes(route.view) && (!n.id || n.id === route.id);
  const current = NAV.find(matches);
  const blocked = current && !allowed(current.need);

  let body: ReactNode;
  if (blocked) body = <div className="note err" role="alert">Your role does not include access to this area.</div>;
  else switch (route.view) {
    case "home": body = <Home can={can} />; break;
    case "sources": body = <Sources />; break;
    case "evidence": body = <Evidence id={route.id} />; break;
    case "series": body = <SeriesView seriesKey={route.id} />; break;
    case "graph": body = <GraphView />; break;
    case "scenarios": body = <Scenarios can={can} />; break;
    case "run": body = <RunView id={route.id!} />; break;
    case "cases": body = <CaseList can={can} />; break;
    case "case": body = <CaseWorkspace id={route.id!} me={me} />; break;
    case "handoffs": body = <Handoffs can={can} />; break;
    case "memory": body = <Memory />; break;
    case "policy": body = <Policy can={can} />; break;
    case "documents": body = <Documents can={can} />; break;
    case "document": body = <DocumentDetail id={route.id!} can={can} />; break;
    case "sector": body = <SectorCentre pack={route.id as "energy" | "sovereign"} me={me} can={can} />; break;
    case "settings": body = <Settings me={me} can={can} />; break;
    case "audit": body = <Audit />; break;
    case "admin": body = <Admin can={can} />; break;
    default: body = <div className="note">That page does not exist. <a href="#/">Back to the Command Centre</a>.</div>;
  }

  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={e => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <aside className="rail">
        <div className="brand">TIGERIS<small>Sovereign Intelligence OS</small></div>
        <nav aria-label="Primary">{nav.map(n => <a key={n.href} href={n.href} {...(matches(n) ? { "aria-current": "page" as const } : {})}>{n.label}</a>)}</nav>
        <div className="foot">One deployment per institution. No cross-institution data.</div>
      </aside>
      <div className="main">
        <header className="top">
          <strong>{me.institution?.name ?? "Institution"}</strong>
          <span className="badge b-plain" title="Classification of the data in view">Public sources only</span>
          <span className="badge b-ok" title="All figures shown come from stored evidence">Public record</span>
          <span className="grow" />
          <div className="seg" role="group" aria-label="Theme"><button aria-pressed={prefs.theme === "ivory"} onClick={() => prefs.setTheme("ivory")}>Ivory</button><button aria-pressed={prefs.theme === "navy"} onClick={() => prefs.setTheme("navy")}>Navy</button></div>
          <div className="seg" role="group" aria-label="Layout direction"><button aria-pressed={prefs.dir === "ltr"} onClick={() => prefs.setDir("ltr")}>LTR</button><button aria-pressed={prefs.dir === "rtl"} onClick={() => prefs.setDir("rtl")}>RTL</button></div>
          <button aria-pressed={prefs.motion === "reduced"} onClick={() => prefs.setMotion(prefs.motion === "reduced" ? "full" : "reduced")}>{prefs.motion === "reduced" ? "Motion: reduced" : "Motion: full"}</button>
          <span className="who">{me.displayName ?? me.subject} · {me.roles.join(", ") || "no role"}</span>
          <button onClick={() => { setToken(null); setPhase({ name: "signed-out" }); }}>Sign out</button>
        </header>
        <main className="content" id="main" tabIndex={-1} key={hash}>{body}</main>
      </div>
    </div>
  );
}
