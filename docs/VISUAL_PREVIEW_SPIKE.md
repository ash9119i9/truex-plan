# Visual preview Phase 0 findings

The Phase 0 no-go below records the original decision. The revised POC decision at the end supersedes it under explicit deployment conditions.

Date: 2026-10-06. Branch: `feat/visual-preview`, created from `main`.

**Decision: no-go for running Chromium inside the AgentCore process.** Phase 1–3 were not started. Use a separately isolated renderer service (option B) unless the runtime owner can provide and verify a stronger per-browser OS sandbox.

## a. Runtime package

Debian Trixie publishes ARM64 `chromium` 154.0.8037.92-1~deb13u1. Its installed size is 298,276 KiB; `chromium-common` adds 85,198 KiB. `fonts-liberation` adds 4,287 KiB and provides Arial/Times/Courier-compatible metrics. Explicit `chromium-sandbox` adds 397 KiB. Those four packages total about 379 MiB, before their dependencies. In a disposable x86_64 `node:24-trixie-slim` container, APT estimated 766 MB additional disk for `chromium fonts-liberation` with `--no-install-recommends` (169 packages). This is not an ARM64 image-layer measurement; the project runtime's exact delta remains unmeasured.

Sources: [Debian chromium ARM64](https://packages.debian.org/trixie/arm64/chromium), [chromium-common ARM64](https://packages.debian.org/trixie/arm64/chromium-common), [fonts-liberation](https://packages.debian.org/trixie/all/fonts-liberation), [chromium-sandbox](https://packages.debian.org/trixie/arm64/web/chromium-sandbox).

## b/c. Launch, sandbox, memory, and time

The host is x86_64 and has no ARM64 binfmt emulator: `docker run --platform linux/arm64 node:24-trixie-slim ...` exited with `exec format error`. Therefore the following launch and performance results are x86_64 Trixie container results, not ARM64 verification.

Chromium 154 ran as the non-root `node` user with `--no-sandbox`. Without that flag it failed with “No usable sandbox.” Installing Debian's setuid `chromium-sandbox` did not fix it: namespace creation failed with `EPERM`. In this container, headless Chromium therefore needs `--no-sandbox`. Browser request interception, proxy rules, and a temporary profile do not constrain a compromised process from the AgentCore user's files; that gap makes in-process rendering a no-go.

A temporary localhost harness captured PNG screenshots and sampled Chromium process-tree PSS every 25 ms. Each render used a fresh profile and a 1,000 ms virtual-time budget.

| Page | Concurrent browsers | Group wall time | Peak PSS |
|---|---:|---:|---:|
| Simple HTML/SVG | 1 | 314 ms | 397 MiB |
| Simple HTML/SVG | 2 | 457 ms | 592 MiB* |
| 2000 px SVG | 1 | 327 ms | 389 MiB |
| 2000 px SVG | 2 | 399 ms | 579 MiB* |

The tall SVG reported 2000 px content height and produced a PNG. `*` Concurrent PSS is the sum of each browser's sampled per-render peak, a conservative upper bound; 25 ms sampling can miss shorter peaks. Memory is manageable with strict concurrency, but ARM64 performance and PSS remain unknown.

## d. Driver

Select `puppeteer-core` if the renderer moves forward. It drives an explicit system Chromium path and, per [Puppeteer's installation guide](https://pptr.dev/guides/installation), does not download Chrome when installed. It avoids adding hand-maintained CDP framing and page-control code. No dependency was added in Phase 0; pin it and update `agent-core/package-lock.json` only after the renderer boundary is approved.

## e. Claude image delivery

`cd model-gateway && npx tsx --test test/anthropic.test.ts` passed **9/9** tests with no credentials or provider request. The image case asserts that a Responses `input_image` data URL becomes an Anthropic base64 image block. This verifies the adapter serialization path, not delivery to a live Claude model.

## Gate

(b) is not a go: the tested container cannot retain Chromium's OS sandbox, and no per-process isolation inside AgentCore was demonstrated. The proposed browser-level network controls do not close that process/filesystem boundary. A renderer service with its own restricted identity/container, no AgentCore files or credentials, OS-level network denial, resource caps, and verified browser sandbox is the appropriate next experiment. ARM64 launch/sandbox behavior and the deployed AgentCore runtime's exact isolation remain unverified.

## Revised POC decision (2026-10-07)

Proceed with an off-by-default renderer inside AgentCore for a limited POC. [AWS session documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html) states that each runtime session has a dedicated microVM with isolated compute, memory and filesystem, terminated and sanitized at session end. Truex maps one conversation to one `runtimeSessionId`. This limits a compromised browser to that conversation's microVM; it does not protect that conversation's files or credentials.

[AWS security guidance](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html) states that any code in the VM can reach execution-role credentials via the metadata endpoint, and persistent filesystem permissions are stored but not enforced. A separate Chromium uid would therefore not protect `/mnt/state`. Browser request blocking and a scrubbed environment reduce ordinary page access but are not a security boundary against a browser exploit.

POC acceptance depends on a least-privilege execution role, audited runtime network mode, one conversation per session, a patched system Chromium, fresh temporary profiles outside persistent state, explicit `CHROMIUM_NO_SANDBOX=1` only when required, hard timeouts, bounded concurrency and an off-by-default `VISUAL_RENDER` flag. A separate renderer service remains the stronger production design. ARM64 launch, actual AgentCore memory use, image size and real-provider screenshot delivery require the deployment checks in [VISUAL_PREVIEW_DEPLOY.md](VISUAL_PREVIEW_DEPLOY.md).
