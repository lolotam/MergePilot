# Review event correlation

Structured webhook and worker logs share `jobId`, `repo`, `pullNumber` and the full `headSha` when those values are known. Webhook logs retain `deliveryId` and the legacy `pr` field. Command webhooks have no head until the worker resolves the pull request. A missing or malformed payload SHA is null, not an inferred head.

Use `runId` and `botSlot` to identify the actual bot run. `panel.start.bots` describes configuration, not proof that those bots ran. Terminal and skipped run events carry run identity where a run exists; admission refusals can have no run ID.

Consensus `panel.publish.publicationStatus` reports the publisher outcome or `not-attempted`; its run ID identifies the publication holder. Separate-mode `panel.publish.runs` reports participating run statuses, not proof that all reviews were published successfully. Missing events remain unknown. Existing timestamps and duration fields do not establish queue latency or a complete per-stage timeline.

This correlation complements the attempt-scoped dashboard progress in ADR-0054. It changes neither review scheduling nor retries, models, budgets, storage or publication decisions. It does not provide a new notification channel, a complete operator timeline, or proof that a particular absent public review was never queued. Diagnose those states using authorized service/run/queue evidence before considering replay.
