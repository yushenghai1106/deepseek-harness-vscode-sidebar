import { describe, expect, it } from 'vitest'
import type { HarnessEvent } from '../../shared/protocol.ts'
import { RowBuilder } from './Conversation.tsx'

// The builder is what keeps long transcripts cheap to render: streaming one more chunk must
// leave every other row untouched so their memoized subtrees can be skipped.
const user = (eventSeq: number, text: string): HarnessEvent => ({ type: 'user.message', sessionId: 's1', text, eventSeq })
const chunk = (text: string, reasoning = false): HarnessEvent => ({ type: 'assistant.chunk', sessionId: 's1', text, reasoning })
const completed = (text: string): HarnessEvent => ({ type: 'assistant.completed', sessionId: 's1', text })
const started = (callId: string): HarnessEvent => ({ type: 'tool.started', sessionId: 's1', callId, name: 'edit_file', arguments: '{}' })
const toolDone = (callId: string, result: string): HarnessEvent => ({ type: 'tool.completed', sessionId: 's1', callId, result, failed: false })

describe('RowBuilder', () => {
  it('produces the same rows when events arrive streamed rather than all at once', () => {
    const events = [user(1, 'hi'), chunk('hel'), chunk('lo'), completed(''), started('c1'), toolDone('c1', 'ok')]
    const builder = new RowBuilder()
    let streaming: ReturnType<RowBuilder['build']> = []
    for (let index = 1; index <= events.length; index++) streaming = builder.build(events.slice(0, index))
    expect(streaming).toEqual(new RowBuilder().build(events))
  })

  it('keeps every other row reference stable while a message streams', () => {
    const builder = new RowBuilder()
    const base = [user(1, 'hi'), started('c1'), toolDone('c1', 'ok')]
    const before = [...builder.build(base)]
    const after = builder.build([...base, chunk('hel'), chunk('lo')])
    expect(after.length).toBe(before.length + 1)
    expect(after.slice(0, before.length).every((row, index) => row === before[index])).toBe(true)
    expect(after.at(-1)).toMatchObject({ kind: 'assistant', text: 'hello' })
  })

  it('replaces the tool row so React sees it change when the call completes', () => {
    const builder = new RowBuilder()
    const events = [user(1, 'hi'), started('c1')]
    const before = builder.build(events)
    const toolRow = before.at(-1), userRow = before[0]
    const after = builder.build([...events, toolDone('c1', 'ok')])
    expect(after.at(-1)).not.toBe(toolRow)
    expect(after.at(-1)).toMatchObject({ kind: 'toolGroup', tools: [{ callId: 'c1', completed: true, result: 'ok' }] })
    expect(after[0]).toBe(userRow)
  })

  it('rebuilds rows when older history is prepended', () => {
    const builder = new RowBuilder()
    const before = [...builder.build([user(2, 'recent')])]
    const after = builder.build([user(1, 'older'), user(2, 'recent')])
    expect(after.map(row => row.kind)).toEqual(['user', 'user'])
    expect(after[1]).not.toBe(before[0])
  })

  it('separates reasoning from the answer', () => {
    const rows = new RowBuilder().build([chunk('thinking', true), chunk('answer'), completed('')])
    expect(rows).toMatchObject([{ kind: 'reasoning', text: 'thinking' }, { kind: 'assistant', text: 'answer' }])
  })

  it('uses the completed text when nothing streamed', () => {
    const rows = new RowBuilder().build([completed('reply')])
    expect(rows).toMatchObject([{ kind: 'assistant', text: 'reply' }])
  })

  it('reports tool results that arrive without a matching start', () => {
    const rows = new RowBuilder().build([toolDone('orphan', 'result')])
    expect(rows).toMatchObject([{ kind: 'toolGroup', tools: [{ callId: 'orphan', completed: true, result: 'result' }] }])
  })

  it('updates an approval row in place once resolved', () => {
    const rows = new RowBuilder().build([
      { type: 'approval.requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash' },
      { type: 'approval.resolved', sessionId: 's1', approvalId: 'a1', decision: 'allowed' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'approval', resolved: 'allowed' })
  })
})
