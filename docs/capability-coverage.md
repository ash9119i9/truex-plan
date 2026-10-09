# Capability coverage

Generated from the project pin. A generic schema-validated relay and inspector are not proof that every capability works with the current provider/backend. Runtime verification remains separate.

| Direction | Method | Implementation | Verification |
|---|---|---|---|
| requests | initialize | Dedicated lifecycle/history handler | See VALIDATION.md; full matrix pending |
| requests | server/diagnostics | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | userVerification/status | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | userVerification/enroll | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | userVerification/delete | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | userVerification/verify | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | userVerification/cancel | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/start | Dedicated lifecycle/history handler | See VALIDATION.md; full matrix pending |
| requests | thread/resume | Dedicated lifecycle/history handler | See VALIDATION.md; full matrix pending |
| requests | thread/fork | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/archive | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/delete | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/unsubscribe | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/increment_elicitation | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/decrement_elicitation | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/name/set | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/prediction/request | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/goal/set | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/goal/get | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/goal/clear | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/queue/add | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/queue/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/queue/update | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/queue/delete | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/queue/reorder | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/queue/start | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/metadata/update | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/attachment/add | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/attachment/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/attachmentOwner/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/attachment/remove | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/section/move | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/settings/update | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/memoryMode/set | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | memory/status | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | memory/reset | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | rollout/compress | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/unarchive | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/compact/start | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/shellCommand | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/approveGuardianDeniedAction | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/backgroundTerminals/clean | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/backgroundTerminals/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/backgroundTerminals/terminate | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/revert | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | project/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | project/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | project/create | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | project/import | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | project/update | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | project/move | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | project/delete | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | threadSection/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | threadSection/create | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | threadSection/update | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | threadSection/delete | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/search | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/searchOccurrences | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/loaded/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/read | Dedicated lifecycle/history handler | See VALIDATION.md; full matrix pending |
| requests | thread/turns/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/items/list | Dedicated lifecycle/history handler | See VALIDATION.md; full matrix pending |
| requests | thread/inject_items | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | skills/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | skills/extraRoots/set | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | hooks/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | marketplace/add | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | marketplace/remove | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | marketplace/upgrade | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/search | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/installed | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/reconcile | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/skill/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/share/save | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/share/updateTargets | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/share/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/share/checkout | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/share/delete | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | app/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | app/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | app/installed | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fs/readFile | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fs/writeFile | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fs/createDirectory | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fs/getMetadata | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fs/readDirectory | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fs/remove | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fs/copy | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fs/watch | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fs/unwatch | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | skills/config/write | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/install | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | plugin/uninstall | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | turn/start | Dedicated lifecycle/history handler | See VALIDATION.md; full matrix pending |
| requests | turn/settings/update | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | turn/steer | Dedicated lifecycle/history handler | See VALIDATION.md; full matrix pending |
| requests | turn/interrupt | Dedicated lifecycle/history handler | See VALIDATION.md; full matrix pending |
| requests | thread/realtime/start | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/realtime/appendAudio | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/realtime/appendText | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/realtime/appendSpeech | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/realtime/stop | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/timeline/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | thread/realtime/listVoices | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | review/start | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | model/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/gatewayOAuth/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/gatewayOAuth/login | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/gatewayOAuth/cancel | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | modelProvider/capabilities/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | experimentalFeature/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | permissionProfile/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | experimentalFeature/enablement/set | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | remoteControl/enable | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | remoteControl/disable | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | remoteControl/status/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | remoteControl/pairing/start | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | remoteControl/pairing/status | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | remoteControl/client/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | remoteControl/client/revoke | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | collaborationMode/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | mock/experimentalMethod | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | environment/add | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | environment/info | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | environment/status | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | mcpServer/oauth/login | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | config/mcpServer/reload | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | mcpServerStatus/list | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | mcpServer/resource/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | mcpServer/event/stream/start | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | mcpServer/event/stream/stop | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | mcpServer/tool/call | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | windowsSandbox/setupStart | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | windowsSandbox/readiness | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/login/start | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/bedrock/discover | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/bedrock/setup | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/bedrock/checkGovCloudRequirements | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/login/cancel | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/logout | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/rateLimitResetCredit/consume | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/workspaceMessages/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/sendAddCreditsNudgeEmail | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | feedback/upload | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | command/exec | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | command/exec/write | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | command/exec/terminate | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | command/exec/resize | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | process/spawn | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | process/writeStdin | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | process/kill | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | process/resizePty | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | config/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | externalAgentConfig/detect | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | externalAgentConfig/import | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | externalAgentConfig/import/recordHistory | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | externalAgentConfig/import/readHistories | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | config/value/write | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | config/batchWrite | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | configRequirements/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | account/read | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | getConversationSummary | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | gitDiffToRemote | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | getAuthStatus | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fuzzyFileSearch | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fuzzyFileSearch/sessionStart | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fuzzyFileSearch/sessionUpdate | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| requests | fuzzyFileSearch/sessionStop | Schema-validated capability relay | See VALIDATION.md; full matrix pending |
| serverRequests | item/commandExecution/requestApproval | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | item/fileChange/requestApproval | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | item/tool/requestUserInput | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | mcpServer/elicitation/request | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | item/permissions/requestApproval | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | item/tool/call | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | account/chatgptAuthTokens/refresh | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | attestation/generate | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | currentTime/read | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | applyPatchApproval | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| serverRequests | execCommandApproval | Variant-specific response or explicit unavailable error | See VALIDATION.md; full matrix pending |
| notifications | error | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/started | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/status/changed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/archived | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/deleted | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/unarchived | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/closed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/reverted | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | skills/changed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/name/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/attachment/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/goal/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/prediction/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/goal/cleared | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/queue/changed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | project/changed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/project/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/environment/connected | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/environment/disconnected | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/settings/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/tokenUsage/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | turn/started | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | hook/started | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | turn/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | hook/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | turn/diff/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | turn/plan/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/started | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/autoApprovalReview/started | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/autoApprovalReview/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | autoApprovalReview/strictReviewRequired | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | rawResponseItem/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | rawResponse/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/agentMessage/delta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/plan/delta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | command/exec/outputDelta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | process/outputDelta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | process/exited | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/commandExecution/outputDelta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/commandExecution/terminalInteraction | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/fileChange/outputDelta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/fileChange/patchUpdated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | serverRequest/resolved | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/mcpToolCall/progress | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | mcpServer/oauthLogin/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | mcpServer/startupStatus/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | mcpServer/event/stream/notification | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | account/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | account/gatewayOAuth/changed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | account/rateLimits/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | app/list/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | remoteControl/status/changed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | externalAgentConfig/import/progress | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | externalAgentConfig/import/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | fs/changed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/reasoning/summaryTextDelta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/reasoning/summaryPartAdded | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | item/reasoning/textDelta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/compacted | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | model/rerouted | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | model/verification | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | modelProvider/authRecoveryStarted | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | modelProvider/authRecoveryCompleted | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | turn/moderationMetadata | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | model/safetyBuffering/updated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | warning | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | guardianWarning | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | deprecationNotice | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | configWarning | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | fuzzyFileSearch/sessionUpdated | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | fuzzyFileSearch/sessionCompleted | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/started | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/itemAdded | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/item/started | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/item/transcript/delta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/item/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/transcript/delta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/transcript/done | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/outputAudio/delta | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/sdp | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/error | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | thread/realtime/closed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | windows/worldWritableWarning | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | windowsSandbox/setupCompleted | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
| notifications | account/login/completed | Mapped event or runtime inspector | See VALIDATION.md; full matrix pending |
