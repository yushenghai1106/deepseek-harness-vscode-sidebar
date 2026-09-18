export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'error'
export interface SessionSummary { id: string; title: string; createdAt: number; updatedAt: number; parentSessionId?: string }
export interface CredentialStatus { configured: boolean; writable: boolean; source?: string }
export interface HarnessCommand { name: string; description: string; inputHint?: string }
export interface PluginInfo { id: string; enabled: boolean; phase: string }
export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export interface SettingsState { provider: string; model: string; endpoint: string; permissionMode: PermissionMode; credential: CredentialStatus; loading: boolean }
export interface PlanItem { content: string; status: 'pending' | 'in_progress' | 'completed' }
export type HarnessEvent =
  | { type: 'session.started'; sessionId: string }
  | { type: 'user.message'; sessionId: string; text: string; eventSeq?: number }
  | { type: 'assistant.started'; sessionId: string; turn: number; step: number }
  | { type: 'assistant.chunk'; sessionId: string; text: string; reasoning: boolean; eventSeq?: number }
  | { type: 'assistant.completed'; sessionId: string; text: string; eventSeq?: number }
  | { type: 'context.usage'; sessionId: string; inputTokens: number; outputTokens?: number; eventSeq?: number }
  | { type: 'tool.started'; sessionId: string; callId: string; name: string; arguments: string; eventSeq?: number }
  | { type: 'tool.completed'; sessionId: string; callId: string; result: string; failed: boolean; eventSeq?: number }
  | { type: 'approval.requested'; sessionId: string; approvalId: string; callId?: string; toolName: string; reason?: string }
  | { type: 'approval.resolved'; sessionId: string; approvalId: string; decision?: string; eventSeq?: number }
  | { type: 'plan.updated'; sessionId: string; items: PlanItem[]; eventSeq?: number }
  | { type: 'subagent.started'; sessionId: string; childSessionId: string }
  | { type: 'subagent.finished'; sessionId: string; childSessionId: string; status: 'ok' | 'error'; stopReason?: string; message?: string }
  | { type: 'goal.updated'; sessionId: string; objective: string; phase: string; roundsStarted?: number; maxGoalRounds?: number; blockedReason?: string; eventSeq?: number }
  | { type: 'file.changed'; sessionId: string; callId: string; path: string }
  | { type: 'file.reviewed'; sessionId: string; callId: string; path: string; decision: 'kept' | 'reverted' }
  | { type: 'session.title'; sessionId: string; title: string; eventSeq?: number }
  | { type: 'status.changed'; sessionId: string; status: 'idle' | 'running' }
  | { type: 'error'; sessionId?: string; message: string }
export interface AgentContext {
  workspace?: { name: string; roots: string[] }
  activeFile?: { path: string; language: string; line: number; column: number }
  selection?: { path: string; startLine: number; endLine: number; text: string }
  tabs: string[]; diagnostics: { path: string; line: number; severity: string; message: string }[]
  git?: { diff: string }; mode?: string; attachments: { path: string; text: string }[]
}
export interface WebviewState {
  runtime: { state: RuntimeState; message?: string; version?: string }; sessions: SessionSummary[]; commands: HarnessCommand[]
  activeSessionId?: string; events: HarnessEvent[]; historyLoading: boolean; historyHasMore: boolean; historyLoadingMore: boolean; trajectoryEvents: Record<string, unknown>[]; plugins: PluginInfo[]; attachedFiles: string[]; settings: SettingsState; gitChanges: { path: string; status: string }[]
}
export type WebviewToExtensionMessage =
  | { type: 'ready' } | { type: 'newSession' } | { type: 'forkSession' } | { type: 'exportSession' } | { type: 'deleteSession' } | { type: 'selectSession'; sessionId: string } | { type: 'renameSession'; sessionId: string }
  | { type: 'sendMessage'; text: string; mode?: string } | { type: 'retryMessage'; text: string } | { type: 'steerMessage'; text: string } | { type: 'openFile'; path: string; line?: number } | { type: 'cancel' } | { type: 'cancelSubagent'; sessionId: string } | { type: 'attachFiles' }
  | { type: 'removeAttachment'; path: string } | { type: 'restartRuntime' }
  | { type: 'loadTrajectory' }
  | { type: 'loadPlugins' }
  | { type: 'openDiff'; callId: string }
  | { type: 'openGitDiff' }
  | { type: 'openGitFileDiff'; path: string }
  | { type: 'keepDiff'; callId: string } | { type: 'revertDiff'; callId: string }
  | { type: 'approval'; sessionId: string; approvalId: string; decision: 'allowed-once' | 'rejected' }
  | { type: 'refreshSettings' }
  | { type: 'loadMoreHistory' }
  | { type: 'saveSettings'; provider: string; model: string; endpoint: string; permissionMode: PermissionMode; apiKey?: string }
  | { type: 'removeApiKey' }
export type ExtensionToWebviewMessage =
  | { type: 'state'; state: WebviewState } | { type: 'event'; event: HarnessEvent }
  | { type: 'runtime'; runtime: WebviewState['runtime'] }
