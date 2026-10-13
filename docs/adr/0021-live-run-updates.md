# ADR-0021: Live Run Updates — Redis Pub/Sub to Server-Sent Events

- **Status:** Accepted (2026-10-13).
- **Related to:** ADR-0007 (SaaS App, roles), ADR-0009 (run lifecycle), ADR-0014 (runs table),
  ADR-0017 (reviewer panel), docs/decisions.ar.md (batch 15, Q36)

## Context

The owner wants a new review to appear in the runs table the moment it starts, and its status to
change as it finishes, without refreshing the page. Today the table only polls every 5 s while a
run it already shows is queued or running, so a brand-new PR review never appears by itself.

The worker and the web server are separate processes. Redis already connects them (BullMQ). The
owner picked option 2, Server-Sent Events, over polling and WebSockets.

## Decision

1. **Event.** `{ workspaceId, runId, status, kind: 'created' | 'updated' }`. Only ids and the
   status: no repo name, head commit, detail text, findings or keys. The dashboard refetches its
   own lists; the event only says "something changed".
2. **Publishing.** `withRunEvents(store, publisher)` wraps the `AppStore`:
   - `createReviewRun` publishes `created`;
   - `finishReviewRun` publishes `updated` with the new status (completed, failed, skipped);
   - the stale sweep (`failStaleRuns`) publishes `updated`/`failed` for each run it fails. The
     store method gains an optional `onFailed` callback with the failed runs' ids, called after
     the commit;
   - the event goes out only after the store call succeeded;
   - heartbeats change no status and publish nothing.

   The worker wraps its store with it, so every create and finish site (single bot, reviewer
   panel, pause, duplicate, budget) is covered without touching them. The web server wraps its
   store too, so a run created by a retry reaches other members' tables.
3. **Transport.** Redis pub/sub, one channel per workspace: `mergepilot:runs:<workspaceId>`.
   - The bus uses its own ioredis connections, one to publish and one to subscribe, apart from the
     BullMQ connection. The subscriber opens on the first stream, so the worker never opens one.
   - One subscriber connection per web process carries every stream. A channel is subscribed while
     at least one stream listens to it.
   - A message whose workspace differs from its channel's, or that is malformed, is dropped.
   - Publishing is fire-and-forget: a Redis error is reported by name only and never fails a
     review. A lost event only delays the update until the next refetch.
   - With a `memory:` Redis URL (tests, local dev) an in-process `EventEmitter` bus with the same
     interface is used.
4. **Stream.** `GET /api/workspaces/:workspaceId/runs/events`, `text/event-stream`.
   - Same guard as the runs list (`requireRole('member')`): 401 without a session, 403 for a
     non-member. Any member who can list runs can listen.
   - Each change is a `run` event with `{ runId, status, kind }`. A `: keep-alive` comment goes
     out every 25 s, and `retry: 5000` tells the browser how soon to reconnect.
   - Headers: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`,
     `Connection: keep-alive`; the security headers already set on the reply are kept. Traefik
     passes the stream through.
   - Limits: 5 open streams per user and 500 per web process; above them the route answers 429
     `too_many_streams`. Closing the browser tab releases the slot and the subscription.
   - On shutdown (`preClose`) every open stream is ended, so the server never waits for them.
   - Without a bus the route answers 503 `live_updates_unavailable`.
5. **Dashboard.** `useRunsLive(workspaceId, { runId? })` while the runs page or a run detail page
   is mounted:
   - opens an `EventSource`;
   - on events, invalidates `['workspaces', id, 'runs']` (the detail page: only its run's key, and
     only for its run's events), once per 300 ms burst. Rows are never patched by hand;
   - the browser reconnects by itself. If the stream stays down for more than 30 s, the queries
     are refetched every 30 s until it is back, then once more to catch up. A source the browser
     gave up on (e.g. a 429 or 503 answer) is reopened every 30 s;
   - a small «Live / مباشر» indicator shows the state: live, connecting, or updating every 30 s;
   - a browser without `EventSource` opens nothing and shows no indicator; the page keeps its usual
     refetching.

## Consequences

- New and finished reviews appear in the table within about a second, with no page refresh.
- The existing 5 s poll while a shown run is queued or running stays: it keeps the live duration
  timer exact.
- Events carry no repo data, so even a subscription bug could leak only run ids and statuses, and
  the route checks membership before subscribing.
- Each open dashboard tab holds one HTTP connection to the web server. The per-user and global
  limits bound that; a user past the limit falls back to polling.
- Events are not stored: a client that reconnects refetches instead of replaying missed events.
