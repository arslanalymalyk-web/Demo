import nodemailer from "nodemailer";

export interface Mail { to: string; subject: string; text: string; category: string }
export interface Mailer { transport: "smtp" | "log"; send(m: Mail): Promise<{ messageId: string }>; verify(): Promise<void> }
/** What went wrong, in words that never repeat a server reply, an address or a credential. */
export class MailError extends Error { constructor(message: string, readonly transient: boolean) { super(message); } }

export interface SmtpConfig { transport: "smtp" | "log"; host: string; port: number; security: "starttls" | "tls" | "none"; user?: string | null; password?: string | null; from: string; production: boolean; timeoutMs?: number }

function explain(e: unknown): MailError {
  const x = e as { code?: string; responseCode?: number };
  if (x?.code === "EAUTH") return new MailError("the mail relay refused the credentials", false);
  if (typeof x?.responseCode === "number") return x.responseCode >= 500 ? new MailError(`the mail relay rejected the message (code ${x.responseCode})`, false) : new MailError(`the mail relay asked to try again later (code ${x.responseCode})`, true);
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNREFUSED", "EDNS", "ECONNRESET"].includes(x?.code ?? "")) return new MailError("the mail relay could not be reached", true);
  if (x?.code === "EENVELOPE" || x?.code === "EMESSAGE") return new MailError("the message was not accepted", false);
  return new MailError("the message could not be sent", true);
}

/** Plain text only, one recipient per message, no attachments and no tracking. TLS to the relay is verified; there is no switch that turns that off. */
export function createMailer(cfg: SmtpConfig): Mailer {
  if (cfg.production && (cfg.transport !== "smtp" || cfg.security === "none")) throw new MailError("production needs a real mail relay over TLS", false);
  const t = cfg.transport === "log"
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.security === "tls", requireTLS: cfg.security === "starttls", ignoreTLS: cfg.security === "none",
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.password ?? "" } } : {}), connectionTimeout: cfg.timeoutMs ?? 10_000, greetingTimeout: cfg.timeoutMs ?? 10_000, socketTimeout: cfg.timeoutMs ?? 20_000,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
  return {
    transport: cfg.transport,
    async send(m) {
      if (/[\r\n]/.test(m.to) || /[\r\n]/.test(m.subject)) throw new MailError("the message was not accepted", false);
      try { const r = await t.sendMail({ from: cfg.from, to: m.to, subject: m.subject, text: m.text, headers: { "X-TIGERIS-Category": m.category, "Auto-Submitted": "auto-generated" }, disableFileAccess: true, disableUrlAccess: true }); return { messageId: String(r.messageId ?? "") }; }
      catch (e) { throw explain(e); }
    },
    async verify() { if (cfg.transport === "log") return; try { await t.verify(); } catch (e) { throw explain(e); } },
  };
}
