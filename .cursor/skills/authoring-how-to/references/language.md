# Language patterns

Every rule here is derived from [`how-to/integrating-chargebee-webhooks.md`](../../../../how-to/integrating-chargebee-webhooks.md). When in doubt, open that file and match it.

## Contents

- [Who you are writing for](#who-you-are-writing-for)
- [Voice and person](#voice-and-person)
- [Sentence patterns that match the reference guide](#sentence-patterns-that-match-the-reference-guide)
- [Paragraphs versus lists](#paragraphs-versus-lists)
- [Emphasis and code formatting](#emphasis-and-code-formatting)
- [Linking](#linking)
- [Precision about distributed-systems behavior](#precision-about-distributed-systems-behavior)
- [Banned phrases](#banned-phrases)
- [Structural tells to avoid](#structural-tells-to-avoid)
- [Before and after](#before-and-after)

## Who you are writing for

An architect or senior developer who has decided to integrate Chargebee and now has to design something that survives production. They know what a queue is. They do not know how Chargebee behaves at the edges. Write for that gap.

Do not explain general computer science. Link to it. The reference guide links "dead letter queue" to Wikipedia rather than spending a paragraph defining it.

## Voice and person

Use **you** for guidance aimed at the reader:

> Since webhook events can be delivered out of order, store and compare the `resource_version` returned in the webhook `content`.

Name the **component** when describing runtime behavior, not "you":

> The worker treats "dependency not ready" as a *retryable* error: it does not acknowledge the message, so the queue redelivers it after a delay.

Use the imperative for instructions. `Store the event before returning 2xx.` Not `It is important to ensure that the event is stored.`

Write in present tense and active voice. `Chargebee retries the webhook`, not `the webhook will be retried by Chargebee`.

Never use "we" or "one". Never address a team. Never invent a scenario involving a fictional company.

## Sentence patterns that match the reference guide

**Lead with the action, then the reason.** The recommendation comes first; the justification follows in the same sentence or the next one.

> Store the event payload in a **durable queue** or database with the event `id` as the unique identifier. This ensures events are not lost, and duplicate events can be ignored.

**State the mechanism, not the vibe.** Prefer a sentence that a reader could implement from.

> On each unacknowledged delivery the message becomes available again after a *backoff delay*, and its delivery/receive count is incremented.

**Name the failure case directly.** The reference guide writes `The classic case:` and then describes an actual event pair.

> The classic case: a `payment_succeeded` (or `subscription_created`) arrives and references a customer whose `customer_created` event **hasn't been processed yet**.

**Use short sentences for constraints.** One clause, one rule.

> Don't drop the event. The dependency will likely arrive moments later.

**Keep transitions specific.** Tie the transition to the thing that just happened: `Once the event is durable, the endpoint can return 2xx.` Never open a sentence with `Additionally`, `Furthermore`, `Moreover`, or `It is worth noting that`.

**Qualify honestly.** The reference guide writes `Most of the time events arrive in roughly the order they occurred` and `Out-of-order gaps are usually seconds`. Hedge where reality hedges; do not hedge to sound cautious.

## Paragraphs versus lists

Reasoning goes in paragraphs. Parallel items go in lists. A list of three items that are not actually parallel should have been a paragraph. Number a list only when the order is part of the instruction.

Delete any sentence that can be removed without losing meaning.

Top-level bullets in `Best Practices` carry real weight — often two or three sentences. Nested bullets carry the mechanics of the parent bullet, such as the ordered steps a handler performs. That nesting is how the reference guide handles the synchronous webhook path, and it works because the sub-bullets are genuinely a sequence.

Contractions are fine where they read naturally (`doesn't redeliver it`, `hasn't been processed yet`). Do not force them.

## Emphasis and code formatting

Bold a term the first time you introduce it as a concept, then drop the bold: **durable queue**, **idempotent operations**, **at-least-once**. Bold a rule that a reader must not miss: **Don't drop the event.**

Do not bold a two-word label at the front of every bullet. The reference guide does it in one place — the retry-semantics subsection, where `Retry with backoff` and `Retention` are genuine named concepts being contrasted. Mechanical bolding across a whole list is the single clearest sign that a model wrote the page.

Use backticks for event types (`payment_succeeded`), field paths (`content.subscription.resource_version`), HTTP status families (`5xx`), config keys (`maxReceiveCount`), commands, and file paths. Write HTTP statuses as the reference guide does: `HTTP 2xx`, `HTTP 5xx`.

Use italics sparingly, for a word being used in a precise technical sense: a *retryable* error, a *backoff delay*.

No emoji. No decorative horizontal rules.

## Linking

- Repository files use relative links with the path as the link text: `` [`pointer/lib/webhooks.ts`](../pointer/lib/webhooks.ts) ``.
- Chargebee behavior links to the specific page and anchor that proves it, such as the event object's out-of-order delivery section.
- Standard concepts link out rather than being re-explained.
- Link text describes the destination. Never `click here` or a bare URL.

## Precision about distributed-systems behavior

These guides live or die on this section.

- Name the delivery semantics: at-least-once, at-most-once. Do not claim exactly-once unless the whole design proves it.
- Separate **durable acceptance** from **successful processing**. The endpoint accepting an event is not the same as the work being done.
- Say who retries, what is acknowledged, when, and where a message goes when it runs out of attempts.
- Distinguish a transient failure worth retrying patiently from a permanently broken payload that should fail fast.
- Give concrete numbers when the implementation has them, and label them as the implementation's settings: `maxReceiveCount = 5`, `Main queue retention is 4 days; DLQ retention is 14 days`.
- Say which side is authoritative for each piece of state and how local state gets reconciled when it drifts.

## Banned phrases

The validator flags these. They are the vocabulary of generated marketing prose, and none of them survive in a technical guide.

`seamless`, `seamlessly`, `robust`, `powerful`, `comprehensive`, `leverage` (use "use"), `utilize` (use "use"), `facilitate`, `delve`, `dive into`, `unpack`, `unlock`, `supercharge`, `elevate`, `empower`, `streamline`, `holistic`, `synergy`, `myriad`, `plethora`, `underscore(s)`, `paramount`, `harness` (as a verb), `foster`, `embark`, `bespoke`, `meticulous(ly)`, `boasts`, `game-changer`, `cutting-edge`, `best-in-class`, `state-of-the-art`, `world-class`, `tapestry`, `realm`, `landscape`, `testament to`, `navigate the complexities`, `in today's fast-paced`, `in the world of`, `when it comes to`, `ever-evolving`, `it is worth noting`, `it's worth noting`, `it is important to note`, `keep in mind that`, `needless to say`, `at the end of the day`, `in conclusion`, `in summary`, `to sum up`, `this guide will explore`, `this article will`, `let's dive in`, `we'll explore`, `crucial`, `vital role`, `pivotal role`, `key takeaway`, `rest assured`, `look no further`, `and more!`, `Certainly!`, `Great question`.

Also cut vague intensifiers — `very`, `really`, `extremely`, `incredibly`. If a thing is slow, say how slow.

Three notes on judgement:

- `crucial`, `robust`, `powerful`, and `comprehensive` are banned as adjectives of praise. If a word has a precise technical meaning in context, rewrite to say the precise thing instead of arguing for the adjective.
- `enable` and `explore` are fine in their literal senses (enable a setting, explore the API reference) and banned as filler.
- Em dashes are fine, and the reference guide uses them for exactly the kind of aside they exist for. Do not ban punctuation to sound human, and do not lean on them either.

## Structural tells to avoid

- **No document meta-commentary.** No "This guide covers", no "In this section we will", no restating the heading in the first sentence beneath it.
- **No rhetorical questions in prose.** The go-live checklist is the one place a question belongs. Replace "So what happens when the customer doesn't exist yet?" with the answer.
- **No closing summary.** The reference guide ends on the last checklist item. Yours does too.
- **No rule of three everywhere.** If there are four practices, list four. If there are two, list two.
- **No symmetrical padding.** Do not add a sentence to a bullet just because the bullet above it is longer.
- **No hedged non-recommendations.** "Consider whether you might want to potentially validate" is not guidance. Pick a position and defend it.
- **No placeholder examples** where a real Chargebee name exists. Write `subscription_renewal_reminder`, not `some_event_type`.

## Before and after

| Rewrite this | To this |
| --- | --- |
| It is crucial to ensure that robust error handling is implemented. | If the handler throws before the event is stored, return `HTTP 5xx` so Chargebee redelivers it. |
| Additionally, it is worth noting that events may arrive out of order. | Chargebee delivers events with no ordering guarantee, so a `payment_succeeded` can arrive before the `customer_created` it depends on. |
| This guide will explore how to leverage Chargebee webhooks to build a seamless integration. | One of the first steps when integrating Chargebee is setting up webhooks. |
| **Idempotency:** Ensure idempotency. **Retries:** Ensure retries. **Monitoring:** Ensure monitoring. | Process every message as if it may arrive twice: key the audit table on the event `id` and let inserts fall through with `ON CONFLICT DO NOTHING`. |
| You might want to consider utilizing a durable queue. | Store the event in a durable queue. |
| This powerful feature enables seamless synchronization. | This keeps your app data in sync with your Chargebee site. |
| In conclusion, following these best practices will help you build a production-ready integration. | (delete it) |
