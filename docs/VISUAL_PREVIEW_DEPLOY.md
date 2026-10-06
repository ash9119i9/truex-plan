# Visual preview dev deployment checks

Run these in a disposable AWS dev runtime before enabling this POC for testers. Record commands, outputs and measured values in the deployment record.

- [ ] Build the image for `linux/arm64` and record `chromium --version`, successful non-root launch, final image size and whether AgentCore accepts that size. The local x86 host could not execute ARM64.
- [ ] Deploy a dev runtime with one conversation per `runtimeSessionId` and persistent state mounted at `/mnt/state`. Confirm session mapping and owner routing.
- [ ] Audit the execution role with IAM Access Analyzer and reduce permissions to only the needed resources. Code in the microVM can obtain this role's credentials through MMDS; file permissions do not isolate `/mnt/state`.
- [ ] Confirm the runtime's outbound network mode and security-group egress. Test that browser-authored requests do not leave the microVM. Browser request interception and proxy rules are not an OS network boundary.
- [ ] Set `VISUAL_RENDER=1`, `CHROMIUM_PATH=/usr/bin/chromium`, and only if the sandbox fails, `CHROMIUM_NO_SANDBOX=1`. Record the startup warning and reason. Leave the feature off in other environments.
- [ ] Run `npm run agentcore:test` in the deployed dev environment. Preview a real page, publish it, confirm nine saved heights, and check the first paint at narrow and wide widths.
- [ ] Measure browser peak memory, cold start, render wall time, and cleanup after repeated previews. Confirm the configured concurrency limit fits the session memory allocation.
- [ ] Run a real Claude-profile turn and confirm the screenshot arrives as an image tool result, alongside text diagnostics. No local test used a real provider key.
- [ ] Check structured `visual_render` logs for success, duration, error counts and blocked-request counts without HTML, screenshot data or secrets.
- [ ] Roll back by unsetting `VISUAL_RENDER`; if the image itself causes problems, redeploy the previous image.

Security context: [AWS session isolation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html) and [AWS runtime security guidance](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html).
