// Resolves the runtime bundle layout (`bin/<dir>/<executable>`) shared by the VSIX
// packaging script and the dev-layout sync below. Kept dependency-free so it can be
// imported from both plain Node scripts and the vitest suite.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const defaultOutDir = join(repoRoot, 'bin', 'dsh')

const isWindowsExecutable = (name) => name.toLowerCase() === 'dsh.exe'

/** Matches the runtime bundle the release workflow produces, plus the `dsh-py` launcher name used by local builds. */
const candidatesFor = (platform) => platform === 'win32' ? ['dsh.exe', 'dsh-py.exe'] : ['dsh', 'dsh-py']

/** Sibling binaries (`dsh-rg`, `dsh-spawn-helper`) are arch-specific, so the host platform decides what may be used. */
export function selectRuntime(root, platform = process.platform) {
  if (!existsSync(root)) return undefined
  for (const name of candidatesFor(platform)) {
    const executable = join(root, name)
    if (existsSync(executable)) return { dir: root, executable, platform, executableName: name }
  }
  const present = readdirSync(root).filter(isWindowsExecutable)
  if (present.length === 0) return undefined
  return { dir: root, executable: join(root, present[0]), platform, crossPlatform: platform !== 'win32', executableName: present[0] }
}

/** The packaged executable name must be stable even when a local bundle only provides the `dsh-py` launcher. */
export const expectedExecutableName = (platform = process.platform) => platform === 'win32' ? 'dsh.exe' : 'dsh'

/** Reads the platform out of a VSIX target such as `darwin-x64`, falling back to the host. */
export function platformFromTarget(target) {
  if (target === undefined || target === '') return process.platform
  return target.split('-')[0]
}

/** Recursively copies the runtime bundle, preserving symlinks and skipping sockets that appear inside Python frameworks. */
export function copyRuntime(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name)
    if (entry.isDirectory()) { copyRuntime(from, to); continue }
    if (entry.isSymbolicLink()) { symlinkSync(linkTargetOf(from), to); continue }
    if (entry.isSocket() || entry.isFIFO() || entry.isCharacterDevice() || entry.isBlockDevice()) continue
    copyFileSync(from, to)
    if (entry.isFile()) { const mode = lstatSync(from).mode; chmodSync(to, mode & 0o777) }
  }
}

function linkTargetOf(path) {
  const linked = lstatSync(path)
  void linked
  return readlinkSync(path)
}
