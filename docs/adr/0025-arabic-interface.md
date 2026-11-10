# 0025 Arabic interface

Status: accepted. Decisions: wording rules; figures read exactly as stored; no model writes any sentence.

## Context
The audience is in the Gulf. The interface was English only, with a right-to-left layout switch but no Arabic text.

## Decision
1. **English text is the key** (`t("...")`), with one Arabic dictionary. A missing entry shows English, never a blank. A test fails if a marked message has no Arabic, a placeholder changed, or an entry is unused.
2. **Numbers keep Western digits and stored units** in both languages, so figures match the stored records, the exports and the English screens. Dates use Arabic month names.
3. **Language sets direction.** Choosing Arabic sets `lang="ar"` and right-to-left; the layout switch still works on its own. Charts keep a left-to-right time axis.
4. **Computed sentences stay English** in this release (signals, headline, caveats, Assistant drafts). They are composed by fixed server code; translating them means composing them from structured values in each language without changing a figure. They are shown as English text with their own direction.
5. **Staged coverage.** The shell, shared components and the executive screens are translated first; every screen is laid out right to left and tested in Arabic.
6. **A native reviewer approves the wording** before release; terms to confirm are listed in `docs/handover/I18N.md`.

## Consequences
Pages mix Arabic labels with English computed sentences until the server composes in both languages. Plural forms are avoided in templates. The dictionary is one file, easy to review and to change.
