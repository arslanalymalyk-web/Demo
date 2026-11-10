import { z } from "zod";

/** What a model may produce, and the checks that decide whether any of it is shown.
 *  A model never supplies a fact. Every item must name the stored facts it rests on, every number in it must already appear in those facts, and nothing that reads as advice is accepted unless the task is a recommendation draft. */
export type Task = "summary_briefing" | "summary_case" | "questions_case" | "answer" | "recommendation_case";
export interface Fact { ref: string; text: string; evidenceId: string | null; dataClass: string }
export interface Item { text: string; cites: string[]; type: "statement" | "question" | "missing_evidence" }
export interface Output { title: string | null; items: Item[]; description: string | null; evidenceIds: string[] }
export type Judged = { verdict: "accepted"; output: Output } | { verdict: "refused"; reasons: string[] } | { verdict: "rejected"; reasons: string[] };

const schema = z.object({
  title: z.string().max(160).optional(), refusal: z.string().max(400).optional(),
  items: z.array(z.object({ text: z.string().min(1).max(700), cites: z.array(z.string().max(12)).max(12), type: z.enum(["question", "missing_evidence"]).optional() })).max(12),
});

export const numbersIn = (s: string): number[] => (s.match(/(?<![\w.])\d[\d,]*(?:\.\d+)?/g) ?? []).map(t => Number(t.replace(/,/g, ""))).filter(Number.isFinite);
const WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion|trillion|dozen|half|double[ds]?|triple[ds]?|twice|thrice|halved)\b/gi;
const ADVICE = /\b(should|must|ought|recommend\w*|advis\w*|urge\w*|suggest\w*)\b/i;
const ADVICE_QUESTIONS = /\b(must|recommend\w*|advis\w*|urge\w*)\b/i;

function extractJson(raw: string): unknown {
  let t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object");
  t = t.slice(a, b + 1);
  return JSON.parse(t);
}

/** Why one piece of text is not acceptable, given the facts it cites. An empty list means it is. */
export function problemsWith(text: string, cites: string[], byRef: Map<string, Fact>, task: Task): string[] {
  const out: string[] = [];
  if (cites.length === 0) out.push("it cites no stored fact");
  const known = cites.filter(c => byRef.has(c));
  for (const c of cites) if (!byRef.has(c)) out.push(`it cites ${c}, which was not supplied`);
  const pool = known.map(c => byRef.get(c)!.text).join(" "), poolNums = new Set(numbersIn(pool));
  const body = text.replace(/\bF\d+\b/g, " ");
  for (const n of numbersIn(body)) if (!poolNums.has(n)) out.push(`the number ${n} does not appear in the facts it cites`);
  const poolWords = new Set((pool.match(WORDS) ?? []).map(w => w.toLowerCase()));
  for (const w of body.match(WORDS) ?? []) if (!poolWords.has(w.toLowerCase())) out.push(`the word "${w}" states a quantity the cited facts do not`);
  if (/https?:\/\/|www\.|[<>]/i.test(body)) out.push("it contains a link or markup");
  if (task !== "recommendation_case" && (task === "questions_case" ? ADVICE_QUESTIONS : ADVICE).test(body)) out.push("it reads as advice, which this task may not give");
  return [...new Set(out)];
}

export function judge(task: Task, raw: string, facts: Fact[]): Judged {
  let parsed: z.infer<typeof schema>;
  try { parsed = schema.parse(extractJson(raw)); } catch { return { verdict: "rejected", reasons: ["the reply was not in the required form"] }; }
  if (parsed.refusal && parsed.items.length === 0) return task === "answer" ? { verdict: "refused", reasons: [parsed.refusal] } : { verdict: "rejected", reasons: ["the model declined this task"] };
  if (parsed.items.length === 0) return { verdict: "rejected", reasons: ["the reply had no items"] };
  const byRef = new Map(facts.map(f => [f.ref, f])), reasons: string[] = [];
  const items: Item[] = parsed.items.map((i, n) => {
    const cites = [...new Set(i.cites)], type: Item["type"] = i.type ?? "statement";
    for (const p of problemsWith(i.text, cites, byRef, task)) reasons.push(`item ${n + 1}: ${p}`);
    if (task === "questions_case" && type === "statement") reasons.push(`item ${n + 1}: it is neither a question nor a missing-evidence note`);
    return { text: i.text.trim(), cites, type };
  });
  let title: string | null = null;
  if (task === "recommendation_case") {
    if (!parsed.title?.trim()) reasons.push("the draft has no title");
    else if (/\d/.test(parsed.title) || TITLE_MARKUP.test(parsed.title)) reasons.push("the title carries a number or markup");
    else title = parsed.title.trim();
  }
  if (reasons.length) return { verdict: "rejected", reasons };
  const evidenceIds = [...new Set(items.flatMap(i => i.cites).map(c => byRef.get(c)!.evidenceId).filter((x): x is string => x !== null))];
  return { verdict: "accepted", output: { title, items, description: task === "recommendation_case" ? items.map(i => i.text).join(" ") : null, evidenceIds } };
}
const TITLE_MARKUP = /https?:\/\/|[<>]/i;
