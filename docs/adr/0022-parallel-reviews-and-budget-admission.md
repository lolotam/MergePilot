# ADR-0022: Eight reviews at once, with first-come budget admission

- Status: Accepted
- Date: 2026-10-13

## Context

With two worker slots, one slow model (about 20 minutes per review) held every other PR in the
queue. The owner asked for reviews to start at once. More parallel reviews make the monthly budget
check racy: every job read the same month spend before any of them recorded its cost.

## Decision

- The worker runs 8 review jobs at once by default (`DEFAULT_WORKER_CONCURRENCY`). `WORKER_CONCURRENCY`
  still overrides it and must be a whole number of at least 1; anything else stops startup. The
  worker's memory limit is 1 GB.
- The monthly-budget check goes through `BudgetAdmission`, one per worker process:
  - the check is serialized per workspace;
  - an admitted review holds its bots × the per-review budget until it finishes, and then releases it;
  - a review is admitted when the month spend plus what admitted reviews hold is below the budget;
  - admission is first come, first served, and queued reviews never count against another;
  - a review that is not admitted is skipped with `monthly budget reached`, as before.
- The reservations live in memory. A second worker process would admit on its own, so scaling
  out to several worker replicas needs a shared reservation (Postgres or Redis) first.
