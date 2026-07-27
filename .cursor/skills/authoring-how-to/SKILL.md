---
name: authoring-how-to
description: Authors and revises in-depth Chargebee integration how-to guides in the reference-architecture repository, following the structure, mermaid-only diagram rule, and writing voice of how-to/integrating-chargebee-webhooks.md. Use when adding or editing any file under how-to/, when asked to write or review a Chargebee how-to or reference-architecture guide, or when documenting a Chargebee integration topic such as webhooks, subscription lifecycle, checkout, invoices, payments, dunning, entitlements, usage metering, tax, or reconciliation.
---

# Authoring reference-architecture how-tos

The `how-to/` directory holds vetted, in-depth guides on integrating Chargebee into a high-traffic SaaS platform. Each guide gives an architect or developer a design they can build against, plus the operational detail needed to run it. `pointer/` is the working implementation those guides point at.

Read [`how-to/integrating-chargebee-webhooks.md`](../../../how-to/integrating-chargebee-webhooks.md) before writing. It is the structural and tonal reference. Match its shape and voice; do not copy its sentences or reproduce its typos.

## Four rules that override everything else

1. **Everything is code, including diagrams.** Every diagram is a fenced `mermaid` code block committed in the markdown. No images, no screenshots, no ASCII art, no links to Lucid, Miro, Excalidraw, or draw.io. If a design can't be drawn in mermaid, describe it in prose instead of reaching for a picture.
2. **Verify Chargebee behavior against the live docs.** Never write API names, field names, event types, limits, or product behavior from memory. See [references/chargebee-sources.md](references/chargebee-sources.md).
3. **Go deep.** These are not quickstarts. A guide that only documents the happy path has failed. Cover the failure modes, the ordering and idempotency and consistency concerns, and the trade-offs behind each recommendation.
4. **Write like the reference guide, not like a model.** The language rules in [references/language.md](references/language.md) are enforceable, not advisory. Run the validator before finishing.

## Workflow

1. **Fix the scope.** Name the outcome the reader wants and the boundary of the system covered. One guide, one outcome. If the topic is really two outcomes, propose splitting it.
2. **Research.** Pull the current behavior from Chargebee's docs and API reference, then read the relevant `pointer/` code. Follow [references/chargebee-sources.md](references/chargebee-sources.md). Note the exact URLs you relied on; they become the guide's outbound links.
3. **Map the design.** Before writing prose, work out: the synchronous path, what moves to asynchronous work, the system of record for each piece of state, every failure path, who retries and what gets acknowledged, and how state is reconciled when things drift.
4. **Draft.** Copy [assets/how-to-template.md](assets/how-to-template.md) to `how-to/<verb>-<topic>.md` and fill it in. Keep the section order.
5. **Draw the diagrams.** Follow [references/diagrams.md](references/diagrams.md) for the sequence and flowchart conventions used across the repo.
6. **Ground the implementation notes.** Open every `pointer/` file you cite and confirm it still does what you say. Label opinionated choices (SQS, Better Auth, Next.js, Postgres) as `pointer`'s choices, not Chargebee requirements.
7. **Validate.** Run the checker, fix every error, and for each warning either fix it or be able to say why it is a false positive.

    ```bash
    python3 .cursor/skills/author-ref-arch-how-to/scripts/check_how_to.py how-to/<your-file>.md
    ```

8. **Register the guide.** Add it to the numbered topic list in [`how-to/README.md`](../../../how-to/README.md).
9. **Self-review.** Walk the final checklist at the bottom of this file.

## Required structure

Keep this order. Drop a section only when the topic genuinely has nothing to put in it.

| Section | Heading | Contains |
| --- | --- | --- |
| Title | `# How to <outcome>` | The outcome, phrased as a task |
| Intro | (no heading) | Why this matters and what the reader will build, in 2–4 sentences, optionally followed by a short list of concrete reasons |
| Architecture | `## High level architecture` | One mermaid diagram covering happy path and the failure paths that matter |
| Guidance | `## Best Practices` | Recommendations organized by responsibility, with `###` subsections for the hard correctness topics |
| Code | `## Implementation notes` | How `pointer` does it, with links to specific files and what each one does |
| Launch | `## Go-live checklist` | `- [ ]` questions that can be answered yes or no before deploying |

`Best Practices` keeps its title-case capitalization to match the reference guide. Every other heading is sentence case.

### Intro

Open on the reader's situation, not on the document. The reference guide starts with `One of the first steps when integrating Chargebee using the SDK/API is to setup webhooks. You will need webhooks to:` and then lists three reasons. That is the pattern: a sentence that places the topic in a real integration sequence, then the concrete payoff.

### High level architecture

Lead with the diagram, then explain it in prose dense enough that a reader who skips the diagram still understands the design. Show where trust boundaries sit, where a hand-off becomes durable, what runs asynchronously, and what happens on error.

### Best Practices

Group by responsibility or design decision. For each recommendation, say what to do, why it matters, and what breaks if it is skipped. Where the topic involves retries, duplicates, ordering, concurrency, or partial failure, spell out the semantics rather than gesturing at them.

Promote a genuinely hard correctness problem into its own `###` subsection with its own mermaid sequence. The reference guide does this for out-of-order and dependent events, and that subsection is the most useful part of the document. Drop to `####` for a finer breakdown inside it, as the reference guide does for retry semantics.

### Implementation notes

Open with a short paragraph on how `pointer` wires the topic together, then a bulleted list of files. Each bullet is a link to the file followed by its role and the runtime behavior that matters, for example what acknowledges a message or what happens on a thrown error.

State trade-offs plainly when `pointer` diverges from the recommended production design.

### Go-live checklist

Write each item as a question with a testable answer:

```markdown
- [ ] Does the worker retry transient failures without acknowledging the message?
```

Cover configuration, authentication, correctness, failure recovery, observability, security, scale, reconciliation, and ownership as the topic warrants. Reject anything as soft as "Is the integration production-ready?".

## Reference files

- [references/language.md](references/language.md) — the voice, sentence patterns, formatting conventions, and the banned-phrase list. Read this before drafting prose.
- [references/diagrams.md](references/diagrams.md) — mermaid conventions: participant naming, `alt` blocks for failure paths, when to use `flowchart` over `sequenceDiagram`.
- [references/chargebee-sources.md](references/chargebee-sources.md) — which documentation site to trust for what, verified entry-point URLs, product-version traps, and the facts that must always be verified rather than recalled.
- [assets/how-to-template.md](assets/how-to-template.md) — the skeleton to copy into `how-to/`.
- [scripts/check_how_to.py](scripts/check_how_to.py) — structural and language validator. Run with `--strict` to make warnings fail too.

## Final checklist

- [ ] The title names a concrete outcome, not a subject area.
- [ ] The intro states the reader's problem in its first sentence and contains no meta-commentary about the document.
- [ ] Every diagram is mermaid, and the diagram and the prose describe the same system.
- [ ] Failure paths appear in the architecture diagram, not just in the prose.
- [ ] Each recommendation carries its rationale and its failure mode.
- [ ] Delivery and consistency semantics are stated precisely, and "exactly once" is not claimed unless the design proves it.
- [ ] Chargebee behavior, event types, and field names were checked against the live documentation, and the guide links to the pages a reader would use to verify them.
- [ ] `pointer`'s technology choices are labelled as choices.
- [ ] Every repository link resolves and every cited file still plays the stated role.
- [ ] Checklist items are answerable yes or no before launch.
- [ ] The draft has no filler transitions, no bolded label on every bullet, no closing summary, and nothing that reads like a template.
- [ ] `check_how_to.py` reports no errors.
