import { appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Mocha from 'mocha'

// The extension host does not reliably forward stdout, so results are also written to DROPDROP_TEST_REPORT
// (set by runVscode.ts) as plain lines: PASS/FAIL/SKIP <title>, plus any load error.
const report = process.env.DROPDROP_TEST_REPORT
const log = (line: string) => {
  if (report) appendFileSync(report, line + '\n')
  console.log(line)
}

log('MODULE LOADED')
export function run(): Promise<void> {
  if (report) writeFileSync(report, '')
  log('RUN STARTED')
  try {
    const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 120_000, slow: 5_000 })
    const files = readdirSync(__dirname).filter((f) => f.endsWith('.test.js'))
    log('FILES ' + files.join(','))
    for (const f of files) mocha.addFile(path.join(__dirname, f))
    return new Promise((resolve, reject) => {
      const runner = mocha.run((failures) => {
        log(`DONE failures=${failures}`)
        failures ? reject(new Error(`${failures} VS Code test(s) failed`)) : resolve()
      })
      runner.on('hook', (h) => log('HOOK  ' + h.title))
      runner.on('pass', (t) => log(`PASS  ${t.fullTitle()}`))
      runner.on('pending', (t) => log(`SKIP  ${t.fullTitle()}`))
      runner.on('fail', (t, err) => log(`FAIL  ${t.fullTitle()} :: ${String(err?.message).split('\n').slice(0, 8).join(' | ')} @ ${String(err?.stack).split('\n').find((l) => l.includes('extension.test')) ?? ''}`))
    })
  } catch (err) {
    log(`LOAD-ERROR ${err instanceof Error ? err.stack : String(err)}`)
    throw err
  }
}
