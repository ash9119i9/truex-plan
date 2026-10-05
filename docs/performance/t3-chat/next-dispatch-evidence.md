# First-send and draft dispatch evidence

Baseline: `d6e3f45a45e6948873b8a64d0a9453fb2c2f4307`.
Runtime: Node 24.21.0, TypeScript 5.9.3, macOS arm64.
Scope: isolated actual page handlers and composer JSX, with deferred fake
creation/configuration/acceptance responses. No user API, runtime/provider,
database, browser credentials, or development server is contacted.

`frontend/test/composer-dispatch.test.ts` uses the TypeScript AST to extract the
production handlers and composer JSX and executes those exact functions in a
VM containing test-owned refs, state setters and APIs. The dispatch behavior is
not duplicated in a test implementation. Production revision/confirmation
helpers and the shared validator are loaded into the fixture. Changing the page
source through `TRUEX_DISPATCH_SOURCE` allows the same assertions to exercise the
baseline without modifying the working tree.

The same five regressions fail against baseline and pass against candidate:

- Chosen approval-mode failure must block first send and an existing-session retry.
- A 100,001-code-unit normal message must preserve text and make no creation/send
  request or optimistic row.
- Editor must remain enabled during catalog loading/failure and local creation;
  Send remains gated. Keyboard IME/229/Shift+Enter behavior remains intact.
- A successful goal must retain B typed while A waits for creation.
- A delayed suggestion must not replace B typed before its send starts.

Raw paired outputs: `next-dispatch-before.txt` (five failures) and
`next-dispatch-paired-after.txt` (five passes). The broader candidate run in
`next-dispatch-after.txt` passes all 28 page/approval-wrapper tests. The additional
checks cover one creation/send under duplicate submission, creating/sending/
steering transitions, restoration after definite pre-dispatch failure, uncertain
send receipt retention, successful same-session configuration recovery, goal and
capability paths, overlapping mode updates, navigation, UTF-16 boundary/payload
preservation, suggestion restoration and newer same-value draft ownership.
`next-dispatch-typecheck.txt` records a successful frontend type check.

Reproduce the paired comparison from the repository root:

```sh
git show d6e3f45a45e6948873b8a64d0a9453fb2c2f4307:frontend/app/page.tsx > /tmp/next-dispatch-page-before.tsx
TRUEX_DISPATCH_SOURCE=/tmp/next-dispatch-page-before.tsx node --experimental-strip-types --test --test-name-pattern='^(first message and retry|oversized normal message|editor stays usable|successful goal command|delayed suggestion never)' frontend/test/composer-dispatch.test.ts
node --experimental-strip-types --test --test-name-pattern='^(first message and retry|oversized normal message|editor stays usable|successful goal command|delayed suggestion never)' frontend/test/composer-dispatch.test.ts
node --experimental-strip-types --test frontend/test/composer-dispatch.test.ts frontend/test/approval-mode.test.ts
npm --prefix frontend run typecheck
```

Test-runner durations include parsing/transpilation and fixture setup; they are
not UI/provider latency measurements. This evidence establishes control flow,
request counts, ownership and rendered props, not React paint, p50/p95, Safari,
mobile geometry or real IME interaction. Browser verification remains separate.

Failure review: a creation failure can still represent an uncertain provisioning
outcome, so existing SessionPreparation failure retention/Recents recovery is
preserved. A transport send that might have been accepted retains an unknown row
and is never automatically retried. An approval failure keeps the requested mode
unconfirmed and retries it before later dispatch on the same session. Backend
confirmation remains authoritative across browser reloads and separate clients.
No data migration, new provisioning protocol, request queue, dependency or
prewarming was introduced. Rollback is the ordinary code rollback.
