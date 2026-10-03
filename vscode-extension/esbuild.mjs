// Build: extension host bundle (Node/CJS), webview bundle (browser/IIFE + CSS), and optionally test bundles.
import esbuild from 'esbuild'
import { readdirSync } from 'node:fs'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')
const tests = process.argv.includes('--tests')

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' }

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // 'vscode' is provided by the host; ws's native accelerators are optional and not shipped.
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
  },
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js', // the imported CSS is emitted next to it as dist/webview.css
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
]

if (tests) {
  const files = (dir) => readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => `${dir}/${f}`)
  builds.push({
    ...common,
    minify: false,
    sourcemap: true,
    entryPoints: [...files('src/test/unit'), ...files('src/test/vscode'), 'src/test/runVscode.ts', 'src/test/support/exports.ts'],
    outdir: 'out/test',
    outbase: 'src/test',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'mocha', 'bufferutil', 'utf-8-validate', '@vscode/test-electron'],
  })
}

for (const options of builds) {
  if (watch) await (await esbuild.context(options)).watch()
  else await esbuild.build(options)
}
