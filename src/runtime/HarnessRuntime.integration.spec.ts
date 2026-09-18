import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessClient } from '../harness/HarnessClient.ts'
import { HarnessEventMapper } from '../harness/HarnessEventMapper.ts'

// Locate the bundled native runtime in the source tree or an installed extension.
const here = dirname(fileURLToPath(import.meta.url))
const binary = process.platform === 'win32' ? 'dsh.exe' : 'dsh'
const candidates = [
  join(here, '..', '..', 'bin', 'dsh', binary),
  join(homedir(), '.cursor', 'extensions', 'deepseek-harness.deepseek-harness-vscode-0.1.1', 'bin', 'dsh', binary),
  join(homedir(), '.vscode', 'extensions', 'deepseek-harness.deepseek-harness-vscode-0.1.1', 'bin', 'dsh', binary),
]

const RUNTIME = candidates.find(existsSync)

describe('HarnessRuntime integration (bundled native dsh)', () => {
  beforeAll(() => {
    if (RUNTIME === undefined) throw new Error('bundled dsh runtime binary not found; build it with the release workflow first')
  })

  const cwd = process.cwd()
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-vscode-runtime-test-'))
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

  function makeClient(): HarnessClient {
    return new HarnessClient({
      command: RUNTIME!,
      args: ['--profile', 'sdk'],
      cwd,
      env: {
        ...process.env,
        DSH_CWD: cwd,
        DSH_DATA_DIR: dataDir,
        DSH_SESSION_COMPRESSION: 'zstd',
        DEEPSEEK_API_KEY: process.env.DSH_E2E_API_KEY,
      },
    })
  }

  it('keyless initialize returns expected serverInfo', async () => {
    const client = makeClient()
    try {
      const info = await client.initialize({ cwd, provider: 'deepseek-official', model: 'deepseek-chat' })
      expect(info.serverInfo.name).toBe('deepseek-harness-sdk-runtime')
      expect(info.serverInfo.version).toBe('0.1.0')
      await expect(client.listCommands()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'goal', description: expect.any(String) }),
      ]))
    } finally {
      await client.close()
    }
  }, 50_000)

  it('session/history returns an events array for a fresh session', async () => {
    const client = makeClient()
    try {
      await client.initialize({ cwd, provider: 'deepseek-official', model: 'deepseek-chat' })
      const history = await client.history(`vitest-${Date.now()}`)
      expect(Array.isArray(history.events)).toBe(true)
    } finally {
      await client.close()
    }
  }, 20_000)

  it('lists workspace sessions and exposes only credential metadata', async () => {
    const client = makeClient()
    try {
      await client.initialize({ cwd, provider: 'deepseek-official', model: 'deepseek-chat' })
      const sessionId = `vitest-list-${Date.now()}`
      await client.history(sessionId)
      await expect(client.listSessions()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: sessionId })]))
      await expect(client.credentialStatus()).resolves.toMatchObject({ configured: false, writable: true })
      await expect(client.setCredential('integration-secret')).resolves.toMatchObject({ configured: true, writable: true })
      await expect(client.unsetCredential()).resolves.toMatchObject({ configured: false, writable: true })
    } finally {
      await client.close()
    }
  }, 25_000)

  it('keeps a user fork visible and resumable after the runtime restarts', async () => {
    const sourceId = `vitest-fork-source-${Date.now()}`
    let forkId = ''
    const first = makeClient()
    try {
      await first.initialize({ cwd, provider: 'deepseek-official', model: 'deepseek-chat' })
      await first.history(sourceId)
      forkId = await first.forkSession(sourceId)
      await expect(first.listSessions()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sourceId }),
        expect.objectContaining({ id: forkId, parentSessionId: sourceId }),
      ]))
    } finally {
      await first.close()
    }

    const restarted = makeClient()
    try {
      await restarted.initialize({ cwd, provider: 'deepseek-official', model: 'deepseek-chat' })
      await expect(restarted.listSessions()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: forkId, parentSessionId: sourceId }),
      ]))
      await expect(restarted.history(forkId)).resolves.toMatchObject({ events: expect.any(Array) })
    } finally {
      await restarted.close()
    }
  }, 40_000)

  it('session/prompt returns quickly (durable admission, not model turn)', async () => {
    const client = makeClient()
    try {
      await client.initialize({ cwd, provider: 'deepseek-official', model: 'deepseek-chat' })
      const t0 = Date.now()
      await client.prompt(`vitest-${Date.now()}`, [{ type: 'text', text: 'ping' }])
      const elapsed = Date.now() - t0
      // admission should be fast; the model turn continues asynchronously.
      expect(elapsed).toBeLessThan(15_000)
    } finally {
      await client.close()
    }
  }, 25_000)

  it.skipIf(process.env.DSH_E2E_API_KEY === undefined)('streams assistant chunks and completes a turn end-to-end', async () => {
    const client = makeClient()
    const mapper = new HarnessEventMapper()
    const chunks: string[] = []
    let completed = false
    client.subscribe(notification => {
      const event = mapper.map(notification)
      if (event === undefined) return
      if (event.type === 'assistant.chunk' && !event.reasoning) chunks.push(event.text)
      if (event.type === 'assistant.completed') completed = true
    })
    try {
      await client.initialize({ cwd, provider: 'deepseek-official', model: 'deepseek-chat' })
      const sessionId = `vitest-e2e-${Date.now()}`
      await client.prompt(sessionId, [{ type: 'text', text: 'reply with exactly: OK' }])
      // wait for the model turn to finish (streaming + completion)
      const deadline = Date.now() + 60_000
      while (!completed && Date.now() < deadline) await new Promise(r => setTimeout(r, 250))
      expect(completed).toBe(true)
      expect(chunks.join('')).toContain('OK')
    } finally {
      await client.close()
    }
  }, 90_000)
})
