import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import type { ExtensionContext, WebviewView } from 'vscode'
import type { HarnessAdapter, HistoryPage } from '../harness/HarnessAdapter.ts'
import { HarnessRuntimeManager } from '../runtime/HarnessRuntimeManager.ts'
import type { HarnessEvent, HarnessCommand, WebviewState } from '../shared/protocol.ts'
import { ChatViewProvider } from './ChatViewProvider.ts'

// The provider normally talks to the editor; a small npm-free stand-in keeps these
// behaviour tests running under plain Node.
interface Snapshot {
  path: string
  sessionId: string
  before?: string
  after?: string
  decision?: 'kept' | 'reverted'
  files?: { before?: string; after?: string }
}
interface Internals {
  fileSnapshots: Map<string, Snapshot>
  persistedChanges: unknown[]
  events: HarnessEvent[]
  historyHasMore: boolean
  historyAnchor: number | undefined
  handle(message: { type: 'loadMoreHistory' }): Promise<void>
  reviewDiff(callId: string, decision: 'kept' | 'reverted'): Promise<void>
  persistFileChange(callId: string): Promise<void>
  readTextSnapshot(target: string): Promise<string | undefined>
  trackSnapshot(callId: string, entry: Snapshot): void
  append(event: HarnessEvent): void
}

const internals = (provider: ChatViewProvider): Internals => provider as unknown as Internals
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (rounds = 40): Promise<void> => {
  for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve))
}

function makeContext(storageRoot: string): ExtensionContext {
  const store = new Map<string, unknown>()
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(storageRoot),
    extensionPath: storageRoot,
    storageUri: vscode.Uri.file(join(storageRoot, 'storage')),
    globalStorageUri: vscode.Uri.file(join(storageRoot, 'global-storage')),
    globalState: { get: <T>(key: string, fallback: T): T => (store.get(key) as T | undefined) ?? fallback, update: async (key: string, value: unknown): Promise<void> => { store.set(key, value) } },
  } as unknown as ExtensionContext
}

function makeView(posted: Record<string, unknown>[]): WebviewView {
  return {
    webview: {
      options: {}, html: '', cspSource: '',
      postMessage: (message: Record<string, unknown>): Thenable<boolean> => { posted.push(message); return Promise.resolve(true) },
      asWebviewUri: (uri: unknown): unknown => uri,
      onDidReceiveMessage: (): vscode.Disposable => new vscode.Disposable(() => undefined),
    },
    visible: true,
    onDidDispose: (): vscode.Disposable => new vscode.Disposable(() => undefined),
    onDidChangeVisibility: (): vscode.Disposable => new vscode.Disposable(() => undefined),
  } as unknown as WebviewView
}

function makeAdapter(overrides: Partial<Record<keyof HarnessAdapter, unknown>> = {}): { adapter: HarnessAdapter; calls: Map<string, unknown[][]> } {
  const calls = new Map<string, unknown[][]>()
  const record = (name: string, args: unknown[]): void => { calls.set(name, [...calls.get(name) ?? [], args]) }
  const historyOverride = overrides.history as ((...args: unknown[]) => Promise<HistoryPage>) | undefined
  // Keep recording arguments even when a test supplies its own history implementation.
  const history = async (...args: unknown[]): Promise<HistoryPage> => {
    record('history', args)
    return await (historyOverride === undefined ? { events: [], hasMore: false } : historyOverride(...args))
  }
  const base = {
    start: async (): Promise<void> => undefined,
    stop: async (): Promise<void> => undefined,
    getStatus: () => ({ state: 'ready' }),
    createSession: async (): Promise<{ id: string }> => ({ id: 's1' }),
    resumeSession: async (sessionId: string): Promise<{ id: string }> => ({ id: sessionId }),
    listSessions: async () => [{ id: 's1', title: 'One', createdAt: 1, updatedAt: 2 }],
    listCommands: async (): Promise<HarnessCommand[]> => [{ name: 'goal', description: 'Set a goal', inputHint: '[objective]' }],
    listPlugins: async () => [],
    sessionStatus: async () => 'idle',
    pendingApprovals: async (): Promise<HarnessEvent[]> => [],
    forkSession: async (): Promise<string> => 'fork',
    deleteSession: async (): Promise<boolean> => true,
    listChanges: async (): Promise<Record<string, unknown>[]> => [],
    reviewChange: async (): Promise<boolean> => true,
    rawHistory: async (): Promise<Record<string, unknown>[]> => [],
    sendMessage: async (): Promise<void> => undefined,
    cancel: async (): Promise<void> => undefined,
    steer: async (): Promise<void> => undefined,
    respondApproval: async (): Promise<void> => undefined,
    credentialStatus: async () => ({ configured: true, writable: true }),
    setCredential: async () => ({ configured: true, writable: true, source: 'file' }),
    unsetCredential: async () => ({ configured: false, writable: true }),
    subscribe: (): vscode.Disposable => new vscode.Disposable(() => undefined),
  }
  return { adapter: { ...base, ...overrides, history } as unknown as HarnessAdapter, calls }
}

function makeRuntime(adapter: HarnessAdapter): HarnessRuntimeManager {
  return { getStatus: () => ({ state: 'ready' }), onDidChangeStatus: (): vscode.Disposable => new vscode.Disposable(() => undefined), start: async () => adapter } as unknown as HarnessRuntimeManager
}

const userMessage = (eventSeq: number, text: string): HarnessEvent => ({ type: 'user.message', sessionId: 's1', text, eventSeq })

describe('ChatViewProvider', () => {
  const roots: string[] = []
  const workspaceRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-view-test-'))
    roots.push(root)
    return root
  }
  afterEach(() => { vi.restoreAllMocks(); while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true }) })

  it('pages history on activate instead of pulling the whole transcript', async () => {
    const { adapter, calls } = makeAdapter({ history: async () => ({ events: [userMessage(2, 'recent')], hasMore: true, firstSeq: 2 }) })
    const provider = new ChatViewProvider(makeContext(workspaceRoot()), makeRuntime(adapter))
    provider.resolveWebviewView(makeView([]))
    await settle()
    expect(calls.get('history')?.[0]?.[1]).toEqual({ limit: 200 })
    expect(internals(provider).historyHasMore).toBe(true)
    expect(internals(provider).historyAnchor).toBe(2)
  })

  it('merges an earlier page in front without duplicating events', async () => {
    const pages: HistoryPage[] = [
      { events: [userMessage(2, 'recent')], hasMore: true, firstSeq: 2 },
      { events: [userMessage(1, 'older')], hasMore: false, firstSeq: 1 },
    ]
    let consumed = 0
    const { adapter, calls } = makeAdapter({ history: async () => pages[consumed++] ?? { events: [], hasMore: false } })
    const provider = new ChatViewProvider(makeContext(workspaceRoot()), makeRuntime(adapter))
    provider.resolveWebviewView(makeView([]))
    await settle()
    await internals(provider).handle({ type: 'loadMoreHistory' })
    expect(calls.get('history')?.[1]?.[1]).toEqual({ limit: 200, before: 2 })
    expect(internals(provider).historyHasMore).toBe(false)
    expect(internals(provider).events.filter(event => event.type === 'user.message').map(event => event.type === 'user.message' ? event.text : '')).toEqual(['older', 'recent'])
  })

  it('loads slash commands so the composer menu can offer them', async () => {
    const { adapter } = makeAdapter()
    const posted: Record<string, unknown>[] = []
    const provider = new ChatViewProvider(makeContext(workspaceRoot()), makeRuntime(adapter))
    provider.resolveWebviewView(makeView(posted))
    await settle()
    const state = [...posted].reverse().find(frame => frame.type === 'state')?.state as WebviewState
    expect(state.commands.map(command => command.name)).toEqual(['goal'])
  })

  it('coalesces streamed state updates into a single frame', async () => {
    const { adapter } = makeAdapter()
    const posted: Record<string, unknown>[] = []
    const provider = new ChatViewProvider(makeContext(workspaceRoot()), makeRuntime(adapter))
    provider.resolveWebviewView(makeView(posted))
    await settle()
    posted.length = 0
    for (let index = 0; index < 30; index++) internals(provider).append({ type: 'session.title', sessionId: 's1', title: `title ${index}` })
    expect(posted.filter(frame => frame.type === 'state')).toHaveLength(0)
    await sleep(250)
    expect(posted.filter(frame => frame.type === 'state')).toHaveLength(1)
  })

  it('keeps persisted file changes bounded', async () => {
    const { adapter } = makeAdapter()
    const provider = new ChatViewProvider(makeContext(workspaceRoot()), makeRuntime(adapter))
    for (let index = 0; index < 620; index++) {
      internals(provider).fileSnapshots.set(`call-${index}`, { path: `/tmp/ignored-${index}.ts`, sessionId: 's1' })
      await internals(provider).persistFileChange(`call-${index}`)
    }
    expect(internals(provider).persistedChanges).toHaveLength(500)
  })

  it('evicts file snapshots once the window is full', async () => {
    const { adapter } = makeAdapter()
    const provider = new ChatViewProvider(makeContext(workspaceRoot()), makeRuntime(adapter))
    for (let index = 0; index < 260; index++) internals(provider).trackSnapshot(`call-${index}`, { path: `/tmp/target-${index}.ts`, sessionId: 's1' })
    expect(internals(provider).fileSnapshots.size).toBeLessThanOrEqual(200)
  })

  it('sends reverted files created by the agent to the trash rather than deleting them', async () => {
    const root = workspaceRoot(), target = join(root, 'created.ts')
    writeFileSync(target, 'agent content', 'utf8')
    const { adapter } = makeAdapter()
    const provider = new ChatViewProvider(makeContext(root), makeRuntime(adapter))
    internals(provider).fileSnapshots.set('call-1', { path: target, sessionId: 's1', after: 'agent content' })
    const deletions: { path: string; useTrash: boolean | undefined }[] = []
    vi.spyOn(vscode.workspace.fs, 'delete').mockImplementation(async (uri: vscode.Uri, options?: { useTrash?: boolean; recursive?: boolean }): Promise<void> => {
      deletions.push({ path: uri.fsPath, useTrash: options?.useTrash })
    })
    await internals(provider).reviewDiff('call-1', 'reverted')
    expect(deletions).toEqual([{ path: target, useTrash: true }])
  })

  it('skips oversized and binary files instead of buffering their contents', async () => {
    const root = workspaceRoot()
    const small = join(root, 'small.txt'), big = join(root, 'big.txt'), binary = join(root, 'image.bin')
    writeFileSync(small, 'hello', 'utf8')
    writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 0x61))
    writeFileSync(binary, Buffer.from([1, 2, 0, 3, 4]))
    const { adapter } = makeAdapter()
    const provider = new ChatViewProvider(makeContext(root), makeRuntime(adapter))
    await expect(internals(provider).readTextSnapshot(small)).resolves.toBe('hello')
    await expect(internals(provider).readTextSnapshot(big)).resolves.toBeUndefined()
    await expect(internals(provider).readTextSnapshot(binary)).resolves.toBeUndefined()
  })

  it('restores file change metadata without loading contents into memory', async () => {
    const root = workspaceRoot()
    const beforeFile = join(root, 'call-1.before')
    writeFileSync(beforeFile, 'before text', 'utf8')
    const context = makeContext(root)
    await context.globalState.update('deepseekHarness.fileChanges.v1', [{ callId: 'call-1', sessionId: 's1', path: join(root, 'file.ts'), beforeFile, afterFile: beforeFile }])
    const { adapter } = makeAdapter()
    const provider = new ChatViewProvider(context, makeRuntime(adapter))
    provider.resolveWebviewView(makeView([]))
    await settle()
    const snapshot = internals(provider).fileSnapshots.get('call-1')
    expect(snapshot?.before).toBeUndefined()
    expect(snapshot?.files).toEqual({ before: beforeFile, after: beforeFile })
  })
})
