# Spec: Hey Truex voice control

Status: Draft for review. This document specifies behavior; no voice feature has been implemented or verified.

## Objective

Let a signed-in user operate Truex by saying **Hey Truex** followed by a command while the application is open. Truex opens an assistant overlay, understands the command, performs supported application actions, and displays results in its existing interface. There are no spoken replies and no push-to-talk step for each command.

Confirmed requirements:

- Listening is required while Truex is open, not after its window or browser closes.
- Activation uses a wake phrase rather than a microphone button.
- Commands operate the application and its existing assistant capabilities.
- Feedback, questions, progress, errors, and results appear visually in Truex.

Working assumptions for implementation review: the wake phrase is Hey Truex; the initial validation target is desktop Chrome in English. Background tabs, mobile browsers, and additional languages require measured validation before support is claimed.

## User experience

1. During setup, the user enables hands-free control and grants browser microphone permission. This is setup, not a recurring command interaction.
2. While enabled, a compact status shows whether Truex is waiting for the wake phrase, capturing a command, working, awaiting an answer, or unable to listen. A persistent setting lets the user disable listening.
3. Saying Hey Truex activates an overlay immediately. Saying Hey Truex followed directly by a command must work without requiring a deliberate pause.
4. The overlay shows the recognized command. Partial transcripts never execute actions.
5. Truex performs the action and updates the actual application view or conversation. Success is shown only after the existing handler or API confirms it.
6. After completion, cancellation, or a bounded period without a command, Truex returns to wake-word listening when enabled.

Examples:

- Hey Truex, start a new conversation with the General Agent.
- Hey Truex, open my latest conversation.
- Hey Truex, summarize the document attached to this conversation.
- Hey Truex, create a presentation about this plan.
- Hey Truex, show connected tools.
- Hey Truex, stop the current response.

## Scope and capability routing

Voice is another input path into Truex. It must preserve the same authentication, tenant boundaries, agent access, configured tools, validation, and approval policies as ordinary application use.

- **Application controls:** resolve supported commands to an explicit action catalog bound to existing handlers: new conversation, agent selection, conversation navigation, available panels, stopping a turn, and existing conversation/settings operations where exposed. Enumerate actual handlers before implementation; do not enable disabled slash commands as a shortcut.
- **Assistant tasks:** dispatch recognized requests through the existing chat submission path. This preserves research, document creation, visualizations, goals, and configured connector capabilities without duplicating their implementation.
- **Follow-up answers:** address the current question or approval using its existing typed response contract. Clarify ambiguous options visually; do not interpret generic speech as permission for an unrelated action. Secret inputs remain in the existing secure form.
- **Ambiguous targets:** show choices when agent, conversation, document, or recipient names cannot be resolved uniquely. Never invent an ID or guess a recipient.
- **State-changing actions:** preserve existing approvals; require review for sensitive application controls that do not already have an approval path. A spoken confirmation must reference a single visible pending action and expire when its context changes. Voice cannot silently grant persistent approval or enable Autopilot.

Capabilities still depend on the selected agent, permissions, configured services, and available attachments. Voice cannot access arbitrary device files; an upload command may open the existing file picker but cannot bypass browser file-selection rules.

Out of scope: listening after the application closes, system-wide device control, replacing Siri, spoken output, speaker authentication, and adding capabilities that Truex does not already provide.

## Existing architecture and smallest change

Current flow: frontend input validation and submission in `frontend/app/page.tsx` → same-origin frontend forwarding → platform authentication/configuration/session APIs → agent-core execution → persisted messages and streamed events → existing conversation UI.

Relevant existing sources:

- `frontend/app/page.tsx`: workspace ownership, navigation, agent selection, message dispatch, stopping, and conversation commands.
- `frontend/lib/composer-submission.ts`: draft ownership and confirmed approval state.
- `frontend/lib/request-input.ts`: questions, option labels, answer payloads, and expiry behavior.
- `frontend/lib/api.ts` and `frontend/lib/transport.ts`: authenticated requests, stale identity protection, and message transport.
- `frontend/lib/slash-commands.ts`: command semantics; its UI feature is currently disabled.
- `platform/src/app/platform-service.ts`: session ownership and runtime routing.

Add a client-side listening controller, a visual overlay, and explicit command routing. Keep business execution in current handlers and backend services. Add a transcription API only if the selected recognition approach requires one. No database migration, agent runtime rewrite, or general browser automation is required by this specification.

## Audio and lifecycle contract

- Detect the wake phrase locally on the device. Idle listening must not continuously upload room audio or run full speech transcription.
- Start command recognition after activation. Use only a bounded in-memory audio buffer if needed to preserve speech immediately following the wake phrase; clear it after use.
- Initial bounds: wait at most 8 seconds for speech after activation and capture at most 30 seconds per command. These are proposed limits, not measured performance claims.
- No raw audio persistence or raw transcript logging. Submitted task text follows existing conversation storage rules.
- One listening owner per browser profile/origin across Truex tabs, with safe ownership transfer and no simultaneous command dispatch.
- Cancel pending capture, interpretation, and confirmation when the user signs out or switches identity/workspace. Bind asynchronous results to the originating identity and view generation.
- Release media tracks and audio workers on disable, unmount, and teardown. Handle revoked permissions, disconnected devices, and failed model loading visibly.
- Open tabs may be suspended by the browser. Do not show Listening when processing has stopped, replay stale captured commands after resume, or promise background availability without runtime evidence.

## Failure and security behavior

- Silence, incomplete recognition, unsupported commands, and ambiguous targets perform no action and show a recoverable explanation.
- Wake detections, interim recognition events, and repeated final callbacks cannot execute the same captured command twice.
- Reuse existing message client IDs and dispatch receipts. An uncertain submission result shows uncertainty and is not blindly retried.
- Existing active-turn behavior is respected. Require an explicit instruction before treating a voice request as steering a running turn.
- Switching conversation during recognition invalidates context-dependent actions rather than applying them to the newly selected conversation.
- A detected wake phrase establishes intent to listen, not identity or authorization. Spoken input is untrusted and cannot override backend permissions.
- Provider credentials stay server-side. Select a wake engine whose client deployment and licensing are compatible with the application; never put a secret credential into a public bundle.
- Emit bounded, non-content diagnostics for listening failures and action outcomes using existing observability conventions. Record durations and error categories without audio or dictated content.

## Technology decisions to resolve

1. Choose and test a genuine local wake-word engine and a Hey Truex model. Custom phrase detection requires a suitable model; matching continuously transcribed text is not equivalent to the required design.
2. Choose command speech recognition. Browser recognition is a candidate for a verified browser target; broader support may require an authenticated transcription service. Existing text-model configuration does not prove audio support.
3. Confirm production licensing, model distribution, credential requirements, and provider audio handling before adding dependencies.

References: [Porcupine Web SDK](https://picovoice.ai/docs/quick-start/porcupine-web/), [microphone permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [browser page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api), [speech recognition support](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition). Porcupine is a researched candidate, not an approved dependency or credential design.

## Code style and project structure

Use TypeScript and existing React conventions. Put pure routing/state helpers in `frontend/lib/`, UI in `frontend/components/`, and Node tests in `frontend/test/`. Read the installed Next.js documentation required by `frontend/AGENTS.md` before changing application code.

Use explicit states and action types rather than loosely structured model output. For example:

```ts
type VoiceState =
  | { kind: "disabled" }
  | { kind: "waiting" }
  | { kind: "capturing"; captureId: string }
  | { kind: "working"; captureId: string }
  | { kind: "needsAnswer"; requestId: string }
  | { kind: "unavailable"; message: string };
```

This illustrates style; the final contract must include lifecycle and context protection discovered during implementation.

## Testing and success criteria

- Unit tests cover routing, unsupported/ambiguous requests, bounded capture, cancellation, repeated callbacks, stale contexts, confirmation expiry, and listener ownership.
- Integration tests prove voice submission reuses current validation, approval state, client IDs, first-message receipts, and uncertain-delivery behavior.
- Browser tests verify permission denied/revoked, device removal, disabled listening, multiple tabs, suspension/resume, overlay accessibility, and navigation during recognition.
- Real microphone testing proves Hey Truex activates the overlay and a directly following command is not lost. Measure false activations, missed activations, wake-to-overlay latency, command-to-dispatch latency, CPU, and memory under quiet and noisy conditions. Synthetic audio fixtures complement but do not replace live microphone validation.
- Idle listening sends no room audio to a server. Disabling it releases microphone access. No output audio is generated.
- New conversation, existing conversation navigation, an assistant task using an attachment, a supported tool task, stop, and a follow-up question are exercised against actual application state. Provider fixtures cannot certify live connector results.
- One command produces at most one dispatch. Failure never displays success, changes permissions, or executes in a different workspace.

Required commands for implementation validation:

```sh
npm --prefix frontend test
npm --prefix frontend run typecheck
npm run codex:verify
npm run protocol:gen
npm test
npm run check:secrets
npm run format:check
npm run build
```

Run additional integration checks if transcription adds a backend surface. Report pre-existing failures separately; never weaken checks to pass.

## Boundaries and rollout

- Always reuse existing execution paths, validate command input, preserve authorization, test real audio, and review the final diff.
- Review this specification before the implementation plan. Resolve provider/model selection before introducing its dependency or credentials.
- Never bypass microphone permission, log ambient audio, invent missing capabilities, remove failing tests, or silently retry uncertain writes.
- Start as opt-in hands-free control. Disabling the feature restores the existing interaction path without a data migration. Release only after the supported browser/device matrix and measured listening behavior are documented.

## Open questions

- Does the proposed desktop Chrome/English validation baseline match the initial users, or are mobile/other languages required immediately?
- Which local wake-word model and command-recognition provider meet the verified deployment constraints? Resolve through a small technical validation before promising a release.
