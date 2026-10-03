// Cross-platform synchronisation tests (Part 11): website <-> VS Code extension <-> VS Code extension.
// See lib.mjs for what is real. Prerequisite (in vscode-extension): npm run build && node esbuild.mjs --tests
// Run (in e2e): npm test
import { createHarness } from './lib.mjs'

const h = await createHarness()
const { check, until, room, docText, same, sleep } = h

try {
  // ================= Test A: website -> VS Code =================
  const rA = room()
  const webA = await h.openWebsite(rA, 'siteA')
  const v1 = await h.openVsCode(rA, 'vsA1')
  await webA.click('.cm-content')
  await webA.keyboard.type('typed on the website')
  await until(async () => (await v1.text()) === 'typed on the website', 'A: VS Code webview shows the website edit')
  check('A. website edit -> VS Code webview', (await v1.text()) === 'typed on the website')
  check('A. website edit -> VS Code host session (shared Y.Doc)', v1.session.text === 'typed on the website')

  // ================= Test B: VS Code -> website =================
  await v1.page.click('.cm-content')
  await v1.page.keyboard.press('Control+End')
  await v1.page.keyboard.type(' | typed in VS Code')
  await until(async () => (await docText(webA)).includes('typed in VS Code'), 'B: website shows the VS Code edit')
  check('B. VS Code edit -> website', (await docText(webA)) === 'typed on the website | typed in VS Code')

  // ================= Test C: two VS Code instances at once =================
  const rC = room()
  const c1 = await h.openVsCode(rC, 'vsC1')
  const c2 = await h.openVsCode(rC, 'vsC2')
  await Promise.all([c1.type('1111111111111111111111111', 12), c2.type('2222222222222222222222222', 12)])
  await until(async () => (await same(c1.text, c2.text)) && (await c1.text()).length === 50, 'C: both VS Code instances converge')
  const tc = await c1.text()
  check('C. two VS Code instances, simultaneous typing: identical, nothing lost', (await same(c1.text, c2.text)) && (tc.match(/1/g) || []).length === 25 && (tc.match(/2/g) || []).length === 25, `(${tc.length} chars)`)
  check('C. host sessions agree with their webviews', c1.session.text === tc && c2.session.text === tc)

  // ================= Test D: website + two VS Code instances =================
  const rD = room()
  const webD = await h.openWebsite(rD, 'siteD')
  const d1 = await h.openVsCode(rD, 'vsD1')
  const d2 = await h.openVsCode(rD, 'vsD2')
  await Promise.all([
    (async () => { await webD.click('.cm-content'); await webD.keyboard.type('WWWWWWWWWWWWWWWWWWWW', 12) })(),
    d1.type('11111111111111111111', 12),
    d2.type('22222222222222222222', 12),
  ])
  await until(async () => (await same(() => docText(webD), d1.text, d2.text)) && (await d1.text()).length === 60, 'D: website + 2 VS Code converge')
  const td = await d1.text()
  check('D. website + two VS Code instances: identical, nothing lost', (await same(() => docText(webD), d1.text, d2.text)) && (td.match(/W/g) || []).length === 20 && (td.match(/1/g) || []).length === 20 && (td.match(/2/g) || []).length === 20, `(${td.length} chars)`)
  await until(async () => (await webD.getByTestId('presence').innerText()).includes('3 online'), 'D: presence 3 online on website')
  check('D. real presence on the website: 3 online', (await webD.getByTestId('presence').innerText()).includes('3 online'))
  await until(async () => (await d1.page.locator('#presence').innerText()).includes('3 online'), 'D: presence in VS Code webview')
  check('D. real presence in the VS Code webview: 3 online', (await d1.page.locator('#presence').innerText()).includes('3 online'))
  check('D. VS Code webview shows Connected and ✓ Saved', await d1.page.getByText('✓ Saved').waitFor({ timeout: 10000 }).then(() => true, () => false))

  // ---- shared editor features in the real webview ----
  await d1.page.selectOption('#lang', 'python')
  await until(async () => (await webD.inputValue('#lang')) === 'python' && (await d2.page.inputValue('#lang')) === 'python', 'language sync')
  check('language selected in VS Code reaches the website and the other VS Code', (await webD.inputValue('#lang')) === 'python' && (await d2.page.inputValue('#lang')) === 'python')
  await webD.selectOption('#lang', 'rust')
  await until(async () => (await d1.page.inputValue('#lang')) === 'rust', 'language sync back')
  check('language selected on the website reaches VS Code', (await d1.page.inputValue('#lang')) === 'rust')

  await d1.page.getByRole('button', { name: 'Copy', exact: true }).click()
  await until(() => d1.copied.length > 0, 'copy message')
  check('Copy sends the whole document to the host clipboard handler', d1.copied[0] === td)
  await d1.page.getByRole('button', { name: 'Select all' }).click()
  check('Select all selects the document', (await d1.page.evaluate(() => getSelection().toString())).replace(/\s/g, '').includes(td.replace(/\s/g, '').slice(0, 10)))

  // undo/redo only touches the local user's own edits (separate replica client id)
  const rU = room()
  const u1 = await h.openVsCode(rU, 'vsU1')
  const uWeb = await h.openWebsite(rU, 'siteU')
  await u1.type('mine')
  await until(async () => (await docText(uWeb)) === 'mine', 'U: website sees mine')
  await uWeb.click('.cm-content'); await uWeb.keyboard.press('Control+End'); await uWeb.keyboard.type('-theirs')
  await sleep(700) // longer than Yjs' 500ms undo-merge window, so later edits are separate undo steps
  await until(async () => (await u1.text()) === 'mine-theirs', 'U: VS Code sees theirs')
  await u1.page.click('.cm-content')
  await u1.page.keyboard.press('Control+z')
  await until(async () => (await docText(uWeb)) === '-theirs', 'U: undo removed only my text')
  check("Undo (Ctrl+Z) in VS Code removes only its own edit, not the website user's", (await u1.text()) === '-theirs' && (await docText(uWeb)) === '-theirs')
  await u1.page.keyboard.press('Control+y')
  await until(async () => (await docText(uWeb)) === 'mine-theirs', 'U: redo (Ctrl+Y)')
  check('Redo (Ctrl+Y) restores it everywhere', (await docText(uWeb)) === 'mine-theirs' && (await same(u1.text, () => docText(uWeb))))
  // the same on the website
  await uWeb.click('.cm-content'); await uWeb.keyboard.press('Control+End'); await uWeb.keyboard.type('!')
  await sleep(700)
  await uWeb.keyboard.press('Control+z')
  await until(async () => (await u1.text()) === 'mine-theirs', 'U: website undo')
  await uWeb.keyboard.press('Control+y')
  await until(async () => (await u1.text()) === 'mine-theirs!', 'U: website redo')
  check('Undo/redo also work on the website and sync to VS Code', (await u1.text()) === 'mine-theirs!')

  // clear with confirmation
  await d2.page.getByRole('button', { name: 'Clear', exact: true }).click()
  check('Clear asks for confirmation first', (await d2.page.getByRole('button', { name: 'Click again to confirm' }).isVisible()) && (await d2.text()).length === 60)
  await d2.page.getByRole('button', { name: 'Click again to confirm' }).click()
  await until(async () => (await docText(webD)) === '' && (await d1.text()) === '', 'clear propagates')
  check('Confirmed Clear empties the room on the website and in VS Code', (await docText(webD)) === '' && (await d1.text()) === '' && d1.session.text === '')

  // ================= Test E: restart the extension, recover the saved document =================
  const rE = room()
  const e1 = await h.openVsCode(rE, 'vsE1')
  await e1.type('saved before restart ✓')
  await e1.page.getByText('✓ Saved').waitFor({ timeout: 15000 })
  await e1.close() // extension deactivated / VS Code closed
  const e2 = await h.openVsCode(rE, 'vsE2') // new window, new extension host
  await until(async () => (await e2.text()) === 'saved before restart ✓', 'E: recovered')
  check('E. restarting the extension recovers the saved document', (await e2.text()) === 'saved before restart ✓')
  const webE = await h.openWebsite(rE, 'siteE')
  check('E. the website sees the same recovered document', (await docText(webE)) === 'saved before restart ✓')

  // ================= Test F: different rooms stay isolated =================
  const rF1 = room(), rF2 = room()
  const f1 = await h.openVsCode(rF1, 'vsF1')
  const webF2 = await h.openWebsite(rF2, 'siteF2')
  const f2 = await h.openVsCode(rF2, 'vsF2')
  await f1.type('only in room F1')
  await webF2.click('.cm-content'); await webF2.keyboard.type('only in room F2')
  await until(async () => (await f2.text()) === 'only in room F2', 'F2 sync')
  await sleep(600)
  check('F. rooms are isolated across website and VS Code (no leakage either way)',
    (await f1.text()) === 'only in room F1' && (await f2.text()) === 'only in room F2' && (await docText(webF2)) === 'only in room F2')
  check('F. presence is per room (VS Code room F1 shows 1 online)', (await f1.page.locator('#presence').innerText()).includes('1 online'))

  // ================= resilience: server crash/restart with website + VS Code connected =================
  const rR = room()
  const webR = await h.openWebsite(rR, 'siteR')
  const vR = await h.openVsCode(rR, 'vsR')
  await vR.type('before crash')
  await vR.page.getByText('✓ Saved').waitFor({ timeout: 15000 })
  await h.backend.kill()
  await vR.page.getByText(/Disconnected|Reconnecting…/).first().waitFor({ timeout: 15000 })
  check('VS Code webview shows Disconnected/Reconnecting (never "Connected") during an outage', (await vR.page.getByText('Connected', { exact: true }).count()) === 0)
  await vR.page.click('.cm-content'); await vR.page.keyboard.press('Control+End'); await vR.page.keyboard.type(' + offline in VS Code')
  await webR.click('.cm-content'); await webR.keyboard.press('Control+End'); await webR.keyboard.type(' + offline on web')
  await h.restartBackend()
  await until(async () => { const [a, b] = [await vR.text(), await docText(webR)]; return a === b && a.includes('offline in VS Code') && a.includes('offline on web') && a.includes('before crash') }, 'resilience: converge after restart', 90000)
  check('server restart: offline edits from website AND VS Code merge and converge', (await vR.text()) === (await docText(webR)) && (await vR.text()).includes('offline in VS Code') && (await vR.text()).includes('offline on web'))

  // ---- hygiene ----
  check('no uncaught page errors in any website or webview page', h.pageErrors.length === 0, h.pageErrors.slice(0, 3).join(' | '))
  const unexpected = h.consoleErrors.filter((e) => !/WebSocket connection|ERR_CONNECTION|Failed to load resource|net::/.test(e))
  check('no unexpected console errors (outage-related network errors excluded)', unexpected.length === 0, unexpected.slice(0, 3).join(' | '))
} finally {
  await h.teardown()
}

const failed = h.results.filter((r) => !r.ok)
console.log(`\n${h.results.length - failed.length}/${h.results.length} cross-platform checks passed`)
process.exit(failed.length ? 1 : 0)
