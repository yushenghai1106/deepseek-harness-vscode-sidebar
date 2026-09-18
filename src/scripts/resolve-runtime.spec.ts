import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyRuntime, expectedExecutableName, platformFromTarget, selectRuntime } from '../../scripts/resolve-runtime.mjs'

// The extension always execs `bin/dsh/dsh`, but local bundles ship the launcher as `dsh-py`.
// These pin the mapping so packaging and the dev sync cannot silently disagree.
describe('runtime bundle resolution', () => {
  const roots: string[] = []
  const makeDir = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-resolution-'))
    roots.push(root)
    return root
  }
  afterEach(() => { while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true }) })

  it('prefers the packaged dsh executable', () => {
    const root = makeDir()
    writeFileSync(join(root, 'dsh'), '')
    writeFileSync(join(root, 'dsh-py'), '')
    expect(selectRuntime(root, 'darwin')).toMatchObject({ executable: join(root, 'dsh'), executableName: 'dsh' })
  })

  it('falls back to the dsh-py launcher used by local builds', () => {
    const root = makeDir()
    writeFileSync(join(root, 'dsh-py'), '')
    expect(selectRuntime(root, 'darwin')).toMatchObject({ executable: join(root, 'dsh-py'), executableName: 'dsh-py' })
  })

  it('finds dsh.exe on Windows and ignores the POSIX launcher', () => {
    const root = makeDir()
    writeFileSync(join(root, 'dsh.exe'), '')
    writeFileSync(join(root, 'dsh'), '')
    expect(selectRuntime(root, 'win32')).toMatchObject({ executable: join(root, 'dsh.exe'), executableName: 'dsh.exe' })
  })

  it('returns undefined when the directory holds no runtime', () => {
    const root = makeDir()
    writeFileSync(join(root, 'README.md'), '')
    expect(selectRuntime(root, 'darwin')).toBeUndefined()
    expect(selectRuntime(join(root, 'missing'), 'darwin')).toBeUndefined()
  })

  it('maps a VSIX target to its platform and executable name', () => {
    expect(platformFromTarget('win32-x64')).toBe('win32')
    expect(platformFromTarget('darwin-arm64')).toBe('darwin')
    expect(platformFromTarget()).toBe(process.platform)
    expect(expectedExecutableName('win32')).toBe('dsh.exe')
    expect(expectedExecutableName('linux')).toBe('dsh')
  })

  it('copies nested runtime files and preserves the executable bit', () => {
    const source = makeDir(), destination = join(makeDir(), 'dsh')
    mkdirSync(join(source, 'runtime'), { recursive: true })
    writeFileSync(join(source, 'dsh'), 'launcher', { mode: 0o755 })
    writeFileSync(join(source, 'runtime', 'lib.dylib'), 'lib')
    copyRuntime(source, destination)
    expect(selectRuntime(destination, 'darwin')).toBeDefined()
  })
})
