# Truex enterprise product plan: sales first

Status: proposed product direction, 2026-10-08. The user selected sales teams, proposals, and customer presentations as the first workflow. This is a planning document; it does not change application behavior or select an editor vendor.

## Product promise

Give a salesperson one place to turn trusted customer information into a reviewed, branded proposal and presentation, then deliver the approved work with a clear history.

The long-term vision is one enterprise workspace across departments. The first product must earn daily use through one complete workflow. Connect existing systems of record before deciding which applications to replace. Measure workflow value separately from the number of integrations or generated files.

## What exists today

The repository already has chat and streaming, uploads and downloadable document generation, immutable generated revisions, interactive HTML visuals, HTTP MCP connectors, and personal project folders.

Important limits documented in [assistant capabilities](ASSISTANT_CAPABILITIES.md): imported Office formatting is not preserved during regeneration; spreadsheet formulas and recalculation are unsupported; slides use a bounded title/bullet model; uploads are limited to 1 MB per file. These are useful initial capabilities, but do not establish production editing fidelity. Verify documented limits against current code during implementation because documentation can lag.

Authentication and tenant infrastructure exist in the current code, including Google sessions and per-tenant databases. Enterprise identity, resource permissions, protected tool execution, and revocation still have gaps. Use the existing [authorization plan](AUTHORIZATION_PLAN.md) as the security workstream. Personal project folders must not silently become shared permission boundaries.

## First customer and workflow

Start with a small sales design-partner cohort. Suggested research group: 5–10 salespeople plus 2–3 managers/reviewers, adjusted to available access. Observe real proposal preparation, edits, approval, and delivery. Record the current median active effort, elapsed turnaround, copy/paste steps, and frequent quality failures.

Working example:

1. Open an opportunity workspace and add a brief, meeting notes, and approved product material.
2. Extract requirements, stakeholders, and unanswered questions, with source links.
3. Draft a branded proposal. Mark unsupported claims and missing pricing inputs visibly.
4. Edit a paragraph directly or ask the assistant to revise the selection. Preview and accept its changes.
5. Create an 8–12 slide customer presentation from the selected proposal revision.
6. Review commercial terms and claims. Approve a specific revision and its outputs.
7. Export DOCX/PDF/PPTX or share an authorized link. External sending requires an explicit action.
8. Reopen the workspace later and recover files, history, sources, and review status.

Suggested first prompt: “Use this customer brief and our approved product material to draft a proposal and a ten-slide presentation. Highlight missing information and leave pricing for my review.”

## Experience principles

- A workspace opens the user's recent work and its next useful action.
- The primary surface is the document or presentation. Chat sits beside it and operates on explicit selections.
- Use a compact navigation/library area, a large editing/preview canvas, and a collapsible assistant panel. On narrow screens, show one surface at a time with a clear return path.
- Keep manual editing available without an AI call. Provide keyboard shortcuts, accessible controls, autosave status, undo, version history, and reliable reopen.
- Prefer actions such as “Draft proposal,” “Create presentation,” and “Request review” over asking users to choose models, agents, or technical tools.
- Display upload, generation, save, and export status separately. Never show “Saved” until persistence is acknowledged.
- Preserve the original on import. Explain unsupported content before a lossy conversion; never silently discard charts, formatting, or embedded objects.
- AI edits are proposals against a known revision. Concurrent changes trigger a conflict or rebase review, never an unnoticed overwrite.
- Permissions and review status should be understandable at the artifact itself.

## Capability priorities

| Capability | First release | Later expansion |
| --- | --- | --- |
| Documents | Branded proposals, rich text/tables/images, section edits, comments, DOCX/PDF export | Complex pagination, broader import fidelity, specialist document workflows |
| Presentations | Approved templates, slide thumbnails, text/image/chart edits, speaker notes, PPTX export | Advanced animation, broader layout and import support |
| HTML | Sandboxed customer explainers and interactive comparisons with source data | Governed internal tools and publishing, once execution/access boundaries are defined |
| Spreadsheets | Import approved tables; calculate quote totals with validated deterministic rules | Formula engine, recalculation, richer XLSX round trips only after a dedicated compatibility evaluation |
| Knowledge | Workspace sources, approved product claims, approved brand templates | Permission-aware company search across approved connectors |
| Workflow | Draft → review requested → approved → delivered; explicit reviewer and revision | More departments, configurable approval chains, bounded automation |

Documents and presentations are editor experiences; DOCX and PPTX are file formats. Plan their import, editing, preview, and export contracts separately. Google Docs and Slides are external services, with their own ownership and access policies.

## Build and integration choices

Own the common workspace, source tracking, artifact lifecycle, AI revision experience, brand templates, permissions, review flow, and usability. Reuse a proven editing/rendering component when it passes the actual compatibility and licensing requirements. Do not commit to building a complete Office suite before testing that decision.

Evaluate three paths with the same real customer files:

1. Native Truex content and template-based exports: greatest experience control, with an explicit supported-feature contract.
2. A licensed document/presentation editing component: validate deployment, security, accessibility, fidelity, collaboration behavior, vendor terms, and total operating cost.
3. Connected Microsoft/Google files: retain their authoritative copy and provider permissions, and use supported APIs or approved editor integration.

Microsoft 365 web embedding through WOPI requires Cloud Storage Partner Program membership and eligibility; it is not an unrestricted iframe integration. [Microsoft integration requirements](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/).

Google exposes document revision controls and presentation update APIs. These provide supported ways to change provider-owned work; they do not themselves supply an embeddable editor or guarantee cross-format fidelity. [Docs write controls](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate), [Slides update API](https://developers.google.com/workspace/slides/api/guides/overview).

Select one external ecosystem for the pilot based on the design partners. Start with one narrow connector use case; expand only after its access, revocation, and failure behavior is verified.

## Smallest useful architecture

Keep the existing frontend, platform, runtime, and gateway boundaries. Do not add services without a concrete scaling or isolation need.

- Platform owns authenticated tenant context, workspace access, artifact metadata/revisions, review state, and jobs. Runtime creates suggestions and invokes bounded, authorized tools.
- Treat enterprise workspaces as a new explicit resource, linked to existing conversations. Keep old personal-folder behavior compatible.
- Store durable artifact binaries and originals in private object storage; retain metadata, relationships, revision pointers, and audit records in the application database. Plan migration from conversation-local runtime files and verify restart/runtime-version recovery.
- Record artifact ID, tenant/workspace, kind, source, revision, renderer version, dependencies, and access policy. These are proposed fields, not existing API contracts.
- Reuse approved facts, calculations, and brand assets across outputs, while using separate document, slide, and spreadsheet content models. A universal HTML representation should not become a lossy replacement for every format.
- Link the deck to the proposal revision it used. Later proposal edits mark downstream work as stale and offer an update; never silently replace approved outputs.
- For long exports, use durable jobs with bounded concurrency, progress, cancellation, and idempotency. Define retry safety before introducing retries.
- Imported provider files remain authoritative in their provider unless the user explicitly copies them into Truex. Avoid bidirectional synchronization in the first release.

## Delivery roadmap and release gates

This is a proposed twelve-week learning sequence, not a delivery commitment. Staffing, editor selection, and the independent authorization workstream may change the dates. Security gates take precedence over the calendar.

| Period | Outcome | Gate before advancing |
| --- | --- | --- |
| Weeks 1–2 | Observe sales workflows; choose templates, representative files, primary ecosystem, baseline and prototype | Users complete the prototype workflow; compatibility experiment establishes supported features and editor path |
| Weeks 3–6 | Durable workspace and proposal editing with autosave, source links, accepted AI edits and DOCX/PDF export | Restart/reopen works; stale writes do not overwrite; supported fixture exports open correctly and pass visual review |
| Weeks 7–10 | Branded presentations, proposal-to-deck lineage, comments and revision-bound approval | DOCX/PDF/PPTX tell the same approved story; edits invalidate approval; critical layouts remain correct |
| Weeks 11–12 | Restricted sales pilot; selected connector only if its gate passes; measure usability, quality and cost | Real customer data allowed only after identity, tenant isolation, artifact access and revocation tests pass |
| After pilot evidence | Broaden adoption and choose the next department or workflow | Existing users return, complete real work, and demonstrate worthwhile time savings at acceptable cost |

Prototype and usability work may use synthetic/redacted data while enterprise controls are under development.

## Measurable acceptance criteria

Set targets with design partners after the baseline. Suggested hypotheses, not achieved results:

- At least 30% lower median active effort from brief to approved proposal/deck, including correction and review time.
- At least 80% of pilot users finish the core workflow without facilitator intervention.
- At least 60% of activated pilot users complete a meaningful workflow in a later week; opening chat is not meaningful completion.
- Initial UI feedback within 200 ms for local edits/actions; p95 workspace open under 2 seconds under a documented device/network/load profile. Generation/export latency is measured separately by file size.
- Every supported-format acceptance fixture opens in the declared target applications, passes a render review, and contains the expected text/tables/images without clipping. Unsupported features are disclosed.
- Acknowledged saves survive service/browser restarts in recovery tests. Stale revisions are rejected or explicitly resolved.
- Automated isolation tests cover metadata, preview, download, search, share, forks, exports, and connector execution; revocation affects existing streams and links as well as new requests.
- Cost is measured per completed workflow, including retries, failed exports, model calls, storage, and editor licensing. Choose a budget after measuring representative work.

Instrument workspace opened, source attached, draft generated, edit accepted/rejected, revision saved, export succeeded/failed, review requested, revision approved, and delivery completed. Record timings and artifact/job IDs; avoid putting document content or secrets into analytics.

## Break-mode scenarios and safeguards

| Worst realistic failure | Required protection and evidence |
| --- | --- |
| Wrong price or invented promise reaches a customer | Approved sources, deterministic calculations, missing-input markers, explicit review of commercial terms, approval bound to delivered revision |
| Another tenant reads customer files | Fail-closed resource authorization across every read/write/preview/search/export path; isolation and revocation tests |
| User or AI overwrites a colleague's work | Revision preconditions, conflict experience, immutable accepted versions, recovery tests |
| Browser or worker crashes after save/export | Durable persistence, acknowledged status, retry-safe jobs, bounded retries and recovery tests |
| Imported document instructs an agent to leak data | Treat content as data; enforce tool permissions and credential boundaries outside the model; adversarial document tests |
| Generated HTML steals data or stalls the browser | Retain sandbox/CSP isolation, deny uncontrolled network access, offer unload/recovery, test malicious and expensive content |
| Export silently drops information | Preserve originals, explicit supported-feature contract, application-open and visual regression fixtures |
| Agent retries an external send | Explicit send action, operation identity, result reconciliation and idempotency only where the provider supports it |

Before enterprise rollout, also define retention/deletion behavior, restore drills, encryption/key management, tenant administration, incident ownership, monitoring, and rollback. Treat tenant-authorized downloads differently from revocable links: a downloaded copy cannot be recalled.

## First implementation slice

After discovery and the editor experiment, implement **open workspace → add approved sources → draft one proposal → manually/AI edit → save and reopen → export DOCX/PDF**. Validate it end to end before adding presentations, HTML generation enhancements, connectors, or automation.

Keep implementation PRs small: workspace/resource contracts, durable artifact storage, editor and saves, AI revision proposals, export QA, then review and presentation flow. Enterprise authorization progresses alongside these slices and gates access to real customer information.

The remaining decisions are the pilot customers, primary ecosystem, team capacity, supported import/export features, and operating budget. No live performance, fidelity, or productivity claim is established by this plan.
