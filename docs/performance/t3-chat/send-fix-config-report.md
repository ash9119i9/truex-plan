# Configuration send-preparation change — paired evidence

Baseline authorization: root captured the existing working tree and ran the unchanged baseline probes and all 772 existing tests before releasing edits. Frozen production source: `/tmp/truex-send-fix-before-20261006`. Prior uncommitted optimizations are preserved.

Only `PlatformService.configuration()` changed in this workstream. After the existing agent lookup, model, tenant MCP, owner MCP and catalog skill reads begin together. Each promise immediately observes success or failure; results are consumed in the previous validation order. Missing/invalid model still rejects without waiting for unrelated reads. Tenant-name reservation, sorting, tenant precedence, key decryption, per-build DNS validation, approval defaults and final output remain unchanged. No cache, dependency, retry, database write or migration was introduced.

## Matched measurements

The same probe loads the frozen and candidate service/Store/fixtures, uses actual isolated Mongo collections, and injects delays at driver await boundaries. Both runs use the same inputs, one warmup and three measured iterations. Every measured output is deep-compared with its own undelayed result; complete output SHA-256 values also match between frozen and candidate for all three scenarios. Outputs contain synthetic credentials only; artifacts record hashes and timings rather than configuration bodies.

| Controlled scenario               |  Before p50 |  After p50 |  Reduction | DB reads | Fresh DNS lookups |
| --------------------------------- | ----------: | ---------: | ---------: | -------: | ----------------: |
| owner-no-connectors-225ms-db      |  909.926 ms | 457.016 ms | 452.910 ms |    4 → 4 |             0 → 0 |
| owner-skills-reservation-225ms-db | 1370.312 ms | 683.431 ms | 686.881 ms |    6 → 6 |             2 → 2 |
| three-connectors-25ms-dns         |   81.997 ms |  82.239 ms |  -0.242 ms |    4 → 4 |             3 → 3 |

The plain owner case removes two serial 225 ms waits; the skill/reservation case also overlaps the skill lookup and removes three serial waits. Successful calls make the same number of database reads. DNS remains sequential and fresh on every build; the DNS control has no meaningful change. This is configuration-only synthetic delay evidence, not a live send, provider first-answer or browser paint measurement. Connection-pool wait and actual remote query behavior may limit real gains.

## Verification and adversarial review

- Matched focused suite: 12 tests on the frozen implementation, 11 pass and the overlap regression fails; the exact same test source passes all 12 on the candidate. A temporary test copy rewrites import paths to the frozen snapshot; no frozen production files were changed.
- Barriers verify no dependent reads start before the agent resolves, all four independent reads overlap, and missing model rejects before stalled reads finish. Later failures must not become unhandled rejections.
- Simultaneous dependency failures preserve model → tenant MCP → owner MCP → connector/reserved-name → skills error precedence.
- Actual MCP validation tests cover tenant/owner collisions, tenant-wide unattached reservations, invalid shadowed user rows skipped, duplicate tenant names rejected, reserved-name query failure, encrypted key output and catalog skill order.
- DNS rebinding to any private address is rejected on the next build; every build rechecks DNS, and the existing DNS-outage-at-build behavior is retained. Missing skills still fail closed.
- Existing Mongo-backed MCP, MCP scopes, model route and tenancy tests: 13 pass. They cover tenant/catalog boundaries, allowlists, ownership, gateway key handling and authorization patterns.
- Platform TypeScript build and focused Prettier check pass. Final configuration diff reviewed; `git diff --check` passed.

Per request, the maximum concurrent read count rises to four. Already-started read-only work continues after an earlier validation fails; rejection handlers consume its errors without delaying the authoritative error. There is no new cancellation or retry protocol. Concurrent configuration edits still have the pre-existing nontransactional read semantics; there is no permission cache or stale privilege reuse. Rollback is reverting this focused configuration section, with no data migration or persisted state changes.

T3 reference: local `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` resolves current runtime policy immediately before `providerSessions.open`, then starts the turn through the provider session. The analogous safety principle here is fresh validated preparation before turn start. T3 provider latency was not measured and no parity claim is made.

Artifacts: [probe](send-fix-config-probe.mjs), [before](send-fix-config-before.json), [after](send-fix-config-after.json), [red tests](send-fix-config-red-tests.txt), [green tests](send-fix-config-green-tests.txt), [policy tests](send-fix-config-policy-tests.txt), [typecheck](send-fix-config-typecheck.txt), [format](send-fix-config-format.txt), [focused diff](send-fix-config-diff.txt).
