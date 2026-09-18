import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.spec.ts'] },
  resolve: { alias: { vscode: fileURLToPath(new URL('./src/test/vscode.ts', import.meta.url)) } },
})
