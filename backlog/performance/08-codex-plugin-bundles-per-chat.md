# Codex copies its bundled plugins into every chat's folder

Status: open · Medium · decide before AgentCore launch · Added 2026-10-20 · Source: context stress test (side finding)

## Observed

Each chat's Codex folder holds 30–95 MB of bundled Codex plugins. The 70 chats on the laptop took 3.9 GB in total, most of it these copies. Chats can't use plugins (no tools), so this is all waste.

## Why it matters

On AgentCore this is per-chat `/mnt/state` storage: cost, slower first message (writing tens of MB), and a size limit reached after a few hundred chats. See also `03-adapter-per-message-disk-work.md`.

## Do

- Find in the pin where the plugins are written and which config setting stops it; prefer an adapter config change (no Codex edit).
- Measure a new chat's folder size and first-message time before and after.
- Do together with `backlog/security/03-codex-plugin-outbound-calls.md`, which likely has the same switch.

## Done when

A new chat's folder contains no plugin bundles, with a test that checks the size on every pin upgrade.
