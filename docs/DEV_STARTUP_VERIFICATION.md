# Development startup regression

The frontend initialized in about 200 ms in the reported run, while the platform
opened port 4000 roughly five seconds later. Initial projects/features/agents
requests therefore failed with connection errors. Those loads did not automatically
repeat when the API eventually became available.

The launcher now starts the backend processes, waits for their configured TCP
listeners, and then starts Next. The platform registers its routes and initializes
storage before opening its listener. Readiness has a 60-second limit, and Ctrl+C
or a child exit cancels pending connection attempts. This is development startup
coordination; no production API retry or authentication behavior changed.

Configuration uses Node 24's built-in `.env` parser (the repository requires
Node 24), supporting quoted ports and inline host comments. Checked ports are
passed to children explicitly, including Next, which binds before reading `.env`.
Invalid/duplicate ports fail clearly. The remote-runtime mode still omits local
agent-core; the optional model gateway is included only when configured.

## Before and after evidence

The exact same isolated fixture tests were run against the original Git launcher
and the new launcher. Fake backend processes open their API after a 1,500 ms
delay; fake frontend processes immediately fetch that API. They use temporary
directories and independent ports, leaving the user's servers/database/providers
untouched.

| Identical startup fixture              | Original launcher                | New launcher                        |
| -------------------------------------- | -------------------------------- | ----------------------------------- |
| Local agent-core, platform and gateway | Initial API status 0; test fails | Initial API status 200; test passes |
| Remote runtime, platform and gateway   | Initial API status 0; test fails | Initial API status 200; test passes |

[Original test output](performance/t3-chat/dev-startup-before.txt) and
[fixed test output](performance/t3-chat/dev-startup-after.txt) preserve the results.
All nine dedicated tests pass, also covering delayed listeners, timeout, abort,
invalid inputs, quoted custom ports/host comments, cancellation during startup,
optional gateway configuration, and backend exit before readiness. Shutdown tests cover cooperative fixture
processes; forceful cleanup of unresponsive descendants is not claimed.
The complete platform suite also passes: 171 tests, zero failures or skips.

Reproduce the current checks from `platform/`:

```sh
node node_modules/tsx/dist/cli.mjs --test test/dev-startup.test.ts
```

The original launcher was saved at `/tmp/truex-dev-launcher-before.mjs` using
`git show HEAD:scripts/dev.mjs`. Run the same local/remote regression cases with:

```sh
TRUEX_DEV_SCRIPT_UNDER_TEST=/tmp/truex-dev-launcher-before.mjs \
  node node_modules/tsx/dist/cli.mjs --test \
  --test-name-pattern='^dev launcher startup: (local|remote)$' \
  test/dev-startup.test.ts
```

After the actual API became ready, all three real read endpoints returned HTTP 200
with the expected `Access-Control-Allow-Origin: http://localhost:3000` header.
This confirms the running API and browser origin configuration; it does not
substitute for the isolated fresh-start regression.

To use the new startup order, stop the existing launcher with Ctrl+C and run
`npm run dev` again. The frontend's ready message will follow backend readiness.
