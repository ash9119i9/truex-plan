# Connectors: move connector secrets into AWS

Status: open · Added 2026-10-20 · Depends on: MCP directory connectors (`tasks/mcp-plan.md`)

## Goal

Keep the two connector secrets in AWS instead of the platform's environment, before connectors run anywhere beyond local development:

- **OAuth app client secrets** (one per directory connector, owned by the product team): Secrets Manager, referenced from the catalog record as `clientSecret: { arn }`.
- **Token encryption keys** (`MCP_TOKEN_KEYS`, `MCP_TOKEN_ACTIVE_KEY`): Secrets Manager, or KMS envelope encryption as the later hardening step.

## Current state (v1)

- The catalog record already accepts `clientSecret: { env: "<NAME>" }` for local development, and `ClientSecretResolver` (`platform-next/src/modules/connectors/client-secret.resolver.ts`) already resolves `{ arn }` from Secrets Manager with a 5-minute cache and no AWS error text surfaced. v1 uses the env form.
- `MCP_TOKEN_KEYS` / `MCP_TOKEN_ACTIVE_KEY` are read from `platform-next/.env` (`platform-next/src/config/connectors-config.ts`).

So this is mostly configuration and deployment, not new code.

## Why it matters

- An env var lives in `.env` files, shell history, container env and anything that dumps the process environment. Anyone who reads `.env` gets the GitHub App's client secret and every user's connector tokens (with the encryption key plus a DB copy).
- Secrets Manager gives access control by IAM role, CloudTrail audit of every read, and rotation without editing files on the host.

## Steps

1. Create `truex/<env>/github-app-client-secret` in the platform's region; switch the catalog record from `{ env }` to `{ arn }` with the operator CLI.
2. Grant the platform's EC2 instance role `secretsmanager:GetSecretValue` on exactly those ARNs.
3. Load `MCP_TOKEN_KEYS` from Secrets Manager at platform start (same pattern decided for `AUTH_SIGNING_KEY`); remove it from `.env`.
4. Rotation runbook: add a new key ID, make it active, re-encrypt or let rows move on reconnect, then retire the old key.
5. Remove the env-based secrets from every host and confirm the platform starts without them.

## Open decisions

1. Secrets Manager for the token keys, or go straight to KMS envelope encryption.
2. Whether the operator CLI should refuse `{ env }` secrets when `NODE_ENV=production`, so a production catalog can't silently depend on an env var.
