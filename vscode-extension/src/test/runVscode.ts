// Launches a real VS Code instance (isolated profile) and runs src/test/vscode/*.test.ts inside its extension host.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'

const REPORT_FILE = path.join(tmpdir(), 'dropdrop-vscode-test-report.txt')

async function main() {
  const overrideExe = process.env.VSCODE_TEST_EXE // read before the VSCODE_* scrub below
  // When launched from inside VS Code's terminal these would make the test instance attach to the running
  // editor (or run as plain Node) instead of starting an isolated one.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE' || key === 'ELECTRON_NO_ATTACH_CONSOLE') delete process.env[key]
  }
  const extensionDevelopmentPath = path.resolve(__dirname, '../../')
  const extensionTestsPath = path.resolve(__dirname, './vscode/index')

  // A separate, downloaded copy of VS Code (cached in .vscode-test/), so the developer's own installation and
  // profile are never used or modified. Set VSCODE_TEST_EXE to use a specific executable instead.
  const vscodeExecutablePath = overrideExe || (await downloadAndUnzipVSCode('stable'))

  process.env.DROPDROP_TEST_REPORT = REPORT_FILE
  console.log('test report file:', REPORT_FILE)
  const profile = mkdtempSync(path.join(tmpdir(), 'dropdrop-vscode-test-'))
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      '--disable-extensions', // only DropDrop is loaded (via extensionDevelopmentPath)
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${path.join(profile, 'user-data')}`, // isolated: never touches the real profile
      `--extensions-dir=${path.join(profile, 'extensions')}`,
    ],
  })
}

/** VS Code's own shutdown can exit non-zero after a clean run; the Mocha report written by the tests is authoritative. */
function reportedOutcome(reportFile: string): 'passed' | 'failed' | 'unknown' {
  if (!existsSync(reportFile)) return 'unknown'
  const text = readFileSync(reportFile, 'utf8')
  const done = /^DONE failures=(\d+)/m.exec(text)
  if (!done) return 'unknown'
  return done[1] === '0' && !/^FAIL /m.test(text) ? 'passed' : 'failed'
}

/** The window occasionally dies before Mocha starts its first hook (observed ~1 launch in 3 here). Retry once. */
async function runWithRetry(): Promise<void> {
  try {
    await main()
  } catch (err) {
    const startedTests = existsSync(REPORT_FILE) && /^HOOK|^PASS|^FAIL/m.test(readFileSync(REPORT_FILE, 'utf8'))
    if (startedTests) throw err // tests really ran: do not mask a genuine failure
    console.warn('VS Code window exited before any test started; retrying once.')
    await main()
  }
}

runWithRetry()
  .catch((err) => {
    const outcome = reportedOutcome(REPORT_FILE)
    if (outcome === 'passed') {
      console.warn('VS Code exited non-zero during shutdown, but every test passed (see report).')
      return
    }
    console.error('VS Code tests failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => {
    if (!existsSync(REPORT_FILE)) return
    const lines = readFileSync(REPORT_FILE, 'utf8').split('\n')
    console.log(lines.filter((l) => /^(PASS|FAIL|SKIP|DONE)/.test(l)).join('\n'))
  })
