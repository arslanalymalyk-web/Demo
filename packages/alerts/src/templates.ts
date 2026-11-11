export type Category = "malware" | "source" | "review" | "operations";
export type Kind = "raised" | "reminder" | "resolved" | "test";
export const CATEGORIES: Category[] = ["malware", "source", "review", "operations"];
/** Security-relevant notices cannot be switched off by the person who receives them. */
export const MUTABLE: Category[] = ["source", "review"];

const TITLE: Record<Category, [string, string]> = {
  malware: ["A file was flagged by the malware scanner", "تم رصد ملف مشبوه بواسطة فاحص البرمجيات الخبيثة"],
  source: ["A data source needs attention", "يحتاج مصدر بيانات إلى انتباه"],
  review: ["A decision is waiting for you", "قرار بانتظارك"],
  operations: ["An operational check needs attention", "فحص تشغيلي يحتاج إلى انتباه"],
};
const SENTENCE: Record<Category, [string, string]> = {
  malware: ["An uploaded file was flagged and quarantined. It was not opened and its contents were not kept.", "رُصد ملف مرفوع وحُجر. لم يُفتح ولم يُحتفظ بمحتواه."],
  source: ["A scheduled data source is failing, paused or out of date.", "هناك مصدر بيانات مجدول متعثّر أو متوقف مؤقتاً أو متقادم."],
  review: ["A case has been submitted for your decision.", "قُدّمت حالة لتبتّ فيها."],
  operations: ["A system check needs an administrator: the audit trail, the malware scanner or the database log archive.", "فحص للنظام يحتاج إلى مسؤول: سلسلة التدقيق أو فاحص البرمجيات الخبيثة أو أرشيف سجل قاعدة البيانات."],
};
const PREFIX: Record<Kind, [string, string]> = { raised: ["", ""], reminder: ["Reminder: ", "تذكير: "], resolved: ["Resolved: ", "تمت المعالجة: "], test: ["Test: ", "اختبار: "] };

export interface Rendered { subject: string; text: string }
const REF = /^[A-Z0-9][A-Z0-9-]{0,39}$/;
const PATH = /^\/#\/[a-z0-9/-]{0,80}$/i;

/** The whole message, from fixed text. It names a category, may carry a reference code, and links to the application. It carries nothing from the stored records, no figures, and no names. */
export function render(o: { category: Category; kind: Kind; ref?: string | null; link?: string | null; baseUrl: string }): Rendered {
  const [te, ta] = TITLE[o.category], [se, sa] = SENTENCE[o.category], [pe, pa] = PREFIX[o.kind];
  if (o.ref && !REF.test(o.ref)) throw new Error("the reference is not a plain code");
  if (o.link && !PATH.test(o.link)) throw new Error("the link is not an application path");
  const base = o.baseUrl.replace(/\/+$/, "");
  const url = `${base}${o.link ?? "/"}`;
  const resolved = o.kind === "resolved";
  const en = [`${pe}${te}`, "", resolved ? "The condition has cleared." : o.kind === "test" ? "This is a test message from TIGERIS. Nothing needs doing." : se, "", `Open TIGERIS: ${url}`, ...(o.ref ? [`Reference: ${o.ref}`] : [])];
  const ar = [`${pa}${ta}`, "", resolved ? "زالت الحالة." : o.kind === "test" ? "هذه رسالة اختبار من TIGERIS. لا يلزم أي إجراء." : sa, "", `افتح TIGERIS: ${url}`, ...(o.ref ? [`المرجع: ${o.ref}`] : [])];
  const footer = ["This message contains no data from the stored records. Sign in to see details.", "هذه الرسالة لا تتضمن أي بيانات من السجلات المخزَّنة. سجّل الدخول لعرض التفاصيل."];
  return { subject: `[TIGERIS] ${pe}${te}`, text: [...en, "", footer[0], "", "—", "", ...ar, "", footer[1], ""].join("\n") };
}
