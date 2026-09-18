import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import deepseekLogo from '../../media/deepseek.svg'
import type { ExtensionToWebviewMessage, HarnessCommand, HarnessEvent, WebviewState, WebviewToExtensionMessage } from '../shared/protocol.ts'
import { Conversation } from './components/Conversation.tsx'
import { SettingsPanel } from './components/SettingsPanel.tsx'
import { TrajectoryPanel } from './components/TrajectoryPanel.tsx'
import { PluginMarketPanel } from './components/PluginMarketPanel.tsx'

interface PersistedUiState { draftText: string; agentMode: string; queueingEnabled: boolean }

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToExtensionMessage): void
  getState<T = unknown>(): T | undefined
  setState(state: unknown): void
}
const vscode = acquireVsCodeApi()
const post = (message: WebviewToExtensionMessage): void => post(message)
const MAX_COMMAND_MATCHES = 50
const UI_DEFAULTS: PersistedUiState = { draftText: '', agentMode: 'standard', queueingEnabled: true }
const restoredUiState = (): PersistedUiState => {
  const saved = vscode.getState<Partial<PersistedUiState>>()
  return { ...UI_DEFAULTS, ...(saved ?? {}) }
}
const INITIAL_UI = restoredUiState()
const MODE_OPTIONS = [
  { value: 'standard', label: 'Standard', description: 'Full agent toolset' },
  { value: 'plan', label: 'Plan', description: 'Plan the work before taking action' },
  { value: 'code', label: 'Code', description: 'Code-focused agent runtime' },
  { value: 'minimal', label: 'Minimal', description: 'Minimal shell and editor setup' },
  { value: 'creator', label: 'Creator', description: 'Cordis plugin authoring setup' },
]
const EMPTY: WebviewState = {
  runtime: { state: 'stopped' }, sessions: [], commands: [], events: [], historyLoading: true, trajectoryEvents: [], plugins: [], attachedFiles: [],
  settings: { provider: 'deepseek-official', model: 'deepseek-v4-flash', endpoint: '', permissionMode: 'workspace-write', credential: { configured: false, writable: true }, loading: true }, gitChanges: [],
}

export function App(): JSX.Element {
  const [state, setState] = useState(EMPTY)
  const [text, setText] = useState(INITIAL_UI.draftText)
  const [settingsOpen, setSettingsOpen] = useState(false), [historyOpen, setHistoryOpen] = useState(false), [trajectoryOpen, setTrajectoryOpen] = useState(false), [pluginMarketOpen, setPluginMarketOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false), [modeMenuOpen, setModeMenuOpen] = useState(false), [goalEditorOpen, setGoalEditorOpen] = useState(false), [goalText, setGoalText] = useState('')
  const [queuedMessage, setQueuedMessage] = useState<string | undefined>()
  const [queueMenuOpen, setQueueMenuOpen] = useState(false), [queueingEnabled, setQueueingEnabled] = useState(INITIAL_UI.queueingEnabled)
  const [composerModel, setComposerModel] = useState(EMPTY.settings.model)
  const [agentMode, setAgentMode] = useState(INITIAL_UI.agentMode)
  const [commandIndex, setCommandIndex] = useState(0), [commandDismissed, setCommandDismissed] = useState(false)
  const composer = useRef<HTMLTextAreaElement>(null), addMenu = useRef<HTMLDivElement>(null), queueMenu = useRef<HTMLDivElement>(null), commandMenu = useRef<HTMLDivElement>(null), queueDispatching = useRef(false)

  useEffect(() => {
    const receive = (message: MessageEvent<ExtensionToWebviewMessage>): void => {
      const data = message.data
      if (data.type === 'state') setState(data.state)
      else if (data.type === 'event') setState(current => ({ ...current, events: [...current.events, data.event] }))
      else setState(current => ({ ...current, runtime: data.runtime }))
    }
    window.addEventListener('message', receive)
    post({ type: 'ready' })
    return () => window.removeEventListener('message', receive)
  }, [])

  useEffect(() => { vscode.setState({ draftText: text, agentMode, queueingEnabled }) }, [text, agentMode, queueingEnabled])

  useEffect(() => { setComposerModel(state.settings.model) }, [state.settings.model])

  useEffect(() => {
    if (!addMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!addMenu.current?.contains(event.target as Node)) { setAddMenuOpen(false); setModeMenuOpen(false); setGoalEditorOpen(false) }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [addMenuOpen])

  useEffect(() => {
    if (!queueMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!queueMenu.current?.contains(event.target as Node)) setQueueMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [queueMenuOpen])

  const derived = useMemo(() => {
    const events = state.events
    let running = false, runningChecked = false
    let latestUsage: Extract<HarnessEvent, { type: 'context.usage' }> | undefined
    const changed = new Map<string, Extract<HarnessEvent, { type: 'file.changed' }>>()
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (!runningChecked && event.type === 'status.changed') { running = event.status === 'running'; runningChecked = true }
      if (latestUsage === undefined && event.type === 'context.usage' && event.inputTokens > 0) latestUsage = event
      if (runningChecked && latestUsage !== undefined) break
    }
    for (const event of events) if (event.type === 'file.changed') changed.set(event.path, event)
    return { running, latestUsage, changedFiles: [...changed.values()] }
  }, [state.events])
  const { running, latestUsage, changedFiles } = derived
  const canSend = state.runtime.state !== 'error' && (state.settings.loading || state.settings.credential.configured)
  const estimatedContextTokens = useMemo(() => estimateContextTokens(state.events), [state.events])
  const contextTokens = latestUsage?.inputTokens ?? estimatedContextTokens, contextLimit = 1_000_000, contextPercent = Math.min(100, contextTokens / contextLimit * 100)
  const contextLabel = `${contextPercent.toFixed(1)}% · ${formatTokenCount(contextTokens)} / 1.0M context used${latestUsage === undefined ? ' (estimated)' : ''}`
  const selectedMode = MODE_OPTIONS.find(mode => mode.value === agentMode) ?? { value: 'standard', label: 'Standard', description: 'Full agent toolset' }
  const commandMatches = useMemo(() => {
    const match = /^\/(\S*)$/.exec(text)
    if (match === null) return undefined
    const needle = match[1].toLowerCase()
    return state.commands.filter(command => command.name.toLowerCase().startsWith(needle)).slice(0, MAX_COMMAND_MATCHES)
  }, [text, state.commands])
  const commandCount = commandMatches?.length ?? 0
  const activeCommandIndex = commandCount === 0 ? 0 : Math.min(commandIndex, commandCount - 1)
  const commandMenuOpen = commandCount > 0 && !commandDismissed
  const editDraft = useCallback((value: string): void => { setText(value); composer.current?.focus() }, [])
  const applyCommand = useCallback((command: HarnessCommand): void => { setText(`/${command.name} `); setCommandDismissed(true); composer.current?.focus() }, [])
  useEffect(() => {
    if (running) { queueDispatching.current = false; return }
    if (queuedMessage === undefined || !canSend || queueDispatching.current) return
    queueDispatching.current = true
    setQueuedMessage(undefined)
    post({ type: 'sendMessage', text: queuedMessage })
  }, [running, queuedMessage, canSend])
  const submit = (): void => {
    const value = text.trim()
    if (value === '' || !canSend) return
    if (running && queueingEnabled) {
      setQueuedMessage(value)
      setText('')
      return
    }
    post({ type: 'sendMessage', text: value, mode: agentMode })
    setText('')
    composer.current?.focus()
  }
  if (pluginMarketOpen) return <PluginMarketPanel plugins={state.plugins} onBack={() => setPluginMarketOpen(false)}/>
  if (settingsOpen) {
    return <SettingsPanel state={state.settings} plugins={state.plugins} onBack={() => setSettingsOpen(false)} post={post}/>
  }
  if (trajectoryOpen) return <TrajectoryPanel events={state.events} rawEvents={state.trajectoryEvents} title={state.sessions.find(session => session.id === state.activeSessionId)?.title} onBack={() => setTrajectoryOpen(false)} onExport={() => post({ type: 'exportSession' })}/>

  return <main className="app-shell">
    <header className="app-header">
      <div className="brand"><img className="fish-mark" src={deepseekLogo} alt="DeepSeek"/><span>DeepSeek</span><i className={`status-dot ${state.runtime.state}`} title={state.runtime.message ?? state.runtime.state}/></div>
      <div className="header-actions">
        <button className="icon-button" data-tooltip="New chat" aria-label="New chat" onClick={() => { setHistoryOpen(false); post({ type: 'newSession' }) }}><ToolbarIcon kind="new"/></button>
        <button className="icon-button" data-tooltip="Chat history" aria-label="Chat history" aria-expanded={historyOpen} onClick={() => setHistoryOpen(open => !open)}><ToolbarIcon kind="history"/></button>
        <button className="icon-button" data-tooltip="View trajectory" aria-label="View trajectory" disabled={!state.activeSessionId} onClick={() => { setHistoryOpen(false); setTrajectoryOpen(true); post({ type: 'loadTrajectory' }) }}><ToolbarIcon kind="trajectory"/></button>
        <button className="icon-button" data-tooltip="Plugin marketplace" aria-label="Plugin marketplace" onClick={() => { setHistoryOpen(false); setSettingsOpen(false); setPluginMarketOpen(true); post({ type: 'loadPlugins' }) }}><ToolbarIcon kind="plugins"/></button>
        <button className="icon-button" data-tooltip="Settings" aria-label="Settings" onClick={() => { setPluginMarketOpen(false); setSettingsOpen(true); post({ type: 'refreshSettings' }); post({ type: 'loadPlugins' }) }}><ToolbarIcon kind="settings"/></button>
      </div>
    </header>

    {historyOpen && <section className="history-panel" aria-label="Chat history"><div className="history-panel-header"><strong>Chat history</strong></div><div className="session-list">{state.sessions.length === 0
      ? <small>No chats yet.</small>
      : state.sessions.map(session => <button key={session.id} className={`session-item ${session.id === state.activeSessionId ? 'active' : ''}`} onClick={() => { setHistoryOpen(false); post({ type: 'selectSession', sessionId: session.id }) }}>{session.parentSessionId && <span className="fork-mark" title="Forked session" aria-label="Forked session">⑂</span>}{session.title}</button>)}</div></section>}

    {state.runtime.state === 'error' && <div className="banner error-banner"><span>{state.runtime.message ?? 'Runtime unavailable'}</span><button onClick={() => post({ type: 'restartRuntime' })}>Restart</button></div>}
    {!state.settings.loading && !state.settings.credential.configured && <button className="banner credential-banner" onClick={() => setSettingsOpen(true)}><span>Configure DeepSeek API Key</span><b>Open settings →</b></button>}

    <Conversation events={state.events} loading={state.historyLoading} running={running} changedFiles={changedFiles} gitChanges={state.gitChanges} historyHasMore={state.historyHasMore} historyLoadingMore={state.historyLoadingMore} post={post} onEdit={editDraft}/>

    {!state.historyLoading && <div className="composer-wrap">
      {state.attachedFiles.length > 0 && <div className="attachment-rail">{state.attachedFiles.map(path => <button key={path} title={path} onClick={() => post({ type: 'removeAttachment', path })}>📎 {basename(path)} <span>×</span></button>)}</div>}
      {queuedMessage !== undefined && <div className="queued-message"><span className="queue-mark"><QueueIcon/></span><p title={queuedMessage}>{queuedMessage}</p><button className="queue-steer" data-tooltip="Send as steering instruction" onClick={() => { post({ type: 'steerMessage', text: queuedMessage }); setQueuedMessage(undefined) }}><SteerIcon/>Steer</button><button className="queue-action" data-tooltip="Remove queued message" aria-label="Remove queued message" onClick={() => setQueuedMessage(undefined)}><TrashIcon/></button><div className="queue-overflow" ref={queueMenu}><button className="queue-action" data-tooltip="More queue options" aria-label="More queue options" aria-expanded={queueMenuOpen} onClick={() => setQueueMenuOpen(open => !open)}><MoreIcon/></button>{queueMenuOpen && <div className="queue-menu" role="menu"><button role="menuitem" onClick={() => { setText(queuedMessage); setQueuedMessage(undefined); setQueueMenuOpen(false); composer.current?.focus() }}><EditIcon/>Edit message</button><button role="menuitem" onClick={() => { setQueueingEnabled(false); setQueueMenuOpen(false) }}><QueueIcon/>Turn off queueing</button></div>}</div></div>}
      <div className="composer">
        <textarea ref={composer} value={text} placeholder="Ask DeepSeek…" rows={2} aria-autocomplete="list" onKeyDown={event => {
          if (commandMenuOpen && commandMatches !== undefined && !event.nativeEvent.isComposing) {
            if (event.key === 'ArrowDown') { event.preventDefault(); setCommandIndex(index => (Math.min(index, commandMatches.length - 1) + 1) % commandMatches.length); return }
            if (event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex(index => (Math.min(index, commandMatches.length - 1) - 1 + commandMatches.length) % commandMatches.length); return }
            if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
              const selected = commandMatches[activeCommandIndex]
              if (selected !== undefined) { event.preventDefault(); applyCommand(selected); return }
            }
            if (event.key === 'Escape') { event.preventDefault(); setCommandDismissed(true); return }
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!event.repeat) submit() }
        }} onChange={event => { setText(event.target.value); setCommandIndex(0); setCommandDismissed(false) }}/>
        {commandMenuOpen && commandMatches !== undefined && <div className="commands-menu-wrap" ref={commandMenu}><div className="commands-menu" role="listbox" aria-label="Slash commands">{commandMatches.map((command, index) => <button key={command.name} type="button" role="option" aria-selected={index === activeCommandIndex} className={index === activeCommandIndex ? 'selected' : ''} onClick={() => applyCommand(command)}><span>/{command.name}{command.inputHint !== undefined && <small> {command.inputHint}</small>}</span><small>{command.description}</small></button>)}</div></div>}
        {!state.settings.loading && !state.settings.credential.configured && <button className="composer-key-warning" onClick={() => setSettingsOpen(true)}>Configure an API key in Settings to send messages.</button>}
        <div className="composer-actions">
          <div className="composer-control-group composer-control-group-left">
          <div className="add-menu-wrap" ref={addMenu}>
            <button className="add-button" data-tooltip="Add context or select mode" aria-label="Add" aria-expanded={addMenuOpen} onClick={() => { setAddMenuOpen(open => !open); setModeMenuOpen(false); setGoalEditorOpen(false) }}><AddIcon/></button>
            {addMenuOpen && <div className="add-menu" role="menu">
              {!goalEditorOpen && !modeMenuOpen ? <>
                <button role="menuitem" onClick={() => { post({ type: 'attachFiles' }); setAddMenuOpen(false) }}><PaperclipIcon/><span><strong>Files and folders</strong><small>Add files as context</small></span></button>
                <button role="menuitem" onClick={() => setModeMenuOpen(true)}><ModeIcon/><span><strong>{selectedMode.label} mode</strong><small>Select how DeepSeek should work</small></span></button>
                <button role="menuitem" onClick={() => setGoalEditorOpen(true)}><GoalIcon/><span><strong>Goal</strong><small>Set a goal to keep pursuing</small></span></button>
              </> : modeMenuOpen ? <div className="mode-picker" role="group" aria-label="Select mode"><button type="button" className="mode-picker-back" onClick={() => setModeMenuOpen(false)}>‹ Back</button><small>Mode</small>{MODE_OPTIONS.map(mode => <button key={mode.value} type="button" className={agentMode === mode.value ? 'selected' : ''} onClick={() => { setAgentMode(mode.value); setModeMenuOpen(false); setAddMenuOpen(false) }}><span><strong>{mode.label}</strong><small>{mode.description}</small></span>{agentMode === mode.value && <b>✓</b>}</button>)}</div> : <form className="goal-editor" onSubmit={event => { event.preventDefault(); const objective = goalText.trim(); if (objective === '') return; post({ type: 'sendMessage', text: `/goal ${objective}` }); setGoalText(''); setGoalEditorOpen(false); setAddMenuOpen(false) }}><strong>Set goal</strong><input value={goalText} onChange={event => setGoalText(event.target.value)} placeholder="What should DeepSeek keep pursuing?" autoFocus/><div><button type="button" onClick={() => setGoalEditorOpen(false)}>Back</button><button type="submit">Set goal</button></div></form>}
            </div>}
          </div>
          </div>
          <div className="composer-control-group composer-control-group-right">
          <select className="composer-model-select" value={composerModel} aria-label="Select model" data-tooltip="Select model" onChange={event => { const model = event.target.value; setComposerModel(model); post({ type: 'saveSettings', provider: state.settings.provider, model, endpoint: state.settings.endpoint, permissionMode: state.settings.permissionMode }) }}>
            <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
            <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
            <option value="deepseek-v4-flash-vision-exp">DeepSeek V4 Flash Vision Exp</option>
            {!['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'].includes(composerModel) && <option value={composerModel}>{composerModel}</option>}
          </select>
          <button className="context-meter" data-tooltip={contextLabel} aria-label={contextLabel} type="button"><ContextRing percent={contextPercent}/></button>
          <button className={`send-button ${running ? 'stop-send-button' : ''}`} aria-label={running ? 'Stop current response' : 'Send message'} title={running ? 'Stop current response' : canSend ? 'Send message' : 'Configure a DeepSeek API key in Settings first'} disabled={!running && (text.trim() === '' || !canSend)} onClick={() => { if (running) post({ type: 'cancel' }); else submit() }}>{running ? <StopIcon/> : <SendIcon/>}</button>
          </div>
        </div>
      </div>
    </div>}
  </main>
}

function basename(path: string): string { return path.split(/[\\/]/).at(-1) ?? path }
function formatTokenCount(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K` : String(value) }
function estimateContextTokens(events: WebviewState['events']): number {
  const userChars = events.filter((event): event is Extract<WebviewState['events'][number], { type: 'user.message' }> => event.type === 'user.message').reduce((total, event) => total + event.text.length, 0)
  const completed = events.filter((event): event is Extract<WebviewState['events'][number], { type: 'assistant.completed' }> => event.type === 'assistant.completed').reduce((total, event) => total + event.text.length, 0)
  const chunkChars = completed === 0 ? events.filter((event): event is Extract<WebviewState['events'][number], { type: 'assistant.chunk' }> => event.type === 'assistant.chunk').reduce((total, event) => total + event.text.length, 0) : 0
  const chars = userChars + completed + chunkChars
  return chars === 0 ? 0 : Math.max(1, Math.ceil(chars / 3.2))
}

function ToolbarIcon({ kind }: { kind: 'new' | 'history' | 'trajectory' | 'plugins' | 'settings' }): JSX.Element {
  if (kind === 'new') return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14"/></svg>
  if (kind === 'history') return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M4 12a8 8 0 1 0 2.35-5.66L4 8.7M4 4v4.7h4.7M12 8v4l2.8 1.8"/></svg>
  if (kind === 'trajectory') return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M5 5v14M5 7h5l2 4h7M10 19h4l2-4h3"/><circle cx="10" cy="7" r="1.5"/><circle cx="12" cy="11" r="1.5"/><circle cx="14" cy="19" r="1.5"/></svg>
  if (kind === 'plugins') return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M8.5 4v4M15.5 4v4M7 8h10a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2v3H9v-3H7a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z"/><path d="M9 12h.01M15 12h.01"/></svg>
  return <svg className="toolbar-icon settings-icon" viewBox="0 0 24 24" aria-hidden><path d="M9.75 3.55h4.5l.6 2.1c.46.2.89.45 1.28.76l2.1-.58 2.25 3.9-1.55 1.53c.05.47.05.95 0 1.42l1.55 1.53-2.25 3.9-2.1-.58c-.39.31-.82.56-1.28.76l-.6 2.1h-4.5l-.6-2.1c-.46-.2-.89-.45-1.28-.76l-2.1.58-2.25-3.9 1.55-1.53a6 6 0 0 1 0-1.42L3.77 9.73l2.25-3.9 2.1.58c.39-.31.82-.56 1.28-.76l.35-2.1Z"/><circle cx="12" cy="12" r="3"/></svg>
}

function ContextRing({ percent }: { percent: number }): JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden><circle className="context-ring-track" cx="12" cy="12" r="9"/><circle className="context-ring-value" cx="12" cy="12" r="9" pathLength="100" style={{ strokeDasharray: '100', strokeDashoffset: String(100 - percent) }}/></svg>
}

function AddIcon(): JSX.Element { return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14"/></svg> }
function PaperclipIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><path d="m8 12 6.4-6.4a3 3 0 1 1 4.2 4.2l-8.5 8.5a5 5 0 1 1-7.1-7.1l8-8"/></svg> }
function ModeIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><path d="M5 7h14M5 12h14M5 17h14"/><circle cx="9" cy="7" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="11" cy="17" r="1.5"/></svg> }
function GoalIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="m15 9 5-5"/></svg> }
function SendIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 19V5m0 0L6.5 10.5M12 5l5.5 5.5"/></svg> }
function StopIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><rect x="7" y="7" width="10" height="10" rx="1"/></svg> }


function QueueIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><path d="M5 6h8M5 12h14M5 18h10M16 5v6m-3-3h6"/></svg> }
function SteerIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><path d="M4 6v5h10M4 6l3 3M4 6l3-3M14 11l3 3-3 3M17 14H7"/></svg> }
function TrashIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><path d="M5 7h14M10 11v6m4-6v6M9 7l1-2h4l1 2m-8 0 1 12h8l1-12"/></svg> }
function MoreIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg> }
function EditIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><path d="m5 16.5-.8 3.3 3.3-.8L18 8.5 15.5 6 5 16.5Zm9.5-10.5 2.5 2.5"/></svg> }
