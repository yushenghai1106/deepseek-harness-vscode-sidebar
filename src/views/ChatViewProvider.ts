import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import { ApprovalManager } from '../approvals/ApprovalManager.ts'
import { ContextBridge } from '../context/ContextBridge.ts'
import type { HarnessAdapter } from '../harness/HarnessAdapter.ts'
import { HarnessRuntimeManager } from '../runtime/HarnessRuntimeManager.ts'
import type { HarnessCommand, HarnessEvent, PluginInfo, SessionSummary, SettingsState, WebviewState, WebviewToExtensionMessage } from '../shared/protocol.ts'

interface FileSnapshot {
  path: string
  sessionId: string
  before?: string
  after?: string
  decision?: 'kept' | 'reverted'
  /** Hydrated snapshots stay lazy: their content is read from these files only when a diff is actually opened. */
  files?: { before?: string; after?: string }
}

const SESSION_KEY = 'deepseekHarness.sessions.v2'
const FILE_CHANGE_KEY = 'deepseekHarness.fileChanges.v1'
const MAX_PRESENTATION_EVENTS = 5_000
const HISTORY_PAGE_SIZE = 200
const MAX_FILE_SNAPSHOTS = 200
const MAX_PERSISTED_CHANGES = 500
const MAX_TEXT_SNAPSHOT_BYTES = 2 * 1024 * 1024
const STATE_FLUSH_DELAY_MS = 120
const GIT_REFRESH_DELAY_MS = 1_000
const execFileAsync = promisify(execFile)
interface PersistedFileChange { callId: string; sessionId: string; path: string; beforeFile?: string; afterFile?: string; decision?: 'kept' | 'reverted' }

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined
  private readonly contextBridge = new ContextBridge()
  private readonly approvals: ApprovalManager
  private sessions: SessionSummary[]
  private commands: HarnessCommand[] = []
  private plugins: PluginInfo[] = []
  private activeSessionId: string | undefined
  private events: HarnessEvent[] = []
  private historyLoading = false
  private historyHasMore = false
  private historyLoadingMore = false
  private historyAnchor: number | undefined
  private subscription: vscode.Disposable | undefined
  private stateFlushTimer: ReturnType<typeof setTimeout> | undefined
  private gitRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private readonly watchers: vscode.Disposable[] = []
  private activationGeneration = 0
  private settings: SettingsState
  private gitChanges: { path: string; status: string }[] = []
  private trajectoryEvents: Record<string, unknown>[] = []
  private readonly fileSnapshots = new Map<string, FileSnapshot>()
  private persistedChanges: PersistedFileChange[]

  constructor(private readonly context: vscode.ExtensionContext, private readonly runtime: HarnessRuntimeManager) {
    this.sessions = context.globalState.get<SessionSummary[]>(SESSION_KEY, [])
    this.persistedChanges = context.globalState.get<PersistedFileChange[]>(FILE_CHANGE_KEY, [])
    this.activeSessionId = this.sessions[0]?.id
    const config = vscode.workspace.getConfiguration('deepseekHarness')
    this.settings = {
      provider: config.get('provider', 'deepseek-official'), model: config.get('model', 'deepseek-v4-flash'), endpoint: config.get('endpoint', ''), permissionMode: config.get('permissionMode', 'workspace-write'),
      credential: { configured: false, writable: true }, loading: true,
    }
    this.approvals = new ApprovalManager(() => runtime.adapter)
    context.subscriptions.push(runtime.onDidChangeStatus(() => { void this.postState() }))
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => { void this.handle(message) }, undefined, this.context.subscriptions)
    this.installGitWatcher()
    void this.activateStoredSession().catch(error => this.report(error))
  }

  async newSession(): Promise<void> {
    const adapter = await this.runtime.start(), session = await adapter.createSession(), now = Date.now()
    const summary = { id: session.id, title: 'New session', createdAt: now, updatedAt: now }
    this.sessions = [summary, ...this.sessions.filter(item => item.id !== session.id)]
    this.activeSessionId = session.id
    this.events = [{ type: 'session.started', sessionId: session.id }]
    this.historyHasMore = false
    this.historyAnchor = undefined
    this.subscribe(adapter, session.id)
    await this.persist(); await this.postState()
  }

  async restartRuntime(): Promise<void> { await this.runtime.restart(); await this.activateStoredSession() }

  private async forkSession(): Promise<void> {
    if (this.activeSessionId === undefined) return
    const id = await (await this.runtime.start()).forkSession(this.activeSessionId), now = Date.now()
    this.sessions = [{ id, title: 'Fork of current session', createdAt: now, updatedAt: now, parentSessionId: this.activeSessionId }, ...this.sessions]
    this.activeSessionId = id
    await this.activateStoredSession()
  }

  private async exportSession(): Promise<void> {
    if (this.activeSessionId === undefined) return
    const uri = await vscode.window.showSaveDialog({ saveLabel: 'Export Harness session', filters: { JSON: ['json'] }, defaultUri: vscode.Uri.file(`harness-${this.activeSessionId}.json`) })
    if (uri === undefined) return
    const history = await (await this.runtime.start()).history(this.activeSessionId)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ sessionId: this.activeSessionId, events: history }, null, 2), 'utf8'))
  }

  private async deleteSession(): Promise<void> {
    if (this.activeSessionId === undefined) return
    const sessionId = this.activeSessionId
    const session = this.sessions.find(item => item.id === sessionId)
    const confirmed = await vscode.window.showWarningMessage(`Delete session “${session?.title ?? sessionId}”? It will be moved to runtime trash.`, { modal: true }, 'Delete')
    if (confirmed !== 'Delete') return
    if (!await (await this.runtime.start()).deleteSession(sessionId)) throw new Error('Session could not be deleted')
    this.sessions = this.sessions.filter(item => item.id !== sessionId)
    this.activeSessionId = this.sessions[0]?.id
    await this.activateStoredSession()
  }

  async addSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (editor !== undefined) this.contextBridge.addSelection(editor)
    await this.postState(); this.view?.show(true)
  }

  dispose(): void {
    this.subscription?.dispose()
    this.watchers.forEach(watcher => watcher.dispose())
    if (this.stateFlushTimer !== undefined) clearTimeout(this.stateFlushTimer)
    if (this.gitRefreshTimer !== undefined) clearTimeout(this.gitRefreshTimer)
  }

  private async handle(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready': await this.postState(); return
        case 'newSession': await this.newSession(); return
        case 'forkSession': await this.forkSession(); return
        case 'exportSession': await this.exportSession(); return
        case 'deleteSession': await this.deleteSession(); return
        case 'restartRuntime': await this.restartRuntime(); return
        case 'loadTrajectory': await this.loadTrajectory(); return
        case 'loadPlugins': await this.loadPlugins(); return
        case 'attachFiles': await this.contextBridge.chooseAttachments(); await this.postState(); return
        case 'removeAttachment': this.contextBridge.removeAttachment(message.path); await this.postState(); return
        case 'selectSession': await this.selectSession(message.sessionId); return
        case 'renameSession': await this.renameSession(message.sessionId); return
        case 'cancel': if (this.activeSessionId !== undefined) await (await this.runtime.start()).cancel(this.activeSessionId); return
        case 'cancelSubagent': await (await this.runtime.start()).cancel(message.sessionId); return
        case 'approval': await this.approvals.respond(message.sessionId, message.approvalId, message.decision); return
        case 'sendMessage': await this.sendMessage(message.text, message.mode); return
        case 'retryMessage': await this.sendMessage(message.text); return
        case 'steerMessage': await this.steerMessage(message.text); return
        case 'openFile': await this.openFile(message.path, message.line); return
        case 'openDiff': await this.openDiff(message.callId); return
        case 'openGitDiff': await this.openGitDiff(); return
        case 'openGitFileDiff': await this.openGitFileDiff(message.path); return
        case 'keepDiff': await this.reviewDiff(message.callId, 'kept'); return
        case 'revertDiff': await this.reviewDiff(message.callId, 'reverted'); return
        case 'refreshSettings': await this.refreshSettings(); return
        case 'loadMoreHistory': await this.loadMoreHistory(); return
        case 'saveSettings': await this.saveSettings(message); return
        case 'removeApiKey': await this.removeApiKey(); return
      }
    } catch (error) { this.report(error) }
  }

  private async sendMessage(text: string, mode?: string): Promise<void> {
    if (text.trim() === '') return
    if (this.activeSessionId === undefined) await this.newSession()
    const id = this.activeSessionId
    if (id === undefined) return
    const session = this.sessions.find(item => item.id === id)
    if (session !== undefined) {
      session.updatedAt = Date.now()
      if (session.title === 'New session') session.title = text.replaceAll(/\s+/g, ' ').slice(0, 80)
      this.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    await this.persist(); await this.postState()
    const context = await this.contextBridge.capture()
    if (mode !== undefined) context.mode = mode
    await (await this.runtime.start()).sendMessage(id, text, context)
  }

  private async loadPlugins(): Promise<void> {
    this.plugins = await (await this.runtime.start()).listPlugins()
    await this.postState()
  }

  private async selectSession(id: string): Promise<void> {
    if (!this.sessions.some(session => session.id === id)) return
    this.activeSessionId = id
    await this.activateStoredSession()
  }

  private async loadTrajectory(): Promise<void> {
    if (this.activeSessionId === undefined) return
    this.trajectoryEvents = await (await this.runtime.start()).rawHistory(this.activeSessionId)
    await this.postState()
  }

  private async renameSession(id: string): Promise<void> {
    const session = this.sessions.find(item => item.id === id)
    if (session === undefined) return
    const title = await vscode.window.showInputBox({ title: 'Rename session', value: session.title, prompt: 'Enter a short session title' })
    if (title === undefined || title.trim() === '') return
    session.title = title.trim().slice(0, 120)
    await this.persist(); await this.postState()
  }

  private async steerMessage(text: string): Promise<void> {
    if (text.trim() === '' || this.activeSessionId === undefined) return
    await (await this.runtime.start()).steer(this.activeSessionId, text.trim())
  }

  private async openFile(filePath: string, line?: number): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const resolvedPath = path.isAbsolute(filePath) || workspaceRoot === undefined ? filePath : path.join(workspaceRoot, filePath)
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath))
    const editor = await vscode.window.showTextDocument(document, { preview: true })
    if (line !== undefined && line > 0) {
      const position = new vscode.Position(Math.min(line - 1, Math.max(0, document.lineCount - 1)), 0)
      editor.selection = new vscode.Selection(position, position)
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
    }
  }

  private async openDiff(callId: string): Promise<void> {
    const change = this.fileSnapshots.get(callId)
    if (change === undefined) throw new Error('Diff is no longer available')
    const before = await this.readSnapshotSide(change, 'before'), after = await this.readSnapshotSide(change, 'after')
    if (after === undefined) throw new Error('Diff is no longer available')
    const root = this.context.storageUri ?? vscode.Uri.file(path.join(this.context.extensionPath, '.dsh-diffs'))
    await vscode.workspace.fs.createDirectory(root)
    const safe = callId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
    const beforeUri = vscode.Uri.joinPath(root, `${safe}.before`), afterUri = vscode.Uri.joinPath(root, `${safe}.after`)
    await vscode.workspace.fs.writeFile(beforeUri, Buffer.from(before ?? '', 'utf8'))
    await vscode.workspace.fs.writeFile(afterUri, Buffer.from(after, 'utf8'))
    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `${path.basename(change.path)} (DeepSeek change)`)
  }

  private async readSnapshotSide(change: FileSnapshot, side: 'before' | 'after'): Promise<string | undefined> {
    const cached = side === 'before' ? change.before : change.after
    if (cached !== undefined) return cached
    const file = change.files?.[side]
    if (file === undefined) return undefined
    return await fs.readFile(file, 'utf8').catch(() => undefined)
  }

  private async openGitDiff(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd === undefined) throw new Error('Open a workspace before viewing Git diff')
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--'], { cwd, maxBuffer: 4 * 1024 * 1024 })
    const document = await vscode.workspace.openTextDocument({ content: stdout === '' ? 'Working tree is clean.\n' : stdout, language: 'diff' })
    await vscode.window.showTextDocument(document, { preview: true })
  }

  private async openGitFileDiff(filePath: string): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd === undefined) throw new Error('Open a workspace before viewing Git diff')
    const relative = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--', relative], { cwd, maxBuffer: 4 * 1024 * 1024 })
    const document = await vscode.workspace.openTextDocument({ content: stdout === '' ? `No Git diff for ${relative}.\n` : stdout, language: 'diff' })
    await vscode.window.showTextDocument(document, { preview: true })
  }

  private async reviewDiff(callId: string, decision: 'kept' | 'reverted'): Promise<void> {
    const change = this.fileSnapshots.get(callId)
    if (change === undefined || await this.readSnapshotSide(change, 'after') === undefined) throw new Error('Diff is no longer available')
    try { await (await this.runtime.start()).reviewChange(callId, decision) } catch { /* older runtime: use the extension snapshot below */ }
    if (decision === 'reverted') {
      const before = await this.readSnapshotSide(change, 'before')
      // Reverting a file the agent created would otherwise delete it outright — the trash keeps that recoverable.
      if (before === undefined) await vscode.workspace.fs.delete(vscode.Uri.file(change.path), { useTrash: true })
      else await vscode.workspace.fs.writeFile(vscode.Uri.file(change.path), Buffer.from(before, 'utf8'))
    }
    change.decision = decision
    await this.persistFileChange(callId)
    const sessionId = this.activeSessionId
    if (sessionId !== undefined) this.append({ type: 'file.reviewed', sessionId, callId, path: change.path, decision })
  }

  private async activateStoredSession(): Promise<void> {
    const generation = ++this.activationGeneration
    if (this.view === undefined) return
    this.trajectoryEvents = []
    this.historyLoading = true
    this.events = []
    // The conversation itself waits for a complete, coherent history page.
    // Showing a loader and withholding the composer prevents a user action
    // against a session that is still being restored.
    await this.postState()
    const adapter = await this.runtime.start()
    const settingsTask = this.refreshSettings(adapter)
    // The active id is persisted locally. In the normal case it lets the
    // first history page travel while the runtime scans its complete session
    // index, rather than making those two RPCs serial.
    const preferredId = this.activeSessionId
    const preferredDataTask = preferredId === undefined ? undefined : Promise.all([
      adapter.history(preferredId, { limit: HISTORY_PAGE_SIZE }),
      adapter.pendingApprovals(preferredId),
      adapter.sessionStatus(preferredId),
    ])
    const sessions = await adapter.listSessions()
    if (generation !== this.activationGeneration) return
    const localTitles = new Map(this.sessions.map(item => [item.id, item.title]))
    this.sessions = sessions.map(item => ({ ...item, ...(localTitles.get(item.id) === undefined || localTitles.get(item.id) === 'New session' ? {} : { title: localTitles.get(item.id) }) }))
    if (this.activeSessionId === undefined || !sessions.some(item => item.id === this.activeSessionId)) this.activeSessionId = sessions[0]?.id
    const id = this.activeSessionId
    if (id === undefined) {
      this.events = []
      this.historyLoading = false
      await settingsTask; await this.persist(); await this.postState(); return
    }
    const [historyPage, pending, status] = id === preferredId && preferredDataTask !== undefined
      ? await preferredDataTask
      : await Promise.all([adapter.history(id, { limit: HISTORY_PAGE_SIZE }), adapter.pendingApprovals(id), adapter.sessionStatus(id)])
    if (generation !== this.activationGeneration) return
    const history = historyPage.events
    // Only the newest page travels on activate; older turns stay fetchable through the "load earlier" affordance.
    this.historyHasMore = historyPage.hasMore
    this.historyAnchor = historyPage.firstSeq
    const resolved = new Set(history.flatMap(event => event.type === 'approval.resolved' ? [event.approvalId] : []))
    const known = new Set(history.flatMap(event => event.type === 'approval.requested' ? [event.approvalId] : []))
    this.events = [...history, ...pending.filter(event => event.type === 'approval.requested' && !known.has(event.approvalId) && !resolved.has(event.approvalId)), { type: 'status.changed', sessionId: id, status }]
    this.subscribe(adapter, id)
    this.historyLoading = false
    await settingsTask; await this.persist(); await this.postState()
    void this.hydrateChangesAfterFirstPaint(id, generation)
    void this.refreshGitChanges()
    void this.loadCommands(adapter, generation)
  }

  private async hydrateChangesAfterFirstPaint(sessionId: string, generation: number): Promise<void> {
    this.hydrateFileChanges(sessionId)
    if (generation !== this.activationGeneration || sessionId !== this.activeSessionId) return
    const changes = this.persistedChanges.filter(change => change.sessionId === sessionId && this.fileSnapshots.has(change.callId))
    if (changes.length === 0) return
    this.events = [...this.events, ...changes.flatMap(change => [{ type: 'file.changed' as const, sessionId, callId: change.callId, path: change.path }, ...(change.decision === undefined ? [] : [{ type: 'file.reviewed' as const, sessionId, callId: change.callId, path: change.path, decision: change.decision }])])]
    await this.postState()
  }

  private subscribe(adapter: HarnessAdapter, id: string): void {
    this.subscription?.dispose()
    this.subscription = adapter.subscribe(id, event => this.append(event))
  }

  private append(event: HarnessEvent): void {
    if (event.sessionId !== undefined && event.sessionId !== this.activeSessionId) return
    if (event.type === 'session.title') {
      const session = this.sessions.find(item => item.id === event.sessionId)
      if (session !== undefined) session.title = event.title
      void this.persist(); this.scheduleState(); return
    }
    if (event.type === 'tool.started') void this.captureFileBefore(event)
    if (event.type === 'tool.completed') void this.captureFileAfter(event)
    this.events.push(event)
    if (this.events.length > MAX_PRESENTATION_EVENTS) this.events.splice(0, this.events.length - MAX_PRESENTATION_EVENTS)
    void this.view?.webview.postMessage({ type: 'event', event })
  }

  private async captureFileBefore(event: Extract<HarnessEvent, { type: 'tool.started' }>): Promise<void> {
    const target = filePathFromArguments(event.arguments)
    if (target === undefined || !isInsideWorkspace(target)) return
    const before = await this.readTextSnapshot(target)
    this.trackSnapshot(event.callId, { path: target, sessionId: event.sessionId, ...(before === undefined ? {} : { before }) })
    await this.persistFileChange(event.callId)
  }

  private async captureFileAfter(event: Extract<HarnessEvent, { type: 'tool.completed' }>): Promise<void> {
    const current = this.fileSnapshots.get(event.callId)
    if (current === undefined) return
    try {
      const after = await this.readTextSnapshot(current.path)
      if (after === undefined) { this.fileSnapshots.delete(event.callId); return }
      current.after = after
      await this.persistFileChange(event.callId)
      if (current.before !== current.after) this.append({ type: 'file.changed', sessionId: event.sessionId, callId: event.callId, path: current.path })
    } catch { /* created/deleted files are handled in a later pass */ }
  }

  /** Snapshots hold whole file contents, so oversized and binary targets are skipped rather than buffered into memory. */
  private async readTextSnapshot(target: string): Promise<string | undefined> {
    const stat = await fs.stat(target).catch(() => undefined)
    if (stat === undefined || !stat.isFile() || stat.size > MAX_TEXT_SNAPSHOT_BYTES) return undefined
    if (stat.size === 0) return ''
    const handle = await fs.open(target, 'r')
    try {
      const probe = Buffer.alloc(Math.min(stat.size, 8 * 1024))
      const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
      if (probe.subarray(0, bytesRead).includes(0)) return undefined
    } finally { await handle.close() }
    return await fs.readFile(target, 'utf8')
  }

  /** Snapshots grow with every write tool call; keep a bounded window and prefer to evict ones from inactive sessions. */
  private trackSnapshot(callId: string, entry: FileSnapshot): void {
    this.fileSnapshots.set(callId, entry)
    if (this.fileSnapshots.size <= MAX_FILE_SNAPSHOTS) return
    for (const key of this.fileSnapshots.keys()) {
      if (this.fileSnapshots.size <= MAX_FILE_SNAPSHOTS) return
      if (key === callId || this.fileSnapshots.get(key)?.sessionId === this.activeSessionId) continue
      this.fileSnapshots.delete(key)
    }
    const excess = this.fileSnapshots.size - MAX_FILE_SNAPSHOTS
    if (excess <= 0) return
    [...this.fileSnapshots.keys()].slice(0, excess).forEach(key => this.fileSnapshots.delete(key))
  }

  private async persistFileChange(callId: string): Promise<void> {
    const change = this.fileSnapshots.get(callId)
    if (change === undefined) return
    const root = vscode.Uri.joinPath(this.context.globalStorageUri, 'file-changes')
    await vscode.workspace.fs.createDirectory(root)
    const safe = callId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
    const beforeFile = change.before === undefined ? undefined : vscode.Uri.joinPath(root, `${safe}.before`).fsPath
    const afterFile = change.after === undefined ? undefined : vscode.Uri.joinPath(root, `${safe}.after`).fsPath
    if (beforeFile !== undefined) await fs.writeFile(beforeFile, change.before ?? '', 'utf8')
    if (afterFile !== undefined) await fs.writeFile(afterFile, change.after ?? '', 'utf8')
    const entry: PersistedFileChange = { callId, sessionId: change.sessionId, path: change.path, ...(beforeFile === undefined ? {} : { beforeFile }), ...(afterFile === undefined ? {} : { afterFile }), ...(change.decision === undefined ? {} : { decision: change.decision }) }
    // The persisted list is rewritten wholesale, so keep it bounded — otherwise every tool call pays an ever-growing write.
    this.persistedChanges = [...this.persistedChanges.filter(item => item.callId !== callId), entry].slice(-MAX_PERSISTED_CHANGES)
    await this.context.globalState.update(FILE_CHANGE_KEY, this.persistedChanges)
  }

  /** Only metadata is restored here; file contents stay on disk until the user opens a diff. */
  private hydrateFileChanges(sessionId: string): void {
    for (const item of this.persistedChanges.filter(change => change.sessionId === sessionId)) {
      const before = item.beforeFile, after = item.afterFile
      this.trackSnapshot(item.callId, {
        path: item.path, sessionId,
        ...(before === undefined && after === undefined ? {} : { files: { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) } }),
        ...(item.decision === undefined ? {} : { decision: item.decision }),
      })
    }
  }

  private async refreshSettings(adapter?: HarnessAdapter): Promise<void> {
    const config = vscode.workspace.getConfiguration('deepseekHarness')
    this.settings = { ...this.settings, provider: config.get('provider', 'deepseek-official'), model: config.get('model', 'deepseek-v4-flash'), endpoint: config.get('endpoint', ''), permissionMode: config.get('permissionMode', 'workspace-write'), loading: true }
    await this.postState()
    const runtimeAdapter = adapter ?? await this.runtime.start()
    this.settings = { ...this.settings, credential: await runtimeAdapter.credentialStatus(), loading: false }
    await this.postState()
  }

  private async saveSettings(message: Extract<WebviewToExtensionMessage, { type: 'saveSettings' }>): Promise<void> {
    const provider = message.provider.trim(), model = message.model.trim()
    if (provider === '' || model === '') throw new Error('Provider and model are required')
    if (provider !== 'deepseek-official') throw new Error('The bundled runtime currently supports DeepSeek Official only')
    const config = vscode.workspace.getConfiguration('deepseekHarness')
    const endpoint = message.endpoint.trim(), permissionMode = message.permissionMode
    if (endpoint !== '') {
      let parsed: URL
      try { parsed = new URL(endpoint) } catch { throw new Error('API endpoint must be a valid http(s) URL') }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('API endpoint must use http or https')
    }
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(permissionMode)) throw new Error('Invalid permission mode')
    const changedRuntime = provider !== config.get('provider', 'deepseek-official') || model !== config.get('model', 'deepseek-v4-flash') || endpoint !== config.get('endpoint', '') || permissionMode !== config.get('permissionMode', 'workspace-write')
    await Promise.all([config.update('provider', provider, vscode.ConfigurationTarget.Global), config.update('model', model, vscode.ConfigurationTarget.Global), config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global), config.update('permissionMode', permissionMode, vscode.ConfigurationTarget.Global)])
    const adapter = await this.runtime.start()
    const changedCredential = message.apiKey !== undefined && message.apiKey.trim() !== ''
    if (changedCredential) await adapter.setCredential(message.apiKey ?? '')
    if (changedRuntime || changedCredential) await this.runtime.restart()
    await this.activateStoredSession()
  }

  private async removeApiKey(): Promise<void> {
    const adapter = await this.runtime.start()
    await adapter.unsetCredential(); await this.runtime.restart(); await this.activateStoredSession()
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    void vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`)
    this.append({ type: 'error', ...(this.activeSessionId === undefined ? {} : { sessionId: this.activeSessionId }), message })
    void this.postState()
  }

  private persist(): Thenable<void> { return this.context.globalState.update(SESSION_KEY, this.sessions) }

  private postState(): Thenable<boolean> | undefined {
    if (this.stateFlushTimer !== undefined) { clearTimeout(this.stateFlushTimer); this.stateFlushTimer = undefined }
    return this.sendState()
  }

  /**
   * Streaming a turn replays several fields per second, and each state frame carries the whole transcript. Coalescing them
   * into a single frame keeps the bridge from serializing that transcript once per chunk.
   */
  private scheduleState(): void {
    if (this.stateFlushTimer !== undefined) return
    this.stateFlushTimer = setTimeout(() => { this.stateFlushTimer = undefined; void this.sendState() }, STATE_FLUSH_DELAY_MS)
  }

  private sendState(): Thenable<boolean> | undefined {
    const state: WebviewState = {
      runtime: this.runtime.getStatus(), sessions: this.sessions, commands: this.commands, plugins: this.plugins,
      ...(this.activeSessionId === undefined ? {} : { activeSessionId: this.activeSessionId }),
      events: this.events, historyLoading: this.historyLoading, historyHasMore: this.historyHasMore, historyLoadingMore: this.historyLoadingMore,
      trajectoryEvents: this.trajectoryEvents, attachedFiles: this.contextBridge.attachedFiles, settings: this.settings, gitChanges: this.gitChanges,
    }
    return this.view?.webview.postMessage({ type: 'state', state })
  }

  private async loadMoreHistory(): Promise<void> {
    const id = this.activeSessionId
    if (id === undefined || !this.historyHasMore || this.historyLoadingMore || this.historyAnchor === undefined) return
    this.historyLoadingMore = true
    await this.postState()
    try {
      const page = await (await this.runtime.start()).history(id, { limit: HISTORY_PAGE_SIZE, before: this.historyAnchor })
      if (id !== this.activeSessionId) return
      const seen = new Set(page.events.flatMap(event => 'eventSeq' in event && event.eventSeq !== undefined ? [event.eventSeq] : []))
      const retained = this.events.filter(event => !('eventSeq' in event) || event.eventSeq === undefined || !seen.has(event.eventSeq))
      this.events = [...page.events, ...retained]
      this.historyHasMore = page.hasMore
      this.historyAnchor = page.firstSeq
      if (this.events.length > MAX_PRESENTATION_EVENTS) this.events.splice(0, this.events.length - MAX_PRESENTATION_EVENTS)
    } finally {
      this.historyLoadingMore = false
      await this.postState()
    }
  }

  private async loadCommands(adapter: HarnessAdapter, generation: number): Promise<void> {
    try {
      const commands = await adapter.listCommands()
      if (generation !== this.activationGeneration) return
      this.commands = commands
      await this.postState()
    } catch { /* slash commands are an optional runtime capability */ }
  }

  /** Git status is the source of truth for changed files, so keep it fresh while the agent edits the tree. */
  private installGitWatcher(): void {
    if (this.watchers.length > 0) return
    const root = vscode.workspace.workspaceFolders?.[0]
    if (root === undefined) return
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'))
    const schedule = (): void => {
      if (this.gitRefreshTimer !== undefined) clearTimeout(this.gitRefreshTimer)
      this.gitRefreshTimer = setTimeout(() => { this.gitRefreshTimer = undefined; void this.refreshGitChanges() }, GIT_REFRESH_DELAY_MS)
    }
    this.watchers.push(watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule), watcher)
  }

  private async refreshGitChanges(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd === undefined) return
    try {
      const { stdout } = await execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd, maxBuffer: 2 * 1024 * 1024 })
      this.gitChanges = stdout.split('\n').filter(Boolean).flatMap(line => {
        const status = line.slice(0, 2).trim() || '?', file = line.slice(3).trim()
        return file === '' ? [] : [{ path: path.isAbsolute(file) ? file : path.join(cwd, file), status }]
      })
      this.scheduleState()
    } catch { this.gitChanges = [] }
  }

  private html(webview: vscode.Webview): string {
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', 'index.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', 'index.css'))
    const nonce = randomBytes(16).toString('base64')
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`
  }
}

function filePathFromArguments(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      const candidate = record.path ?? record.file_path ?? record.filePath
      return typeof candidate === 'string' ? path.resolve(candidate) : undefined
    }
  } catch { /* non-JSON tool arguments */ }
  return undefined
}

function isInsideWorkspace(target: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) return false
  // Case sensitivity is a filesystem property, so compare the way the current platform resolves paths.
  const insensitive = process.platform === 'darwin' || process.platform === 'win32'
  const normalize = (value: string): string => insensitive ? path.resolve(value).toLowerCase() : path.resolve(value)
  const candidate = normalize(target)
  return folders.some(folder => {
    const relative = path.relative(normalize(folder.uri.fsPath), candidate)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  })
}
