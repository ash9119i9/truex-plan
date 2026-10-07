# Visual replies

Truex implements T3's preview → repair → publish workflow using its existing
Codex dynamic-tool adapter. `html_render` saves a complete HTML document and
publishes an authorized thread attachment before the final text reply.
`html_preview`, when configured, returns a Chromium PNG plus height and bounded
console diagnostics directly to the model. A full integrated browsing UI is not
required. Existing `create_visualization` fragments, markers, revisions, state,
follow-up drafting, expansion and offline exports remain supported.

This is an adaptation, not identical T3 code. Remote resources/CDNs and host image
paths remain blocked; documents retain Truex's 180,000-character limit and shared
50-file / 25 MB quota. Initial frame height is 160–900 pixels. There is responsive
mobile web support, not a native mobile WebView. Server measurement at nine widths
is deferred. See [the reference audit and plan](VISUAL_REPLIES_PLAN.md).

## Setup

Run `npm run install:all` to install the shared pinned HTML parser and service
packages. New threads register `html_render` by default. Old thread registrations
remain unchanged. `VISUAL_REPLIES_ENABLED=false` disables registration for newly
created threads; saved visuals and legacy tools remain available.

Publication does not depend on preview. Without a configured runner the preview
tool is omitted and agent instructions explicitly disclose unavailable browser
validation. Merely building the application does not deploy a preview host.

Build the preview worker on a private Linux Docker host:

```sh
docker build -t truex-html-preview:local html-preview-worker
npm ci
npm --prefix agent-core ci
npm --prefix agent-core run build
HTML_PREVIEW_SECRET="$preview_secret" \
  HTML_PREVIEW_IMAGE=truex-html-preview:local \
  node agent-core/dist/agent-core/src/html-preview-server.js
```

Supply `preview_secret` securely, at least 32 characters; do not commit it. The
supervisor defaults to loopback port 8091. Run it behind an authenticated private
TLS endpoint reachable from the runtime, with a service manager and Docker access.
Keep the service off the public internet. Configure the agent-core deployment:

```dotenv
HTML_PREVIEW_RUNNER=http
HTML_PREVIEW_URL=https://private-preview.example/preview
HTML_PREVIEW_SECRET=<same securely supplied secret>
```

For local development only, `HTML_PREVIEW_RUNNER=docker` runs jobs through the
local Docker daemon. AgentCore's deployed runtime does not expose Docker; use the
private HTTP path there. The supervisor receives the service credential, while
browser jobs receive only the prepared document, width and appearance.

## Boundaries and failure behavior

Each job has a separate nonroot, read-only container: no network, no host mounts,
no tenant credentials or Docker socket, all capabilities dropped, no new
privileges, one CPU, 512 MiB RAM, 128 PIDs and bounded tmpfs. Chromium's own user
namespace sandbox is disabled because the tested Docker seccomp configuration
rejects it; the OS boundary here is the disposable container. Do not run the worker
directly on a shared host or mount the Docker socket inside it.

One job runs at a time; four can wait, with at most two admitted per conversation and two per tenant in the
authoritative runtime.
This bounds admission, without a guarantee of equal scheduling among tenants. The worker
has a 19-second watchdog; the supervisor has a 20-second execution limit and
explicit cancellation/cleanup. The HTTP caller has a 23-second total deadline,
which includes queueing. Screenshot and output limits are 4 MiB and 6 MiB;
console output is limited to 20 messages of 500 characters. Screenshots capture
at most 4,000 pixels of height and report the full content height separately.

Remote requests, cloud metadata access, file access, redirects, nested frames and
workers are blocked. Both preview and the reader use the same HTML preparation,
CSP and bootstrap. Source is fetched through session authorization, never a public
HTML URL. Public events contain only bounded attachment metadata. The iframe
allows scripts with an opaque origin and requires source/origin/shape checks for
bridge messages. Generated reader JavaScript still has no client CPU budget.

Source metadata journals the publishing turn and call. Repeated identical calls
reuse the attachment; conflicting reuse is rejected. Publication writes the
adapter event spool before reporting success. Cold recovery restores associations
from committed metadata; event replay and persistence deduplicate by call/visual
identity. Interrupted, stale and helper-thread publication is rejected.

Log records expose job ID, queue depth, queue wait, duration, status and cleanup
failure, never HTML, console content, screenshots or credentials. If cleanup
fails, the supervisor stops admitting work. Inspect/remove its named
`truex-preview-*` jobs and restart only after Docker is healthy. Failures leave
`html_render` and saved readers available. Roll back by disabling new registrations
and removing preview configuration, retaining sources/events for compatibility. The additive
`visual_publications` partial Mongo index is created by the existing tenant index
setup and can remain during rollback; there is no destructive migration.

## Design and verification

The viewer retains existing controls and layout. Shared preparation supplies the
color, typography, helper-tone and focus tokens from
[the design specification](truex-design-spec.html) and updates frame appearance
without resetting interaction state. Font loading inside frames remains blocked by the existing policy; their
specified font stacks use system fallbacks. HTML authored by the model can override its
own content styles; generated pages are not guaranteed to satisfy every layout
rule just because the host uses the specified tokens.

Checks cover complete documents and fragments, policy stripping, hostile input,
parser-depth limits, scope authorization, publication/replay/fork recovery,
idempotency, provider image transport, Stop cancellation, queue overflow, timeout,
network denial and worker cleanup. Runtime integration uses the actual pinned
Codex engine with a deterministic provider. Real Docker tests require:

```sh
HTML_PREVIEW_DOCKER_TEST=1 agent-core/node_modules/.bin/tsx --test agent-core/test/html-preview-docker.test.ts
```

See [measured results](performance/visual-replies/README.md) for local benchmark
scope and reproducibility. These checks do not validate live provider acceptance,
production host performance or a production deployment. Run a private-service
smoke test and monitor queue wait, duration, failures, memory and leftover jobs
before enabling preview in production.
