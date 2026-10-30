# Live screens the spec doesn't design

Status: open · Design · Added 2026-10-28

## Gap

The spec covers the shell, the chat, replies, requests, the Activity Panel and Agents. The live frontend has more than that, and none of these are designed:

| Screen / feature | Where today |
|---|---|
| Connected tools (connect, OAuth, read/write access) | `frontend/app/connected-tools`, `app/t/[tenantId]/connected-tools` |
| Sign in | `frontend/app/login` |
| Invitation accept | `frontend/app/invite/[token]` |
| Choose / manage workspaces, team invitations | `frontend/app/select-tenant`, Account → Manage workspaces |
| Display-name confirmation after sign-up | `POST /auth/profile/name` flow |
| File viewer (open a reply's file, versions, download) | `frontend/components/tenant/file-viewer.tsx` |
| Visualize (interactive charts and explainers in replies) | `docs/VISUALIZE.md` |
| Goal: set, budget, review gate (only the `.pt-goal` strip is specified) | goal feature |
| Error, not-found and global-error pages | `frontend/app/error.tsx`, `not-found.tsx`, `global-error.tsx` |
| Projects (removed from the sidebar earlier) | `backlog.txt` |

## Do

For each one, either design it to the system (a screen study and a spec section) or record that it keeps its current layout restyled with system tokens and primitives only. Each needs a decision before the build step that touches it. Without one, these screens would stay in the old style after the old CSS is removed.

## Done when

Every row has a design, or a recorded "restyle only" decision.
