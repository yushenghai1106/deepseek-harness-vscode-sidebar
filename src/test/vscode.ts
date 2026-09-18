// Minimal stand-in for the `vscode` API surface that provider code touches, so that view
// logic can be exercised under plain Node in unit tests. `vscode` itself only exists inside
// the editor; vitest aliases the module to this file.
import { promises as nodeFs } from 'node:fs'
import * as nodePath from 'node:path'

export interface Uri {
  readonly scheme: string
  readonly fsPath: string
  readonly path: string
  toString(): string
}

export class Disposable {
  constructor(private readonly callOnDispose?: () => void) { }

  dispose(): void { this.callOnDispose?.() }
}

export class RelativePattern {
  constructor(readonly base: unknown, readonly pattern: string) { }
}

export class Position {
  constructor(readonly line: number, readonly character: number) { }
}

export class Range {
  constructor(readonly start: Position, readonly end: Position) { }
}

export class Selection extends Range { }

export const Uri = {
  file(value: string): Uri {
    return { scheme: 'file', fsPath: value, path: value, toString: (): string => `file://${value}` }
  },
  joinPath(base: Uri, ...parts: string[]): Uri {
    return Uri.file(nodePath.join(base.fsPath, ...parts))
  },
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
export const TextEditorRevealType = { InCenter: 3, AtTop: 0, Default: 0 }
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 }

export const workspace = {
  workspaceFolders: undefined as unknown,
  fs: {
    createDirectory: async (uri: Uri): Promise<void> => { await nodeFs.mkdir(uri.fsPath, { recursive: true }) },
    writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => { await nodeFs.writeFile(uri.fsPath, content) },
    readFile: async (uri: Uri): Promise<Uint8Array> => await nodeFs.readFile(uri.fsPath),
    delete: async (uri: Uri, _options?: { useTrash?: boolean; recursive?: boolean }): Promise<void> => {
      await nodeFs.rm(uri.fsPath, { recursive: true, force: true })
    },
  },
  getConfiguration: (_section?: string) => ({ get: <T>(_key: string, fallback: T): T => fallback, update: async (): Promise<void> => undefined }),
  createFileSystemWatcher: (_pattern: RelativePattern) => ({
    onDidChange: (_listener: () => void): Disposable => new Disposable(),
    onDidCreate: (_listener: () => void): Disposable => new Disposable(),
    onDidDelete: (_listener: () => void): Disposable => new Disposable(),
    dispose: (): void => undefined,
  }),
  openTextDocument: async (_options?: unknown) => ({ lineCount: 0 }),
}

export const window = {
  activeTextEditor: undefined as unknown,
  showErrorMessage: (_message: string): undefined => undefined,
  showWarningMessage: (_message: string): undefined => undefined,
  showInputBox: (): Promise<string | undefined> => Promise.resolve(undefined),
  showSaveDialog: (): Promise<Uri | undefined> => Promise.resolve(undefined),
  showTextDocument: async (_document: unknown) => ({}),
}

export const commands = { executeCommand: async (): Promise<unknown> => undefined }
export const version = '1.104.0'
export const env = { appName: 'vitest' }
