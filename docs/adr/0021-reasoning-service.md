# 0021 Reasoning service

Status: accepted. Decisions: models never compute or write facts; human-authorized; public data only until the client's review (decision 11).

## Context
Analysts want plain-language summaries, suggested questions, answers over stored evidence and draft recommendations. Models can write fluent text but cannot be trusted with figures.

## Decision
1. **A model drafts, code verifies, a person decides.** The model receives a numbered list of stored facts and returns JSON items that cite fact refs. Verification is code (`packages/reasoning/src/verify.ts`): every cite must exist, every number in an item must appear in the facts it cites, quantities in words and advice language are refused (a recommendation draft may advise), links and markup are refused. Any failure rejects the whole draft. Nothing partial is shown.
2. **Model-agnostic.** One adapter interface with three adapters: the Claude API, any OpenAI-compatible endpoint (including an on-premises model), and a local extractive adapter that quotes facts and needs no network. Provider is chosen by configuration; off by default.
3. **Data class gate.** Only `public_record`, `sample_dataset` and `scenario_simulation` facts are sent. Institution data, third-party derived data and licensed feeds are withheld. Text people typed into cases is never sent. A switch for institution data is not built.
4. **Every call is recorded** in an immutable table (hashes of prompt and facts, model, raw reply, verdict, verified output) and writes an audit event in the same transaction as the record.
5. **Drafts are not records.** The model never writes to cases. A recommendation draft is text the person copies and files through the normal case flow and policy gate.
6. **Limits.** A per-person hourly limit, https required in production, no redirects, a timeout, no echo of provider response bodies or keys.

## Consequences
Verification proves that each number is quoted from a cited stored fact. It does not prove that the prose draws a sound conclusion; a person reads every draft. Number words are checked against a fixed list. Real provider endpoints have not been exercised in this build.
