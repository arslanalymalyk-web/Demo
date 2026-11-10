import type { ModelAdapter } from "./adapters.js";

/** A local model that only rearranges the facts it is given. It needs no key and no network, so the whole pipeline can run offline.
 *  It writes nothing of its own: every item is a stored fact quoted as is. */
export function extractiveAdapter(): ModelAdapter {
  return {
    provider: "local_extractive", model: "extractive/1",
    async complete(r) {
      const req = JSON.parse(r.user) as { task: string; question?: string; facts: { ref: string; text: string }[] };
      const facts = req.facts;
      const reply = (o: unknown) => ({ text: JSON.stringify(o), inputTokens: null, outputTokens: null });
      if (req.task === "answer") {
        const terms = (req.question ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
        const hit = facts.filter(f => terms.some(t => f.text.toLowerCase().includes(t))).slice(0, 5);
        return hit.length ? reply({ items: hit.map(f => ({ text: f.text, cites: [f.ref] })) }) : reply({ refusal: "The stored facts do not address this question.", items: [] });
      }
      if (req.task === "questions_case") return reply({ items: facts.slice(0, 5).flatMap((f, i) => [{ text: `What explains this: ${f.text}?`, cites: [f.ref], type: "question" }, ...(i === 0 ? [{ text: `Is there a second independent record that confirms this: ${f.text}?`, cites: [f.ref], type: "missing_evidence" }] : [])]) });
      if (req.task === "recommendation_case") return reply({ title: "Review the flagged evidence", items: facts.slice(0, 4).map(f => ({ text: f.text, cites: [f.ref] })) });
      return reply({ items: facts.slice(0, 8).map(f => ({ text: f.text, cites: [f.ref] })) });
    },
  };
}
