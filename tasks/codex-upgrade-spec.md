# Spec: Repeatable Codex upgrades

Status: proposed; no Codex update is authorized or performed by this document.

## Objective

Give maintainers one command to prepare and check a Codex upgrade, reusing the
existing source pin, build, protocol generator and checks. Keep the current
application checkout, compiled runtime and conversation storage unchanged while
evaluating the candidate. Upstream compatibility fixes may still require work.

## Existing flow and constraint

`codex.lock.json` selects source and binary paths. `scripts/codex.mjs` verifies
the checkout and optionally builds it. `scripts/protocol.mjs` regenerates types,
schemas and inventories from that binary. Agent Core relies on these generated
contracts and on runtime behavior. Updating source alone cannot establish
compatibility.

## Proposed command

```sh
npm run codex:upgrade -- --ref main
```

`--ref` accepts an upstream branch, tag or exact commit. Resolve it once to an
immutable commit and print the selected revision; `main` means upstream main,
not the latest release. The command prepares a separate upgrade checkout from
the application's committed HEAD, updates its pin, obtains that exact Codex
source, builds, regenerates and checks it. Report the candidate path and diff.
Report that uncommitted application changes were not evaluated. Do not merge,
deploy, restart services or activate the candidate automatically.

Reuse these repository commands in the candidate:

```sh
npm run install:all
npm run codex:setup
npm run protocol:gen
npm run codex:verify
npm run build
npm test
npm run format:check
npm run check:secrets
```

Install root development dependencies as well as the service dependencies.
Candidate tests use isolated runtime storage and must not load live credentials
or call paid providers implicitly. Report unavailable provider/integration checks
and skipped runtime tests as unverified; do not claim full compatibility.

## Project structure and code style

Add `scripts/codex-upgrade.mjs`, `scripts/codex-upgrade.test.mjs`, an npm script
and README instructions. Reuse current helpers where practical. No new package
or runtime architecture is needed. Follow the existing ESM and Node built-in
style, with argument arrays instead of shell interpolation:

```js
execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
```

## Testing strategy and acceptance criteria

Use Node's test runner with temporary local repositories and controlled command
fixtures; tests must not download or build upstream Codex.

- A valid ref resolves to one commit and all later steps use that commit.
- Invalid refs, option-like refs and extra arguments fail before candidate work.
- A second concurrent invocation cannot overwrite an existing candidate.
- Fetch, installation, build, generation and check failures return nonzero,
  identify the failed step and preserve diagnostics and the candidate for repair.
- Success reports old/new revisions, candidate location, checks and limitations.
- Failure and success leave the active pin, vendor source, binary, generated
  files, uncommitted work and conversation storage unchanged.
- A failed or skipped required runtime check cannot produce a compatibility pass.
- Review generated removals as well as additions; stale generated files must not
  conceal incompatible protocol changes.

## Boundaries and operational impact

- Always: preserve pin enforcement, use isolated storage, stop on failed checks,
  surface skipped checks, and make the candidate reviewable.
- Ask first: activating an upgrade, deploying, running paid-provider checks or
  migrating existing conversation storage beyond authorization in the session.
- Never: run this upgrade during implementation of the automation, alter the
  current vendor checkout, copy live runtime state into tests, weaken checks,
  auto-commit, auto-merge or auto-deploy.

Disk and build time increase while a candidate exists. Report its path for
explicit cleanup. No production impact occurs until a separately authorized
adoption. Keep the previous binary, pin, protocol artifacts and a storage backup
when adopting a candidate; rebuilding the old source alone cannot undo a runtime
storage migration. Deployment artifact creation remains the existing separate
`npm run codex:artifact` workflow.

## Open questions

None required for this proposal. The initial workflow uses an explicit ref so
maintainers choose release tags or main deliberately.
