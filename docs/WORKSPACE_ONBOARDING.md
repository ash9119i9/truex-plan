# Operator-managed workspaces and default signup

Only the platform operator creates tenants, through the existing tenant script
or the platform admin API. Customer accounts, including workspace admins, cannot
create personal or team tenants. `POST /auth/workspaces` returns 403
`TENANT_CREATION_OPERATOR_ONLY`; changing the old `SELF_SERVICE_WORKSPACES` flag
cannot enable creation.

In regular Google deployments, a new verified user signing in without an
invitation joins **Default tenant** as an ordinary member and enters Truex
directly. Signup creates an account and membership in one catalog transaction;
it never creates or adopts a tenant or database. Pending team invitations are
not consumed by ordinary sign-in. Opening an invitation still joins that
existing team with its invited role and selects it directly.

While the configured default signup tenant is selected, the account menu hides
the workspace name and workspace navigation. Direct visits to `/workspaces`,
`/select-tenant`, and `/onboarding` return these users to Truex without showing
workspace controls. The backend supplies `showWorkspaces` in `/api/me` and
`/auth/account`, so custom `DEFAULT_SIGNUP_TENANT_ID` values also work. This is
presentation only: membership authorization, invitations, and team workspace
switching remain unchanged. Users entering an invited team see its normal
workspace controls, including when they also belong to the default tenant.

Existing members keep their current workspaces and data. A valid remembered
membership is selected on sign-in; multiple memberships without a remembered
choice use the existing picker URL. `/select-tenant` redirects to `/workspaces`,
the single page for switching and admin-managed invitations. Selection rotates
the session and clears private browser state across tabs. Existing accounts
with no active membership can join the default workspace; removed default
memberships are never restored automatically. Disabled accounts and accounts
whose active workspaces are disabled retain the existing refusal behavior.

## Operator setup

From the repository root:

```sh
npm run tenant -- provision-default --dry-run
npm run tenant -- provision-default
```

The default ID is `default-tenant`, the name is `Default tenant`, and its database
is `truex_t_default_tenant`. This is separate from the reserved legacy `default`
tenant and its `MONGO_DB`, so old storage is not opened to new signups.
The command uses the existing `platform/.env` connection settings; process
environment values take precedence. It is repeatable and never copies agents,
conversations, connectors, or credentials.

The script refuses to adopt populated unregistered storage or customer-created
workspaces. It writes a pending record, builds owner-aware indexes, then marks
the operator tenant ready. Retrying an interrupted run finishes the same tenant.
It never re-enables a disabled tenant; operators explicitly use `enable <id>`.
Existing names and privacy settings are preserved on repeat runs.

Google configuration:

```dotenv
AUTH_MODE=google
DEFAULT_SIGNUP_TENANT_ID=default-tenant
DEFAULT_TENANT_SIGNUP=on
```

These are the defaults for ordinary Google deployments. The tenant must be
registered, active, ready, operator-managed, use its separate generated database,
and have consistent `isUserSpecific=true` / `chatVisibility=own` settings.
The creator-aware unique agent index must exist, without the legacy workspace-wide
handle index. Missing or unsafe setup refuses signup with `default_unavailable`,
granting no account, membership, or session. There is no fallback to another
workspace or automatic provisioning.

To create another team and invite its administrator:

```sh
npm run tenant -- create acme "Acme"
npm run tenant -- invite acme owner@example.com --role admin
```

The invite command prints a link without sending email. Platform admin tenant
creation remains available through its separately authenticated control plane.
Workspace admins can send, resend, and revoke invitations on the workspace page;
ordinary members cannot. New default users never become admins automatically.
For an existing default member, operators use the platform admin membership
controls to change the role; an invitation never promotes an active member.
Personal workspaces created by the previous implementation remain private and
cannot receive invitations.

## Privacy and compatibility

All default users share one tenant/database, but existing user privacy controls
restrict ordinary members to their own conversations and private agents.
Existing administrator access and tenant-level shared connectors/built-in agents
retain their existing rules. Models and skills remain catalog configuration;
provisioning does not create provider credentials or a usable model.

Configured `DEMO_TENANT_ID` deployments retain their existing demo admission,
quota, and privacy rules and do not fall back to the ordinary default signup
workspace. POC/dev identity behavior is unchanged.

Historical personal/team tenants, memberships, provisioning fields, and pending
reservations remain stored. They are not deleted or migrated. Customer creation
and resume controls are removed; the account endpoint keeps `canCreate=false`
and an empty pending list for old-client compatibility. Invitation management
has its own `canManageInvites` capability and remains available to authorized
workspace admins. Older onboarding sessions can sign in again to enter the
operator-provisioned default workspace.

Team links/access requests/approval queues remain removed. Only explicit,
email-bound invitations grant membership to other teams; email domains grant no
access. Retired join pages/APIs are unavailable, and stale request records grant
no membership.

## Rollout, recovery, and rollback

Provision and verify the default tenant before deploying this signup change.
Deploy the backend first to enforce the creation restriction, then the frontend
to remove creation controls. Old frontend creation attempts are denied safely.
Apply frontend and platform changes together for the invitation capability UI.

`DEFAULT_TENANT_SIGNUP=off` disables new default enrollment while preserving
existing memberships, invitation acceptance, switching, and invitation management.
It does not re-enable customer creation. No destructive migration is required.
Keep the tenant for rollback; deleting it is not part of recovery.

Observe structured Google sign-in success/refusal logs, selected tenant IDs,
invitation delivery failures, and the existing invitation audit events.
Repeated default signup configuration failures require operator repair; customers
should not be asked to create tenants. Public model usage still needs the
operator's existing capacity/billing policy; demo budgets apply only to demos.

## Validation

On October 11, 2026: **78 backend regressions**, **370 frontend tests**, platform
and frontend builds, frontend type checking, and browser flow checks passed.
The configured database contains the operator-provisioned `default-tenant`
record named `Default tenant`; the application changes still require rollout.
Targeted formatting and `git diff --check` pass. Repository-wide formatting
continues to report the 50 existing failures in legacy files.

Regression coverage exercises operator provisioning/dry runs/retries, ordinary
and concurrent default signup, customer/admin creation denial, default privacy,
unsafe or missing tenant/index refusal, revoked membership, disabled accounts,
manual invitations, pending-invitation isolation, remembered switching, public
signup disablement, existing demos, session rotation and CSRF. Frontend tests
cover account parsing, independent invitation capability, session failures and
the consolidated account menu. Default tenant visibility is covered for custom
IDs, admins, multiple memberships, and invitation entry into teams. Browser
checks verify default workspace controls are absent, all three old workspace
URLs return to Truex without rendering controls, team switching/invitations
remain available, and mobile layout, theme controls, and sign-out still work.

The broader repository previously had unrelated migration-script, agent-core
stress/timestamp, and repository-wide formatting failures. Targeted checks for
this change are reported separately; these changes do not alter those modules.
