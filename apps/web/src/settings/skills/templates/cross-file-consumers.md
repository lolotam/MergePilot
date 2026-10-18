# Cross-file consumers: an extra pass after the review

This skill adds one pass to your review. It does not replace or narrow it.

1. **First do the full core review** of every changed file, exactly as the rules above say, and keep every finding it gives you.
2. **Then run the cross-file pass below.** A change is often correct in its own file and wrong for the files that call it, read it, or must stay in step with it. Add what this pass finds to the findings of step 1.

## Cross-file pass

### 1. List the changed contracts

For each changed file, write down (for yourself, not in the answer) what other code can observe:

- exported functions and predicates (`isX`, `canY`, `xKnown`), their arguments, return values and thrown errors;
- types, schemas, enums, constants and allowed values;
- API routes: path, method, request and response shape, status and error codes;
- state that other code holds: locks, counters, in-flight flags, caches, open/closed UI state, and who sets and who releases them;
- database tables and columns, events, queue payloads, config keys, environment variables;
- user-visible strings and their dictionary keys; file formats, markers and cache keys.

### 2. Find the consumers and the mirrors in the other PR files

For each contract, search every other `PATCH`, `PR_CONTEXT` and `REPOSITORY_CONTEXT` block (the PR file list too) for:

- **consumers**: code that calls it, imports it, branches on its result, or renders it;
- **mirrors**: code that must agree with it: a second predicate on the same error, the other implementation of an interface, the other language's dictionary, the reader of what it writes.

| Changed side | Other side that must match |
|---|---|
| a predicate or classifier (`isRevoked`, `outcomeKnown`) | every other predicate that classifies the same input, and every branch that acts on either |
| a function that takes or releases a lock, counter or flag | every path that ends the operation: success, each error, cancel, close, unmount |
| API producer (route, contract schema) | API consumer (client, dashboard page, mock, test fixture) |
| SQL migration | ORM schema, store queries, in-memory store, seed data |
| writer (serialiser, exporter, marker writer) | reader (parser, importer, verifier, restore) |
| one implementation of an interface | its other implementations |
| English dictionary | Arabic dictionary, and the reverse |
| an enum or list of allowed values | every switch, validator and UI list that enumerates it |

### 3. Check each pair

- Names and casing, optional vs required, units, nullability, ordering, error and status codes.
- A new member was added everywhere the list is enumerated.
- **Two predicates on the same input still agree** for every input the change touches. When the PR widens one (a new status, a new code), check the other one with that same input.
- **Every path that ends an operation still releases what it took.** Follow each new or changed exit (an error branch that now closes a screen, an early return) to the code that releases the lock or resets the flag.

## Worked example (a real miss)

A PR changed `editAccessRevoked(error)` in `model/access.ts` so that a `FEATURE_DISABLED` error counts as revoked at **any** status, including `409`. The editor component, in another file, closes itself when `editAccessRevoked` is true.

In `api/use-edit.ts`, a second predicate `editOutcomeKnown(error)` decides whether the save hook calls `onRequestEnd()`, which lowers the form's `editsInFlight` counter. `editOutcomeKnown` still treats every `409` other than a stale revision as "outcome unknown", so for `409 FEATURE_DISABLED` the hook skips `onRequestEnd()`.

Together: the editor closes, the counter never comes down, and the form's save and new-visit buttons stay disabled until the page is reloaded. Each file looks right on its own.

How the pass finds it: step 1 lists `editAccessRevoked` (a predicate) and `editsInFlight` (a lock). Step 2 finds the second predicate on the same error, `editOutcomeKnown`, and the release call that depends on it. Step 3 feeds the new input (`409 FEATURE_DISABLED`) to both predicates: one says "revoked, close", the other says "unknown, keep the lock".

The finding goes on the changed line in `model/access.ts`, with evidence from both sides, for example `api/use-edit.ts:64: if (!editOutcomeKnown(error)) return;`. The body names the stuck counter and the fix: treat the revoked case as a known outcome, or release the lock when the editor closes for an access denial.

## Report

- Place the finding on the changed line whose contract the other side breaks, and quote the other side in `evidence` as `path:line: excerpt`.
- When the other side is not shown, report only at confidence 0.5–0.69 and name the file that would confirm it.
- One finding per root cause: when one change breaks three consumers, report it once and list them in the body.

## Do not

- Skip the core review to do this pass, or drop core findings because they are not cross-file.
- Report a consumer as broken when the same PR already updates it in another file. Read the other patches first.
- Report a mismatch with code that this PR deletes.
