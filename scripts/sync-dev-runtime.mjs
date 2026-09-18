// `npm run package` runs vsce directly when invoked without a --target, which bypasses the
// packaging hook entirely. This exposes the same runtime sync as a standalone step so the
// working tree layout is correct before packaging from an IDE.
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { copyRuntime, defaultOutDir, expectedExecutableName, platformFromTarget, repoRoot, selectRuntime } from './resolve-runtime.mjs'

const platform = platformFromTarget(process.argv[2])
const expected = expectedExecutableName(platform)
const candidates = [
  defaultOutDir,
  join(repoRoot, 'bin', 'dsh-py'),
  join(repoRoot, 'bin', platform === 'win32' ? 'dsh-windows' : `dsh-${platform}`),
]

const found = candidates.map(candidate => selectRuntime(candidate, platform)).find(Boolean)
if (found === undefined) {
  console.error(`no runtime bundle found; checked:\n${candidates.map(candidate => `  - ${candidate}`).join('\n')}`)
  process.exit(1)
}

// Copy into a staging directory first so a bundle already living in bin/dsh is not deleted
// out from under the copy.
const staging = join(repoRoot, 'bin', '.dsh-staging')
rmSync(staging, { recursive: true, force: true })
copyRuntime(found.dir, staging)
rmSync(defaultOutDir, { recursive: true, force: true })
mkdirSync(join(repoRoot, 'bin'), { recursive: true })
renameSync(staging, defaultOutDir)

// Local bundles ship the launcher as `dsh-py`; the extension always looks for `dsh`.
if (found.executableName !== expected && !existsSync(join(defaultOutDir, expected))) renameSync(join(defaultOutDir, found.executableName), join(defaultOutDir, expected))
for (const extra of found.executableName === expected ? [] : ['dsh-py']) {
  const stray = join(defaultOutDir, extra)
  if (existsSync(stray)) rmSync(stray, { force: true })
}

const executable = join(defaultOutDir, expected)
if (!existsSync(executable)) { console.error(`runtime sync produced no ${expected}`); process.exit(1) }
console.log(`runtime ready: ${executable}`)
