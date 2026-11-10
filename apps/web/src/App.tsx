import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, setToken, setUnauthorizedHandler, type Me } from "./api";
import { completeLogin, startLogin } from "./auth";
import { NAV, parseRoute } from "./route";
import { usePrefs } from "./prefs";
import { lang, setLang, t, tx, type Lang } from "./i18n";
import { Home } from "./views/home";
import { Evidence, Sources, SeriesView } from "./views/data";
import { GraphView } from "./views/graph";
import { RunView, Scenarios } from "./views/scenarios";
import { Admin, Audit } from "./views/admin";
import { CaseList, CaseWorkspace } from "./views/cases";
import { Handoffs, Memory, Policy } from "./views/governance";
import { DocumentDetail, Documents } from "./views/documents";
import { SectorCentre } from "./views/sector";
import { BriefingView } from "./views/briefing";
import { Assistant } from "./views/reasoning";
import { SourceHealth } from "./views/sourcehealth";
import { Readiness } from "./views/readiness";
import { Settings } from "./views/settings";
import { MapView } from "./views/map";
import { Retention } from "./views/retention";

void [tx("executive"), tx("analyst"), tx("expert"), tx("approver"), tx("operations"), tx("administrator"), tx("auditor")];
type Phase = { name: "starting" } | { name: "signed-out"; error?: string } | { name: "denied"; message: string } | { name: "ready"; me: Me };

function SignIn({ error }: { error?: string }): ReactNode {
  return (
    <main className="signin" id="main">
      <div className="card panel">
        <h1>TIGERIS</h1>
        <p className="tag">{t("AI-native Sovereign Intelligence Operating System")}</p>
        {error ? <div className="note err" role="alert">{error}</div> : null}
        <button className="primary" onClick={() => void startLogin().catch(() => location.reload())}>{t("Sign in with your institution")}</button>
        <p className="small muted" style={{ marginTop: 18 }}>{t("Access is granted by your institution's identity provider and by the roles assigned to you here. Every action is recorded.")}</p>
      </div>
    </main>
  );
}

export default function App(): ReactNode {
  const prefs = usePrefs();
  const [language, setLanguage] = useState<Lang>(lang());
  const choose = (l: Lang) => { setLang(l); setLanguage(l); prefs.setDir(l === "ar" ? "rtl" : "ltr"); };
  useEffect(() => { document.documentElement.lang = lang(); }, []);
  const [phase, setPhase] = useState<Phase>({ name: "starting" });
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const f = () => setHash(location.hash); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = (error?: string) => { setToken(null); setPhase({ name: "signed-out", ...(error ? { error } : {}) }); };
    setUnauthorizedHandler(() => out(t("Your session ended. Sign in again.")));
    (async () => {
      try {
        const s = await completeLogin();
        if (!s) { out(); return; }
        setToken(s.token);
        timer = setTimeout(() => out(t("Your session expired. Sign in again.")), Math.max(0, s.expiresAt - Date.now() - 5000));
        setPhase({ name: "ready", me: await api<Me>("/v1/identity/me") });
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) { setPhase({ name: "denied", message: e.message }); return; }
        out(e instanceof Error ? e.message : t("Sign-in failed."));
      }
    })();
    return () => clearTimeout(timer);
  }, []);

  const route = useMemo(() => parseRoute(hash), [hash]);
  useEffect(() => { document.getElementById("main")?.focus({ preventScroll: true }); window.scrollTo(0, 0); }, [hash]);

  if (phase.name === "starting") return <div className="signin" role="status">{t("Signing in…")}</div>;
  if (phase.name === "signed-out") return <SignIn {...(phase.error ? { error: phase.error } : {})} />;
  if (phase.name === "denied") return <main className="signin" id="main"><div className="card panel"><h1>TIGERIS</h1><div className="note err" role="alert">{phase.message}</div><p>{t("Your identity is valid, but you have not been given access to this institution. Ask an administrator to add you.")}</p><button onClick={() => { setToken(null); setPhase({ name: "signed-out" }); }}>{t("Back")}</button></div></main>;

  const me = phase.me, can = (p: string) => me.permissions.includes(p);
  const allowed = (need: string | null) => need === null || can(need);
  const nav = NAV.filter(n => allowed(n.need));
  const matches = (n: (typeof NAV)[number]) => n.view.includes(route.view) && (!n.id || n.id === route.id);
  const current = NAV.find(matches);
  const blocked = current && !allowed(current.need);

  let body: ReactNode;
  if (blocked) body = <div className="note err" role="alert">{t("Your role does not include access to this area.")}</div>;
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
    case "briefing": body = <BriefingView pack={route.id as "energy" | "sovereign"} />; break;
    case "assistant": body = <Assistant can={can} />; break;
    case "sourcehealth": body = <SourceHealth can={can} />; break;
    case "readiness": body = <Readiness />; break;
    case "settings": body = <Settings me={me} can={can} />; break;
    case "map": body = <MapView can={can} />; break;
    case "retention": body = <Retention />; break;
    case "audit": body = <Audit />; break;
    case "admin": body = <Admin can={can} />; break;
    default: body = <div className="note">{t("That page does not exist.")} <a href="#/">{t("Back to the Command Centre")}</a>.</div>;
  }

  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={e => { e.preventDefault(); document.getElementById("main")?.focus(); }}>{t("Skip to content")}</a>
      <aside className="rail">
        <div className="brand">TIGERIS<small>{t("Sovereign Intelligence OS")}</small></div>
        <nav aria-label={t("Primary")}>{nav.map(n => <a key={n.href} href={n.href} {...(matches(n) ? { "aria-current": "page" as const } : {})}>{t(n.label)}</a>)}</nav>
        <div className="foot">{t("One deployment per institution. No cross-institution data.")}</div>
      </aside>
      <div className="main">
        <header className="top">
          <strong>{me.institution?.name ?? t("Institution")}</strong>
          <span className="badge b-plain" title={t("Classification of the data in view")}>{t("Public sources only")}</span>
          <span className="badge b-ok" title={t("All figures shown come from stored evidence")}>{t("Public record")}</span>
          <span className="grow" />
          <div className="seg" role="group" aria-label={t("Theme")}><button aria-pressed={prefs.theme === "ivory"} onClick={() => prefs.setTheme("ivory")}>{t("Ivory")}</button><button aria-pressed={prefs.theme === "navy"} onClick={() => prefs.setTheme("navy")}>{t("Navy")}</button></div>
          <div className="seg" role="group" aria-label={t("Layout direction")}><button aria-pressed={prefs.dir === "ltr"} onClick={() => prefs.setDir("ltr")}>LTR</button><button aria-pressed={prefs.dir === "rtl"} onClick={() => prefs.setDir("rtl")}>RTL</button></div>
          <div className="seg" role="group" aria-label={t("Language")}><button aria-pressed={language === "en"} lang="en" onClick={() => choose("en")}>English</button><button aria-pressed={language === "ar"} lang="ar" onClick={() => choose("ar")}>العربية</button></div>
          <button aria-pressed={prefs.motion === "reduced"} onClick={() => prefs.setMotion(prefs.motion === "reduced" ? "full" : "reduced")}>{prefs.motion === "reduced" ? t("Motion: reduced") : t("Motion: full")}</button>
          <span className="who">{me.displayName ?? me.subject} · {me.roles.map(r => t(r)).join("، ") || t("no role")}</span>
          <button onClick={() => { setToken(null); setPhase({ name: "signed-out" }); }}>{t("Sign out")}</button>
        </header>
        <main className="content" id="main" tabIndex={-1} key={hash}>{body}</main>
      </div>
    </div>
  );
}
