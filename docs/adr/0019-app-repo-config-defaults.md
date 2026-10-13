# ADR-0019: The App fills a repo config's missing provider and model from the dashboard

- Status: Accepted
- Date: 2026-10-13
- Amends: ADR-0016 (repo pricing)

## Context

The SaaS App picks every bot's provider and model from the dashboard (`effectiveConfigFor`), so a
repo `.mergepilot.yml` written for it often leaves both out. The App parsed the file with the
Action's rules, where `provider` is required: on lolotam/eyadex#73 all five bots of the reviewer
panel failed with `Invalid .mergepilot.yml: provider: required` before any model call.

## Decision

- `parseConfig(text, { defaults })` fills `provider` and `model`, each on its own, only when the
  file leaves the key out. It never replaces a value the file names and never hides another
  error. The result lists the filled keys in `defaulted`.
- The App passes the dashboard's choice (slot 1's) as `defaults`. Each bot still runs on its own
  dashboard provider and model, which `effectiveConfigFor` sets as before.
- The GitHub Action passes no defaults: `provider` stays required there.
- Repo `budget.pricing` (ADR-0016) applies only when the file itself names the same provider and
  model. A filled key never makes the repo price apply to a dashboard model.
- Any other invalid key still fails the review with the key path in the message.

## Consequences

A repo file for the App can hold only its review rules, language and budget. Files that name a
provider (for the Action) keep working in the App, as before.
