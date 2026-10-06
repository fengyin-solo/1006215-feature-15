// verify 前置步骤：把业务代码（含 @ 路径别名、TS）打成单文件 ESM，供 Node 直接执行校验脚本。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'

const root = fileURLToPath(new URL('..', import.meta.url))

await build({
  entryPoints: [fileURLToPath(new URL('../src/api/local-service.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../.verify-bundle/local-service.mjs', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  logLevel: 'warning',
})

await import('./verify-overhaul.mjs')

process.on('exit', () => {
  try {
    rmSync(fileURLToPath(new URL('../.verify-bundle', root)), { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
})
