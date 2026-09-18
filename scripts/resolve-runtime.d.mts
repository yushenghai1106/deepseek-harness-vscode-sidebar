export interface RuntimeBundle {
  dir: string
  executable: string
  platform: string
  executableName: string
  crossPlatform?: boolean
}

export declare const repoRoot: string
export declare const defaultOutDir: string
export declare function selectRuntime(root: string, platform?: string): RuntimeBundle | undefined
export declare function expectedExecutableName(platform?: string): string
export declare function platformFromTarget(target?: string): string
export declare function copyRuntime(source: string, destination: string): void
