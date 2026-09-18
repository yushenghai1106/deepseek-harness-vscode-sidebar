import { memo, useEffect, useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { HarnessEvent, WebviewToExtensionMessage } from '../../shared/protocol.ts'
import deepseekLogo from '../../../media/deepseek.svg'

type Post = (message: WebviewToExtensionMessage) => void
const REMARK_PLUGINS = [remarkGfm]

type Row =
  | { key: string; kind: 'user' | 'assistant' | 'reasoning'; text: string }
  | { key: string; kind: 'toolGroup'; tools: ToolStep[] }
  | { key: string; kind: 'approval'; event: Extract<HarnessEvent, { type: 'approval.requested' }>; resolved?: string }
  | { key: string; kind: 'plan'; event: Extract<HarnessEvent, { type: 'plan.updated' }> }
  | { key: string; kind: 'subagent'; event: Extract<HarnessEvent, { type: 'subagent.started' | 'subagent.finished' }> }
  | { key: string; kind: 'goal'; event: Extract<HarnessEvent, { type: 'goal.updated' }> }
  | { key: string; kind: 'error'; text: string }

type ToolStep = { key: string; callId: string; name: string; arguments: string; result?: string; failed?: boolean; completed: boolean; changed?: boolean; reviewed?: 'kept' | 'reverted' }

export function Conversation({ events, loading, running, changedFiles, gitChanges, historyHasMore, historyLoadingMore, post, onEdit }: { events: HarnessEvent[]; loading: boolean; running: boolean; changedFiles: Extract<HarnessEvent, { type: 'file.changed' }>[]; gitChanges: { path: string; status: string }[]; historyHasMore?: boolean; historyLoadingMore?: boolean; post: Post; onEdit(value: string): void }): JSX.Element {
  const scroll = useRef<HTMLElement>(null), wasNearBottom = useRef(true), builder = useRef<RowBuilder>()
  const rows = useMemo(() => {
    const instance = builder.current ?? new RowBuilder()
    builder.current = instance
    return instance.build(events)
  }, [events])
  const { remainingGitChanges } = useMemo(() => {
    const changedPaths = new Set(changedFiles.map(change => change.path))
    return { remainingGitChanges: gitChanges.filter(change => !changedPaths.has(change.path)) }
  }, [changedFiles, gitChanges])
  const changeCount = changedFiles.length + remainingGitChanges.length
  useEffect(() => {
    if (wasNearBottom.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' })
  }, [rows])
  return <section ref={scroll} className="conversation" data-conversation-scroll onScroll={event => {
    const element = event.currentTarget
    wasNearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96
  }}>
    {loading ? <div className="conversation-loading" role="status" aria-live="polite"><img src={deepseekLogo} alt=""/><div><i/><span>Loading conversation…</span></div></div> : rows.length === 0 && <div className="empty-state"><div className="empty-logo">◒</div><h2>What can I help you build?</h2><p>Ask about your code, attach context, or start with a task.</p></div>}
    <div className="conversation-column">
      {historyHasMore === true && <div className="history-more"><button className="ghost" onClick={() => post({ type: 'loadMoreHistory' })} disabled={historyLoadingMore === true}>{historyLoadingMore === true ? 'Loading earlier messages…' : 'Load earlier messages'}</button></div>}
      {!loading && <>{rows.map(row => <RowView key={row.key} row={row} post={post} onEdit={onEdit}/>)}
      {running && <div className="deep-diving"><i/><span>Deep diving…</span></div>}
      {changeCount > 0 && <details className="change-summary">
        <summary>{changeCount} file{changeCount === 1 ? '' : 's'} changed</summary>
        <div className="change-summary-items">
          {changedFiles.map(change => <button key={change.callId} onClick={() => post({ type: 'openDiff', callId: change.callId })} title={change.path}>Open {basename(change.path)} diff</button>)}
          {remainingGitChanges.map(change => <button key={change.path} onClick={() => post({ type: 'openGitFileDiff', path: change.path })} title={change.path}><b>{change.status}</b> {basename(change.path)}</button>)}
          {gitChanges.length > 0 && <button className="git-diff-link" onClick={() => post({ type: 'openGitDiff' })}>View Git diff</button>}
        </div>
      </details>}</>}
    </div>
  </section>
}

const RowView = memo(function RowView({ row, post, onEdit }: { row: Row; post: Post; onEdit(value: string): void }): JSX.Element {
  if (row.kind === 'user') return <div className="user-message-wrap"><article className="user-message"><Markdown text={row.text} post={post}/></article><div className="message-actions"><CopyAction text={row.text}/><button className="copy-action" onClick={() => onEdit(row.text)}>Edit</button><button className="copy-action" onClick={() => post({ type: 'retryMessage', text: row.text })}>Retry</button></div></div>
  if (row.kind === 'assistant') return <article className="assistant-message"><Markdown text={row.text} post={post}/></article>
  if (row.kind === 'reasoning') return <details className="reasoning-row"><summary>Thought process</summary><div><Markdown text={row.text}/></div></details>
  if (row.kind === 'toolGroup') return <ToolGroup tools={row.tools} post={post}/>
  if (row.kind === 'approval') return <article className={`approval-card ${row.resolved !== undefined ? 'resolved' : ''}`}><div className="approval-title">Approval required</div><p>{row.event.reason ?? `DeepSeek wants to run ${row.event.toolName}`}</p>{row.resolved === undefined
    ? <div className="approval-actions"><button onClick={() => post({ type: 'approval', sessionId: row.event.sessionId, approvalId: row.event.approvalId, decision: 'rejected' })}>Reject</button><button className="primary" onClick={() => post({ type: 'approval', sessionId: row.event.sessionId, approvalId: row.event.approvalId, decision: 'allowed-once' })}>Allow once</button></div>
    : <small>Resolved: {row.resolved}</small>}</article>
  if (row.kind === 'plan') return <article className="plan-card"><strong>Plan</strong>{row.event.items.map((item, index) => <div key={index}><span>{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○'}</span><p>{item.content}</p></div>)}</article>
  if (row.kind === 'subagent') return <article className="subagent-card"><strong>Subagent {row.event.type === 'subagent.started' ? 'started' : row.event.status === 'ok' ? 'completed' : 'failed'}</strong><small>{row.event.childSessionId}</small>{row.event.type === 'subagent.started' && <button className="diff-action danger" onClick={() => post({ type: 'cancelSubagent', sessionId: row.event.childSessionId })}>Stop subagent</button>}{row.event.type === 'subagent.finished' && row.event.message && <Markdown text={row.event.message}/>}</article>
  if (row.kind === 'goal') return <article className="goal-card"><strong>Goal · {row.event.phase}</strong><p>{row.event.objective}</p><small>{row.event.roundsStarted ?? 0}{row.event.maxGoalRounds ? ` / ${row.event.maxGoalRounds}` : ''} rounds{row.event.blockedReason ? ` · ${row.event.blockedReason}` : ''}</small>{row.event.phase !== 'complete' && <div className="goal-actions">{row.event.phase === 'active' && <button onClick={() => post({ type: 'sendMessage', text: '/goal pause' })}>Pause</button>}{(row.event.phase === 'paused' || row.event.phase === 'blocked') && <button onClick={() => post({ type: 'sendMessage', text: '/goal resume' })}>Resume</button>}<button onClick={() => post({ type: 'sendMessage', text: '/goal complete' })}>Complete</button><button onClick={() => post({ type: 'sendMessage', text: '/goal clear' })}>Clear</button></div>}</article>
  return <article className="inline-error">{row.text}</article>
})

const Markdown = memo(function Markdown({ text, post }: { text: string; post?: Post }): JSX.Element {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} skipHtml components={{
    a: props => <a {...props} target="_blank" rel="noreferrer"/>,
    code: props => { const value = String(props.children ?? '').trim(); const fileLike = post !== undefined && /(?:[\\/]|^)[\w.-]+\.(?:ts|tsx|js|jsx|py|json|md|css|html|yml|yaml)$/.test(value); return <>{<code className={props.className}>{props.children}</code>}{fileLike && <button className="file-link" onClick={() => post?.({ type: 'openFile', path: value })}>Open</button>}</> },
  }}>{text}</ReactMarkdown>
})

interface PendingText { index: number; key: string }

/**
 * Folds the append-only event log into presentational rows. Already emitted rows are reused across builds, so streaming one
 * more chunk replaces just the row it grows — every other row keeps its identity and its memoized subtree survives.
 */
class RowBuilder {
  private source: HarnessEvent[] = []
  private consumed = 0
  private rows: Row[] = []
  private tools = new Map<string, ToolStep>()
  private approvals = new Map<string, number>()
  private groups = new Map<string, number>()
  private assistant: PendingText | undefined
  private reasoning: PendingText | undefined
  private serial = 0

  build(events: HarnessEvent[]): Row[] {
    if (!this.reusable(events)) this.reset()
    for (let index = this.consumed; index < events.length; index++) {
      const event = events[index]
      if (event !== undefined) this.consume(event)
    }
    this.consumed = events.length
    this.source = events
    return this.rows
  }

  private reusable(events: HarnessEvent[]): boolean {
    if (this.consumed === 0) return events.length === 0
    if (events.length < this.consumed) return false
    return events[0] === this.source[0] && events[this.consumed - 1] === this.source[this.consumed - 1]
  }

  private reset(): void {
    this.rows = []
    this.tools.clear(); this.approvals.clear(); this.groups.clear()
    this.consumed = 0; this.assistant = undefined; this.reasoning = undefined; this.serial = 0
  }

  private consume(event: HarnessEvent): void {
    if (event.type === 'assistant.started' || event.type === 'status.changed' || event.type === 'session.started' || event.type === 'session.title') return
    if (event.type === 'assistant.chunk') {
      if (event.reasoning) { this.assistant = undefined; this.growPending('reasoning', event.text) }
      else { this.reasoning = undefined; this.growPending('assistant', event.text) }
      return
    }
    if (event.type === 'assistant.completed') {
      if (this.assistant === undefined && event.text !== '') this.growPending('assistant', event.text)
      this.assistant = undefined; this.reasoning = undefined
      return
    }
    this.assistant = undefined; this.reasoning = undefined
    this.consumeRow(event)
  }

  private growPending(kind: 'assistant' | 'reasoning', delta: string): void {
    const pending = kind === 'assistant' ? this.assistant : this.reasoning
    if (pending === undefined) {
      if (delta === '') return
      const row: Row = { key: `${kind}-${this.serial++}`, kind, text: delta }
      this.rows.push(row)
      const step: PendingText = { index: this.rows.length - 1, key: row.key }
      if (kind === 'assistant') this.assistant = step; else this.reasoning = step
      return
    }
    const current = this.rows[pending.index]
    if (current === undefined || (current.kind !== 'assistant' && current.kind !== 'reasoning')) return
    this.rows[pending.index] = { ...current, text: current.text + delta }
  }

  private consumeRow(event: HarnessEvent): void {
    if (event.type === 'user.message') { this.rows.push({ key: `user-${event.eventSeq ?? this.serial++}`, kind: 'user', text: event.text }); return }
    if (event.type === 'tool.started') {
      const tool: ToolStep = { key: `tool-${event.callId}`, callId: event.callId, name: event.name, arguments: event.arguments, completed: false }
      const last = this.rows.at(-1)
      if (last?.kind === 'toolGroup') {
        const index = this.rows.length - 1
        this.rows[index] = { ...last, tools: [...last.tools, tool] }
        this.groups.set(event.callId, index)
      } else {
        this.rows.push({ key: `tools-${this.serial++}`, kind: 'toolGroup', tools: [tool] })
        this.groups.set(event.callId, this.rows.length - 1)
      }
      this.tools.set(event.callId, tool)
      return
    }
    if (event.type === 'tool.completed') { this.updateToolStep(event.callId, { completed: true, result: event.result, failed: event.failed }, true); return }
    if (event.type === 'file.changed') { this.updateToolStep(event.callId, { changed: true }); return }
    if (event.type === 'file.reviewed') { this.updateToolStep(event.callId, { reviewed: event.decision }); return }
    if (event.type === 'approval.requested') { this.approvals.set(event.approvalId, this.rows.length); this.rows.push({ key: `approval-${event.approvalId}`, kind: 'approval', event }); return }
    if (event.type === 'approval.resolved') {
      const index = this.approvals.get(event.approvalId), current = index === undefined ? undefined : this.rows[index]
      if (index !== undefined && current?.kind === 'approval') this.rows[index] = { ...current, resolved: event.decision ?? 'completed' }
      return
    }
    if (event.type === 'plan.updated') { this.rows.push({ key: `plan-${event.eventSeq ?? this.serial++}`, kind: 'plan', event }); return }
    if (event.type === 'subagent.started' || event.type === 'subagent.finished') { this.rows.push({ key: `subagent-${event.childSessionId}-${this.serial++}`, kind: 'subagent', event }); return }
    if (event.type === 'goal.updated') { this.rows.push({ key: `goal-${event.eventSeq ?? this.serial++}`, kind: 'goal', event }); return }
    if (event.type === 'error') this.rows.push({ key: `error-${this.serial++}`, kind: 'error', text: event.message })
  }

  private updateToolStep(callId: string, patch: Partial<ToolStep>, createOrphan = false): void {
    const existing = this.tools.get(callId)
    if (existing === undefined) {
      if (!createOrphan) return
      const tool: ToolStep = { key: `tool-result-${callId}`, callId, name: 'Tool', arguments: '', completed: true, ...patch }
      this.rows.push({ key: `tools-${this.serial++}`, kind: 'toolGroup', tools: [tool] })
      this.groups.set(callId, this.rows.length - 1)
      this.tools.set(callId, tool)
      return
    }
    const groupIndex = this.groups.get(callId), group = groupIndex === undefined ? undefined : this.rows[groupIndex]
    const toolIndex = group?.kind === 'toolGroup' ? group.tools.findIndex(tool => tool.callId === callId) : -1
    if (groupIndex === undefined || group === undefined || group.kind !== 'toolGroup' || toolIndex < 0) { this.tools.set(callId, { ...existing, ...patch }); return }
    const tools = [...group.tools]
    tools[toolIndex] = { ...tools[toolIndex], ...patch }
    this.rows[groupIndex] = { key: group.key, kind: 'toolGroup', tools }
    this.tools.set(callId, tools[toolIndex])
  }
}

function pretty(value: string): string { try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value } }
function basename(path: string): string { return path.split(/[\\/]/).at(-1) ?? path }
function friendlyTool(name: string): string { return name.replaceAll(/[_-]+/g, ' ').replace(/^./, value => value.toUpperCase()) }

const ToolGroup = memo(function ToolGroup({ tools, post }: { tools: ToolStep[]; post: Post }): JSX.Element {
  const running = tools.some(tool => !tool.completed), failed = tools.some(tool => tool.failed)
  return <details className={`tool-group ${running ? 'running' : ''} ${failed ? 'failed' : ''}`} open={running}>
    <summary><HarnessMark/><strong>{toolSummary(tools)}</strong><span className="tool-group-chevron" aria-hidden>⌄</span></summary>
    <div className="tool-group-items">{tools.map(tool => <ToolDetails key={tool.key} tool={tool} post={post}/>)}</div>
  </details>
})

const ToolDetails = memo(function ToolDetails({ tool, post }: { tool: ToolStep; post: Post }): JSX.Element {
  return <details className={`tool-row ${tool.failed ? 'failed' : ''} ${tool.completed ? 'completed' : ''}`} open={!tool.completed}>
    <summary title="View tool details"><span className={`tool-state ${tool.completed ? tool.failed ? 'failed' : 'done' : 'running'}`}>{tool.completed ? tool.failed ? '×' : <HarnessMark/> : ''}</span><strong>{toolLabel(tool)}</strong>{(!tool.completed || tool.failed) && <small>{tool.failed ? 'Failed' : 'Running'}</small>}</summary>
    {tool.arguments !== '' && <pre>{pretty(tool.arguments)}</pre>}{tool.result !== undefined && tool.result !== '' && <pre className="tool-result">{tool.result}</pre>}{tool.changed && <div className="diff-actions"><button className="diff-action" onClick={() => post({ type: 'openDiff', callId: tool.callId })}>Open diff</button>{tool.reviewed === undefined ? <><button className="diff-action" onClick={() => post({ type: 'keepDiff', callId: tool.callId })}>Keep</button><button className="diff-action danger" onClick={() => post({ type: 'revertDiff', callId: tool.callId })}>Revert</button></> : <small>Change {tool.reviewed}</small>}</div>}
  </details>
})

function toolSummary(tools: ToolStep[]): string {
  const labels = Array.from(new Set(tools.map(tool => /(?:write|edit|patch|apply)/i.test(tool.name) ? 'Edited a file' : /(?:bash|shell|terminal|command|exec)/i.test(tool.name) ? 'Ran commands' : /(?:read|cat)/i.test(tool.name) ? 'Read files' : /(?:web|browser|search|fetch)/i.test(tool.name) ? 'Browsed the web' : 'Used tools')))
  return labels.join(', ')
}

function toolLabel(tool: ToolStep): string {
  if (/(?:bash|shell|terminal|command|exec)/i.test(tool.name) && tool.arguments.trim() !== '') return `Ran ${tool.arguments.trim().replaceAll(/\s+/g, ' ').slice(0, 100)}`
  return friendlyTool(tool.name)
}

function HarnessMark(): JSX.Element { return <img className="harness-mark" src={deepseekLogo} alt=""/> }

function CopyAction({ text }: { text: string }): JSX.Element {
  return <button className="copy-action" title="Copy message" aria-label="Copy message" onClick={() => { void navigator.clipboard?.writeText(text) }}>Copy</button>
}
