# Scheduled automation operations

This packages a local PostgreSQL-backed Temporal service and a separate worker. No service or business schedule was deployed by implementation. Production operation requires explicit rollout authorization and the pending checks below. The separately authorized [real agent pilot](../../docs/architecture/automations/PILOT_EVIDENCE.md) passed in an isolated stack, including a scoped Qlik read-only connector recipe.

## Reviewed components

Temporal server/admin tools **1.32.0**, PostgreSQL **16.13**, Node **24.21.0**, and the worker TypeScript SDK **1.24.0** are pinned; container images include registry-confirmed manifest digests with amd64/arm64 entries. The former `temporalio/auto-setup` image is deprecated, so schema setup uses the supported server/admin-tools split. [Official Temporal Compose samples](https://github.com/temporalio/samples-server/tree/main/compose), [auto-setup notice](https://hub.docker.com/r/temporalio/auto-setup).

`compose.yml` is a local development stack: only Temporal gRPC is published, on **127.0.0.1:7233**. PostgreSQL stays inside the Compose network. The transient root schema bootstrap writes only its private marker volume; the application worker image runs as the unprivileged Node user. Development dynamic configuration is explicitly local; review a production configuration separately.

## Showing Automations in the local app

Automations is hidden when the platform returns `available: false`. The default is disabled. For local development add these settings to private `platform/.env`:

```dotenv
AUTOMATIONS_ENABLED=on
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=truex-automations
```

Start the pinned Temporal CLI 1.9.1 with persistent development storage, then restart the platform API so it rereads the flag. Keep Temporal and the worker running in separate terminals alongside `npm run dev`:

```sh
mkdir -p .runtime/automations
# Use Temporal CLI 1.9.1; the verified local copy is .runtime/automations/temporal.
.runtime/automations/temporal server start-dev --ip 127.0.0.1 --port 7233 --ui-ip 127.0.0.1 --ui-port 8233 --db-filename .runtime/automations/temporal.sqlite
# In another terminal:
npm --prefix platform run worker:automations
```

The private configuration and development SQLite database are ignored by Git. This local CLI is installed separately from source; provision the pinned binary before using the command on a new machine. The root `npm run dev` command starts the existing API/runtime/frontend services; it does not start Temporal or the automation worker. Refresh `http://localhost:3000` after the API restarts. Mongo must support replica-set transactions. Saving a draft does not enable a schedule; users still explicitly review and enable their recipes.

## Local validation and startup

From the repository root, operators can review the configuration without starting infrastructure:

```sh
TEMPORAL_POSTGRES_PASSWORD=validation-only docker compose -f deployment/automations/compose.yml config --quiet
sh -n deployment/automations/setup-schema.sh deployment/automations/setup-namespace.sh
npm --prefix platform run build
npm --prefix platform run test:automation:temporal
```

After local infrastructure startup is authorized, inject a private database password into `TEMPORAL_POSTGRES_PASSWORD`, then run `docker compose -f deployment/automations/compose.yml up -d`. Do not commit the password. Fresh storage creates the Temporal and visibility databases, applies schemas, starts the server, and creates the default namespace with thirty-day Workflow retention. Existing initialized storage is preserved. A partial first schema initialization fails closed: inspect which databases and schema metadata exist and finish the missing official `temporal-sql-tool` create/setup/update operations manually; never erase or reinitialize populated databases to get past that error.

The application needs its existing configured runtime, connector encryption and identity settings plus a **Mongo replica set**. Copy the additive automation keys from `platform/.env.example` into private configuration. Keep `AUTOMATIONS_ENABLED=off` while reviewing recipes. For an authorized internal pilot set it to `on` in both API and worker, use the same `TEMPORAL_NAMESPACE` and `TEMPORAL_TASK_QUEUE`, and run:

```sh
npm --prefix platform run worker:automations
# After building, production process managers use:
npm --prefix platform run worker:automations:start
```

The worker refuses disabled automation admission or Mongo without transaction support. It runs evidence ingestion and a non-overlapping ten-second reconciliation loop; that loop repairs persisted intents and observations, while native Temporal Schedules own recurrence. No recipe is enabled by worker installation.

The standalone image build is:

```sh
docker buildx build --platform linux/arm64 --load -t truex-automation-worker:local -f deployment/automations/worker.Dockerfile .
```

The image defaults to admission disabled and starts the compiled worker directly. Supply its private environment through your process/container secret mechanism. Do not bake credentials, TLS files or `.env` into the image. Host loopback addresses are not reachable as the container's host; use an explicit private Temporal/Mongo/runtime endpoint or reviewed container network. Mount certificates read-only.

## Private authenticated production access

This Compose file does not configure production transport authentication, high availability or backup automation. Place Temporal and both databases on private network paths. Configure and test server-side TLS/mTLS and Temporal authorization before changing any bind or publishing a non-loopback port. Restrict namespace access to the API/worker identity and separate operator identity; never place connector secrets or recipe content in Workflow arguments/search attributes. The [self-hosted guide](https://docs.temporal.io/self-hosted-guide) describes the service security boundary.

API and worker share `temporalSettings`: `TEMPORAL_TLS=on`, optional trusted CA, client certificate/key pair, server-name override and optional authenticated endpoint API key. A partial certificate pair is refused. Rotate through secret storage, test the new identity, then replace processes; retain old runtime connector decryption keys for retained artifacts. The thirty-day Temporal history setting is separate from the 365-day Mongo audit metadata default and tenant content retention.

## Drain, outages and uncertain executions

For ordinary worker replacement, keep native Schedules and Mongo intact. Send **SIGTERM** and allow at least sixty seconds for the thirty-second Activity drain plus in-progress reconciliation. The worker stops accepting new tasks, awaits its run and reconciliation, stops ingestion, and closes connections. A replacement with compatible Workflow code resumes the same root execution. Preserve compatible workers and replay retained histories before changing Workflow code.

For feature rollback, first stop new admission through the application control path and pause native Schedules, persist the pending/applied control state, then drain workers. Keep observation/reconciliation for already active or uncertain executions available. Turning the feature flag off or stopping a worker alone does **not** pause native Schedules; queued actions can resume later. Do not delete Workflow histories, immutable revisions, run identities, audit records or Mongo execution fences.

A lost submission receipt is **unknown**, with its fence retained. Do not clear it on lease expiry, restart, namespace changes or operational pressure. Recover the same session/root evidence and confirm termination or absence of execution before releasing it. Cancellation is a request until the exact root's stop is confirmed. A failed approval/dependency occurrence keeps its schedule enabled; subsequent occurrences recheck current access but cannot overlap an unresolved execution.

Native catch-up is ten minutes; Activity admission also bounds lateness. Counter deltas beyond that window are honest missed-window summaries, not fabricated per-slot runs. During a Temporal/Mongo outage, preserve desired/applied versions and pending starts. Recovery retries the same identities and uses control conflict tokens. Do not invoke native backfill for real recipes without separate reviewed authorization.

## Backup, restore and upgrade drill

Back up PostgreSQL Temporal/visibility databases, Mongo catalog and each tenant's definitions/revisions/runs/ledger, and the separately secured connector encryption keys. Record versions and a consistent recovery point; protect snapshots as tenant data. PostgreSQL WAL/PITR and Mongo replica-set backup procedures must be designed and tested for the deployment's recovery objectives.

Restore into an isolated network with admission disabled and all restored Schedules paused. Compare database schema versions against the pinned server before starting it; run schema migrations through the corresponding admin-tools version only as a reviewed upgrade. Confirm namespace/queue identity, retained histories, control versions, active fences and pending operations. Replay sampled success, timeout, cancellation and unknown histories using the proposed worker. Start observation with no new dispatch, reconcile known root receipts, then explicitly resume a reviewed read-only recipe. Verify no duplicate mutation and record timing/audit evidence before wider activation.

Do not downgrade a migrated Temporal persistence schema by simply switching image tags. Retain the previous compatible worker to observe active runs, use the vendor-supported upgrade sequence, and restore a tested backup only under an explicit recovery decision. Connector side effects are not undone by restoring databases.

## Evidence and remaining gates

- Native isolated Schedule/Workflow suite includes DST, control CAS, replay, worker restart, deadline races, resume without backfill and a graceful disk-backed SQLite server restart; see [capability report](../../docs/architecture/automations/CAPABILITY_REPORT.md).
- Registry inspection verified the pinned server/admin-tools/PostgreSQL/Node image manifests and target architectures. Compose configuration and shell syntax checks passed. These checks do not prove containers start.
- Worker configuration/startup tests verify consistent settings, TLS pairing, disabled admission and refusal of standalone Mongo. Platform compilation passed.
- Target image build/start, PostgreSQL schema bootstrap/restart, authenticated endpoint checks, persistence outage/backup/restore drills and sustained healthy-load dispatch measurement remain pending. Real native-agent Run now and native Schedule occurrences passed separately, including an owner-scoped configured `qlik` read-only metadata lookup with exact persisted root/tool evidence. Single isolated occurrences measured 354 ms nominal-to-root-start lag without a connector and 308 ms with it; see the pilot evidence for preserved verifier limitations. The Docker daemon was unavailable during implementation.
- Review existing dependency advisories before any rollout. Implementation does not certify production readiness.
