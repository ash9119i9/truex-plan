# Verified protocol inventory

Generated from Codex revision `4a942885c8b4745757a9f86ad2075e16c42483c5` with `codex-cli 0.0.0`. Types and JSON schemas are generated, not transcribed. Regenerate: `npm run protocol:gen` (uses only the pinned vendor/codex build). The binary is built inside vendor/codex using npm run codex:setup; no global or sibling binary is used.

Each schema in shared/schema documents full parameters and results. Experimental labels here identify method-level source annotations; field-level gating remains in generated types and runtime validation.

## Client requests

| Method | Params schema | Result schema | Priority | Method experimental |
|---|---|---|---|---|
| initialize | InitializeParams | — | Basic | — |
| server/diagnostics | ServerDiagnosticsParams | ServerDiagnosticsResponse | Additive | Yes |
| thread/start | ThreadStartParams | ThreadStartResponse | Basic | — |
| thread/resume | ThreadResumeParams | ThreadResumeResponse | Basic | — |
| thread/fork | ThreadForkParams | ThreadForkResponse | Additive | — |
| thread/archive | ThreadArchiveParams | ThreadArchiveResponse | Additive | — |
| thread/delete | ThreadDeleteParams | ThreadDeleteResponse | Additive | — |
| thread/unsubscribe | ThreadUnsubscribeParams | ThreadUnsubscribeResponse | Additive | — |
| thread/increment_elicitation | ThreadIncrementElicitationParams | ThreadIncrementElicitationResponse | Additive | Yes |
| thread/decrement_elicitation | ThreadDecrementElicitationParams | ThreadDecrementElicitationResponse | Additive | Yes |
| thread/name/set | ThreadSetNameParams | ThreadSetNameResponse | Additive | — |
| thread/goal/set | ThreadGoalSetParams | ThreadGoalSetResponse | Additive | — |
| thread/goal/get | ThreadGoalGetParams | ThreadGoalGetResponse | Additive | — |
| thread/goal/clear | ThreadGoalClearParams | ThreadGoalClearResponse | Additive | — |
| thread/queue/add | ThreadQueueAddParams | ThreadQueueAddResponse | Additive | Yes |
| thread/queue/list | ThreadQueueListParams | ThreadQueueListResponse | Additive | Yes |
| thread/queue/update | ThreadQueueUpdateParams | ThreadQueueUpdateResponse | Additive | Yes |
| thread/queue/delete | ThreadQueueDeleteParams | ThreadQueueDeleteResponse | Additive | Yes |
| thread/queue/reorder | ThreadQueueReorderParams | ThreadQueueReorderResponse | Additive | Yes |
| thread/queue/start | ThreadQueueStartParams | ThreadQueueStartResponse | Additive | Yes |
| thread/metadata/update | ThreadMetadataUpdateParams | ThreadMetadataUpdateResponse | Additive | — |
| thread/section/move | ThreadSectionMoveParams | ThreadSectionMoveResponse | Additive | — |
| thread/settings/update | ThreadSettingsUpdateParams | ThreadSettingsUpdateResponse | Additive | Yes |
| thread/memoryMode/set | ThreadMemoryModeSetParams | ThreadMemoryModeSetResponse | Additive | Yes |
| memory/reset | undefined | MemoryResetResponse | Additive | Yes |
| thread/unarchive | ThreadUnarchiveParams | ThreadUnarchiveResponse | Additive | — |
| thread/compact/start | ThreadCompactStartParams | ThreadCompactStartResponse | Additive | — |
| thread/shellCommand | ThreadShellCommandParams | ThreadShellCommandResponse | Additive | — |
| thread/approveGuardianDeniedAction | ThreadApproveGuardianDeniedActionParams | ThreadApproveGuardianDeniedActionResponse | Additive | — |
| thread/backgroundTerminals/clean | ThreadBackgroundTerminalsCleanParams | ThreadBackgroundTerminalsCleanResponse | Additive | Yes |
| thread/backgroundTerminals/list | ThreadBackgroundTerminalsListParams | ThreadBackgroundTerminalsListResponse | Additive | Yes |
| thread/backgroundTerminals/terminate | ThreadBackgroundTerminalsTerminateParams | ThreadBackgroundTerminalsTerminateResponse | Additive | Yes |
| thread/rollback | ThreadRollbackParams | ThreadRollbackResponse | Additive | — |
| thread/revert | ThreadRevertParams | ThreadRevertResponse | Additive | Yes |
| thread/list | ThreadListParams | ThreadListResponse | Additive | — |
| project/list | ProjectListParams | ProjectListResponse | Additive | Yes |
| project/read | ProjectReadParams | ProjectReadResponse | Additive | Yes |
| project/create | ProjectCreateParams | ProjectCreateResponse | Additive | Yes |
| project/import | ProjectImportParams | ProjectImportResponse | Additive | Yes |
| project/update | ProjectUpdateParams | ProjectUpdateResponse | Additive | Yes |
| project/move | ProjectMoveParams | ProjectMoveResponse | Additive | Yes |
| project/delete | ProjectDeleteParams | ProjectDeleteResponse | Additive | Yes |
| threadSection/list | ThreadSectionListParams | ThreadSectionListResponse | Additive | — |
| threadSection/create | ThreadSectionCreateParams | ThreadSectionCreateResponse | Additive | — |
| threadSection/update | ThreadSectionUpdateParams | ThreadSectionUpdateResponse | Additive | — |
| threadSection/delete | ThreadSectionDeleteParams | ThreadSectionDeleteResponse | Additive | — |
| thread/search | ThreadSearchParams | ThreadSearchResponse | Additive | Yes |
| thread/searchOccurrences | ThreadSearchOccurrencesParams | ThreadSearchOccurrencesResponse | Additive | Yes |
| thread/loaded/list | ThreadLoadedListParams | ThreadLoadedListResponse | Additive | — |
| thread/read | ThreadReadParams | ThreadReadResponse | Additive | — |
| thread/turns/list | ThreadTurnsListParams | ThreadTurnsListResponse | Additive | Yes |
| thread/items/list | ThreadItemsListParams | ThreadItemsListResponse | Additive | Yes |
| thread/inject_items | ThreadInjectItemsParams | ThreadInjectItemsResponse | Additive | — |
| skills/list | SkillsListParams | SkillsListResponse | Additive | — |
| skills/extraRoots/set | SkillsExtraRootsSetParams | SkillsExtraRootsSetResponse | Additive | — |
| hooks/list | HooksListParams | HooksListResponse | Additive | — |
| marketplace/add | MarketplaceAddParams | MarketplaceAddResponse | Additive | — |
| marketplace/remove | MarketplaceRemoveParams | MarketplaceRemoveResponse | Additive | — |
| marketplace/upgrade | MarketplaceUpgradeParams | MarketplaceUpgradeResponse | Additive | — |
| plugin/list | PluginListParams | PluginListResponse | Additive | — |
| plugin/search | PluginSearchParams | PluginSearchResponse | Additive | Yes |
| plugin/installed | PluginInstalledParams | PluginInstalledResponse | Additive | — |
| plugin/read | PluginReadParams | PluginReadResponse | Additive | — |
| plugin/skill/read | PluginSkillReadParams | PluginSkillReadResponse | Additive | — |
| plugin/share/save | PluginShareSaveParams | PluginShareSaveResponse | Additive | — |
| plugin/share/updateTargets | PluginShareUpdateTargetsParams | PluginShareUpdateTargetsResponse | Additive | — |
| plugin/share/list | PluginShareListParams | PluginShareListResponse | Additive | — |
| plugin/share/checkout | PluginShareCheckoutParams | PluginShareCheckoutResponse | Additive | — |
| plugin/share/delete | PluginShareDeleteParams | PluginShareDeleteResponse | Additive | — |
| app/read | AppsReadParams | AppsReadResponse | Additive | — |
| app/list | AppsListParams | AppsListResponse | Additive | — |
| app/installed | AppsInstalledParams | AppsInstalledResponse | Additive | — |
| fs/readFile | FsReadFileParams | FsReadFileResponse | Additive | — |
| fs/writeFile | FsWriteFileParams | FsWriteFileResponse | Additive | — |
| fs/createDirectory | FsCreateDirectoryParams | FsCreateDirectoryResponse | Additive | — |
| fs/getMetadata | FsGetMetadataParams | FsGetMetadataResponse | Additive | — |
| fs/readDirectory | FsReadDirectoryParams | FsReadDirectoryResponse | Additive | — |
| fs/remove | FsRemoveParams | FsRemoveResponse | Additive | — |
| fs/copy | FsCopyParams | FsCopyResponse | Additive | — |
| fs/watch | FsWatchParams | FsWatchResponse | Additive | — |
| fs/unwatch | FsUnwatchParams | FsUnwatchResponse | Additive | — |
| skills/config/write | SkillsConfigWriteParams | SkillsConfigWriteResponse | Additive | — |
| plugin/install | PluginInstallParams | PluginInstallResponse | Additive | — |
| plugin/uninstall | PluginUninstallParams | PluginUninstallResponse | Additive | — |
| turn/start | TurnStartParams | TurnStartResponse | Basic | — |
| turn/steer | TurnSteerParams | TurnSteerResponse | Basic | — |
| turn/interrupt | TurnInterruptParams | TurnInterruptResponse | Basic | — |
| thread/realtime/start | ThreadRealtimeStartParams | ThreadRealtimeStartResponse | Additive | Yes |
| thread/realtime/appendAudio | ThreadRealtimeAppendAudioParams | ThreadRealtimeAppendAudioResponse | Additive | Yes |
| thread/realtime/appendText | ThreadRealtimeAppendTextParams | ThreadRealtimeAppendTextResponse | Additive | Yes |
| thread/realtime/appendSpeech | ThreadRealtimeAppendSpeechParams | ThreadRealtimeAppendSpeechResponse | Additive | Yes |
| thread/realtime/stop | ThreadRealtimeStopParams | ThreadRealtimeStopResponse | Additive | Yes |
| thread/realtime/listVoices | ThreadRealtimeListVoicesParams | ThreadRealtimeListVoicesResponse | Additive | Yes |
| review/start | ReviewStartParams | ReviewStartResponse | Additive | — |
| model/list | ModelListParams | ModelListResponse | Additive | — |
| modelProvider/capabilities/read | ModelProviderCapabilitiesReadParams | ModelProviderCapabilitiesReadResponse | Additive | — |
| experimentalFeature/list | ExperimentalFeatureListParams | ExperimentalFeatureListResponse | Additive | — |
| permissionProfile/list | PermissionProfileListParams | PermissionProfileListResponse | Additive | — |
| experimentalFeature/enablement/set | ExperimentalFeatureEnablementSetParams | ExperimentalFeatureEnablementSetResponse | Additive | — |
| remoteControl/enable | RemoteControlEnableParams | RemoteControlEnableResponse | Additive | Yes |
| remoteControl/disable | RemoteControlDisableParams | RemoteControlDisableResponse | Additive | Yes |
| remoteControl/status/read | undefined | RemoteControlStatusReadResponse | Additive | Yes |
| remoteControl/pairing/start | RemoteControlPairingStartParams | RemoteControlPairingStartResponse | Additive | Yes |
| remoteControl/pairing/status | RemoteControlPairingStatusParams | RemoteControlPairingStatusResponse | Additive | Yes |
| remoteControl/client/list | RemoteControlClientsListParams | RemoteControlClientsListResponse | Additive | Yes |
| remoteControl/client/revoke | RemoteControlClientsRevokeParams | RemoteControlClientsRevokeResponse | Additive | Yes |
| collaborationMode/list | CollaborationModeListParams | CollaborationModeListResponse | Additive | Yes |
| mock/experimentalMethod | MockExperimentalMethodParams | MockExperimentalMethodResponse | Additive | Yes |
| environment/add | EnvironmentAddParams | EnvironmentAddResponse | Additive | Yes |
| environment/info | EnvironmentInfoParams | EnvironmentInfoResponse | Additive | Yes |
| environment/status | EnvironmentStatusParams | EnvironmentStatusResponse | Additive | Yes |
| mcpServer/oauth/login | McpServerOauthLoginParams | McpServerOauthLoginResponse | Additive | — |
| config/mcpServer/reload | undefined | McpServerRefreshResponse | Additive | — |
| mcpServerStatus/list | ListMcpServerStatusParams | ListMcpServerStatusResponse | Additive | — |
| mcpServer/resource/read | McpResourceReadParams | McpResourceReadResponse | Additive | — |
| mcpServer/tool/call | McpServerToolCallParams | McpServerToolCallResponse | Additive | — |
| windowsSandbox/setupStart | WindowsSandboxSetupStartParams | WindowsSandboxSetupStartResponse | Additive | — |
| windowsSandbox/readiness | undefined | WindowsSandboxReadinessResponse | Additive | — |
| account/login/start | LoginAccountParams | LoginAccountResponse | Additive | — |
| account/bedrock/discover | BedrockDiscoverParams | BedrockDiscoverResponse | Additive | Yes |
| account/bedrock/setup | BedrockSetupParams | BedrockSetupResponse | Additive | Yes |
| account/login/cancel | CancelLoginAccountParams | CancelLoginAccountResponse | Additive | — |
| account/logout | undefined | LogoutAccountResponse | Additive | — |
| account/rateLimits/read | undefined | GetAccountRateLimitsResponse | Additive | — |
| account/rateLimitResetCredit/consume | ConsumeAccountRateLimitResetCreditParams | ConsumeAccountRateLimitResetCreditResponse | Additive | — |
| account/workspaceMessages/read | undefined | GetWorkspaceMessagesResponse | Additive | — |
| account/sendAddCreditsNudgeEmail | SendAddCreditsNudgeEmailParams | SendAddCreditsNudgeEmailResponse | Additive | — |
| feedback/upload | FeedbackUploadParams | FeedbackUploadResponse | Additive | — |
| command/exec | CommandExecParams | CommandExecResponse | Additive | — |
| command/exec/write | CommandExecWriteParams | CommandExecWriteResponse | Additive | — |
| command/exec/terminate | CommandExecTerminateParams | CommandExecTerminateResponse | Additive | — |
| command/exec/resize | CommandExecResizeParams | CommandExecResizeResponse | Additive | — |
| process/spawn | ProcessSpawnParams | ProcessSpawnResponse | Additive | Yes |
| process/writeStdin | ProcessWriteStdinParams | ProcessWriteStdinResponse | Additive | Yes |
| process/kill | ProcessKillParams | ProcessKillResponse | Additive | Yes |
| process/resizePty | ProcessResizePtyParams | ProcessResizePtyResponse | Additive | Yes |
| config/read | ConfigReadParams | ConfigReadResponse | Additive | — |
| externalAgentConfig/detect | ExternalAgentConfigDetectParams | ExternalAgentConfigDetectResponse | Additive | — |
| externalAgentConfig/import | ExternalAgentConfigImportParams | ExternalAgentConfigImportResponse | Additive | — |
| externalAgentConfig/import/recordHistory | ExternalAgentConfigImportHistoryRecordParams | ExternalAgentConfigImportHistoryRecordResponse | Additive | — |
| externalAgentConfig/import/readHistories | undefined | ExternalAgentConfigImportHistoriesReadResponse | Additive | — |
| config/value/write | ConfigValueWriteParams | ConfigWriteResponse | Additive | — |
| config/batchWrite | ConfigBatchWriteParams | ConfigWriteResponse | Additive | — |
| configRequirements/read | undefined | ConfigRequirementsReadResponse | Additive | — |
| account/read | GetAccountParams | GetAccountResponse | Additive | — |
| getConversationSummary | GetConversationSummaryParams | GetConversationSummaryResponse | Additive | — |
| gitDiffToRemote | GitDiffToRemoteParams | GitDiffToRemoteResponse | Additive | — |
| getAuthStatus | GetAuthStatusParams | GetAuthStatusResponse | Additive | — |
| fuzzyFileSearch | FuzzyFileSearchParams | FuzzyFileSearchResponse | Additive | — |
| fuzzyFileSearch/sessionStart | FuzzyFileSearchSessionStartParams | FuzzyFileSearchSessionStartResponse | Additive | Yes |
| fuzzyFileSearch/sessionUpdate | FuzzyFileSearchSessionUpdateParams | FuzzyFileSearchSessionUpdateResponse | Additive | Yes |
| fuzzyFileSearch/sessionStop | FuzzyFileSearchSessionStopParams | FuzzyFileSearchSessionStopResponse | Additive | Yes |

## Server notifications

| Method | Params schema | Result schema | Priority | Method experimental |
|---|---|---|---|---|
| error | ErrorNotification | — | Basic | — |
| thread/started | ThreadStartedNotification | — | Basic | — |
| thread/status/changed | ThreadStatusChangedNotification | — | Additive | — |
| thread/archived | ThreadArchivedNotification | — | Additive | — |
| thread/deleted | ThreadDeletedNotification | — | Additive | — |
| thread/unarchived | ThreadUnarchivedNotification | — | Additive | — |
| thread/closed | ThreadClosedNotification | — | Additive | — |
| thread/reverted | ThreadRevertedNotification | — | Additive | Yes |
| skills/changed | SkillsChangedNotification | — | Additive | — |
| thread/name/updated | ThreadNameUpdatedNotification | — | Additive | — |
| thread/goal/updated | ThreadGoalUpdatedNotification | — | Additive | — |
| thread/goal/cleared | ThreadGoalClearedNotification | — | Additive | — |
| thread/queue/changed | ThreadQueueChangedNotification | — | Additive | Yes |
| project/changed | ProjectChangedNotification | — | Additive | Yes |
| thread/project/updated | ThreadProjectUpdatedNotification | — | Additive | Yes |
| thread/environment/connected | EnvironmentConnectionNotification | — | Additive | Yes |
| thread/environment/disconnected | EnvironmentConnectionNotification | — | Additive | Yes |
| thread/settings/updated | ThreadSettingsUpdatedNotification | — | Additive | Yes |
| thread/tokenUsage/updated | ThreadTokenUsageUpdatedNotification | — | Additive | — |
| turn/started | TurnStartedNotification | — | Basic | — |
| hook/started | HookStartedNotification | — | Additive | — |
| turn/completed | TurnCompletedNotification | — | Basic | — |
| hook/completed | HookCompletedNotification | — | Additive | — |
| turn/diff/updated | TurnDiffUpdatedNotification | — | Additive | — |
| turn/plan/updated | TurnPlanUpdatedNotification | — | Additive | — |
| item/started | ItemStartedNotification | — | Basic | — |
| item/autoApprovalReview/started | ItemGuardianApprovalReviewStartedNotification | — | Additive | — |
| item/autoApprovalReview/completed | ItemGuardianApprovalReviewCompletedNotification | — | Additive | — |
| autoApprovalReview/strictReviewRequired | StrictReviewRequiredNotification | — | Additive | Yes |
| item/completed | ItemCompletedNotification | — | Basic | — |
| rawResponseItem/completed | RawResponseItemCompletedNotification | — | Additive | — |
| rawResponse/completed | RawResponseCompletedNotification | — | Additive | — |
| item/agentMessage/delta | AgentMessageDeltaNotification | — | Basic | — |
| item/plan/delta | PlanDeltaNotification | — | Additive | — |
| command/exec/outputDelta | CommandExecOutputDeltaNotification | — | Additive | — |
| process/outputDelta | ProcessOutputDeltaNotification | — | Additive | Yes |
| process/exited | ProcessExitedNotification | — | Additive | Yes |
| item/commandExecution/outputDelta | CommandExecutionOutputDeltaNotification | — | Additive | — |
| item/commandExecution/terminalInteraction | TerminalInteractionNotification | — | Additive | — |
| item/fileChange/outputDelta | FileChangeOutputDeltaNotification | — | Additive | — |
| item/fileChange/patchUpdated | FileChangePatchUpdatedNotification | — | Additive | — |
| serverRequest/resolved | ServerRequestResolvedNotification | — | Additive | — |
| item/mcpToolCall/progress | McpToolCallProgressNotification | — | Additive | — |
| mcpServer/oauthLogin/completed | McpServerOauthLoginCompletedNotification | — | Additive | — |
| mcpServer/startupStatus/updated | McpServerStatusUpdatedNotification | — | Additive | — |
| account/updated | AccountUpdatedNotification | — | Additive | — |
| account/rateLimits/updated | AccountRateLimitsUpdatedNotification | — | Additive | — |
| app/list/updated | AppListUpdatedNotification | — | Additive | — |
| remoteControl/status/changed | RemoteControlStatusChangedNotification | — | Additive | — |
| externalAgentConfig/import/progress | ExternalAgentConfigImportProgressNotification | — | Additive | — |
| externalAgentConfig/import/completed | ExternalAgentConfigImportCompletedNotification | — | Additive | — |
| fs/changed | FsChangedNotification | — | Additive | — |
| item/reasoning/summaryTextDelta | ReasoningSummaryTextDeltaNotification | — | Additive | — |
| item/reasoning/summaryPartAdded | ReasoningSummaryPartAddedNotification | — | Additive | — |
| item/reasoning/textDelta | ReasoningTextDeltaNotification | — | Additive | — |
| thread/compacted | ContextCompactedNotification | — | Additive | — |
| model/rerouted | ModelReroutedNotification | — | Additive | — |
| model/verification | ModelVerificationNotification | — | Additive | — |
| turn/moderationMetadata | TurnModerationMetadataNotification | — | Additive | Yes |
| model/safetyBuffering/updated | ModelSafetyBufferingUpdatedNotification | — | Additive | — |
| warning | WarningNotification | — | Additive | — |
| guardianWarning | GuardianWarningNotification | — | Additive | — |
| deprecationNotice | DeprecationNoticeNotification | — | Additive | — |
| configWarning | ConfigWarningNotification | — | Additive | — |
| fuzzyFileSearch/sessionUpdated | FuzzyFileSearchSessionUpdatedNotification | — | Additive | — |
| fuzzyFileSearch/sessionCompleted | FuzzyFileSearchSessionCompletedNotification | — | Additive | — |
| thread/realtime/started | ThreadRealtimeStartedNotification | — | Additive | Yes |
| thread/realtime/itemAdded | ThreadRealtimeItemAddedNotification | — | Additive | Yes |
| thread/realtime/transcript/delta | ThreadRealtimeTranscriptDeltaNotification | — | Additive | Yes |
| thread/realtime/transcript/done | ThreadRealtimeTranscriptDoneNotification | — | Additive | Yes |
| thread/realtime/outputAudio/delta | ThreadRealtimeOutputAudioDeltaNotification | — | Additive | Yes |
| thread/realtime/sdp | ThreadRealtimeSdpNotification | — | Additive | Yes |
| thread/realtime/error | ThreadRealtimeErrorNotification | — | Additive | Yes |
| thread/realtime/closed | ThreadRealtimeClosedNotification | — | Additive | Yes |
| windows/worldWritableWarning | WindowsWorldWritableWarningNotification | — | Additive | — |
| windowsSandbox/setupCompleted | WindowsSandboxSetupCompletedNotification | — | Additive | — |
| account/login/completed | AccountLoginCompletedNotification | — | Additive | — |

## Server requests

| Method | Params schema | Result schema | Priority | Method experimental |
|---|---|---|---|---|
| item/commandExecution/requestApproval | CommandExecutionRequestApprovalParams | CommandExecutionRequestApprovalResponse | Additive | — |
| item/fileChange/requestApproval | FileChangeRequestApprovalParams | FileChangeRequestApprovalResponse | Additive | — |
| item/tool/requestUserInput | ToolRequestUserInputParams | ToolRequestUserInputResponse | Additive | — |
| mcpServer/elicitation/request | McpServerElicitationRequestParams | McpServerElicitationRequestResponse | Additive | — |
| item/permissions/requestApproval | PermissionsRequestApprovalParams | PermissionsRequestApprovalResponse | Additive | — |
| item/tool/call | DynamicToolCallParams | DynamicToolCallResponse | Additive | — |
| account/chatgptAuthTokens/refresh | ChatgptAuthTokensRefreshParams | ChatgptAuthTokensRefreshResponse | Additive | — |
| attestation/generate | AttestationGenerateParams | AttestationGenerateResponse | Additive | — |
| currentTime/read | CurrentTimeReadParams | CurrentTimeReadResponse | Additive | Yes |
| applyPatchApproval | ApplyPatchApprovalParams | ApplyPatchApprovalResponse | Additive | — |
| execCommandApproval | ExecCommandApprovalParams | ExecCommandApprovalResponse | Additive | — |

## Server-request responses and failures

All successful response shapes are linked by schema name above. JSON-RPC rejection uses `{ id, error: { code, message } }` without a jsonrpc field. Approval decline is a successful result with the variant-specific denial, not a generic RPC error. Unsupported host capabilities return -32601 promptly. Invalid client answers return HTTP 400 and leave the runtime request pending until a valid answer or expiry. See `agent-core/src/requests.ts` for safe defaults.

## Verification limits

Generated schemas establish shape, not provider behavior, load capacity, or workspace durability. Tests and runtime evidence are tracked in docs/VALIDATION.md.

## Verified backend limitation

At this pin, the default history backend rejects `thread/items/list` with -32601. The adapter falls back to `thread/read` with `includeTurns: true`; the fallback is covered by real-runtime and HTTP integration tests. Feature presence in a schema does not imply availability in every backend.
