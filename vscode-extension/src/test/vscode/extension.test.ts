// Runs INSIDE a real VS Code extension host, against the real backend and the isolated Atlas test database.
import * as assert from 'node:assert/strict'
import * as vscode from 'vscode'
import type { DropDropApi } from '../../extension'
import { CollaborationService } from '../../services/collaborationService'
import { requireEndpoints } from '../../utils/urls'
import { validateRoomName } from '../../utils/validation'
import { BackendHandle, SKIP_REASON, cleanupRooms, startBackend, waitFor } from '../support/backend'

const COMMANDS = ['dropdrop.open', 'dropdrop.joinRoom', 'dropdrop.createRoom', 'dropdrop.leaveRoom', 'dropdrop.copyRoomLink']
const prefix = `ext-vs-${Date.now().toString(36)}`
let n = 0
const room = () => `${prefix}-${++n}`
const cfg = () => vscode.workspace.getConfiguration('dropdrop')
const setSettings = async (api: string, ws: string, pub: string) => {
  await cfg().update('apiUrl', api, vscode.ConfigurationTarget.Global)
  await cfg().update('websocketUrl', ws, vscode.ConfigurationTarget.Global)
  await cfg().update('publicAppUrl', pub, vscode.ConfigurationTarget.Global)
}

suite('DropDrop extension (real VS Code, real backend)', function () {
  let api: DropDropApi
  let backend: BackendHandle
  const extras: CollaborationService[] = []

  suiteSetup(async function () {
    if (SKIP_REASON) return this.skip()
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'dropdrop')
    assert.ok(ext, 'extension under development is loaded')
    api = (await ext!.activate()) as DropDropApi
    backend = await startBackend()
    await setSettings(backend.apiUrl, backend.wsUrl, 'https://my-dropdrop.vercel.app')
  })

  teardown(() => {
    extras.splice(0).forEach((s) => s.dispose())
    api?.service.leave()
  })

  suiteTeardown(async () => {
    api?.service.dispose()
    await backend?.kill()
    if (!SKIP_REASON) console.log(`cleanup (isolated test database): ${cleanupRooms(prefix)}`)
    for (const k of ['apiUrl', 'websocketUrl', 'publicAppUrl']) await cfg().update(k, undefined, vscode.ConfigurationTarget.Global)
  })

  const extra = () => {
    const s = new CollaborationService(() => requireEndpoints({ apiUrl: backend.apiUrl, websocketUrl: backend.wsUrl, publicAppUrl: '' }), { maxBackoffTime: 200 })
    extras.push(s)
    return s
  }
  const connected = () => waitFor(() => api.service.session?.state.phase === 'connected' && api.service.session.state.synced, 'extension session connected+synced')

  test('1. extension activates and exposes its services', () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'dropdrop')!
    assert.equal(ext.isActive, true)
    assert.ok(api.service && api.panel)
  })

  test('2. all commands are registered and listed in the Command Palette', async () => {
    const all = await vscode.commands.getCommands(true)
    for (const c of COMMANDS) assert.ok(all.includes(c), `${c} registered`)
    const pkg = vscode.extensions.all.find((e) => e.packageJSON?.name === 'dropdrop')!.packageJSON
    const titles = pkg.contributes.commands.map((c: any) => `${c.category}: ${c.title}`)
    for (const t of ['DropDrop: Open DropDrop', 'DropDrop: Join Room', 'DropDrop: Create Room', 'DropDrop: Leave Room', 'DropDrop: Copy Room Link']) {
      assert.ok(titles.includes(t), `${t} contributed`)
    }
    assert.ok(pkg.contributes.viewsContainers.activitybar.some((v: any) => v.id === 'dropdrop'), 'activity bar container')
  })

  test('14. settings: dev defaults declared; production https/wss/Vercel URLs accepted; bad values explained', async () => {
    const props = vscode.extensions.all.find((e) => e.packageJSON?.name === 'dropdrop')!.packageJSON.contributes.configuration.properties
    assert.equal(props['dropdrop.apiUrl'].default, 'http://localhost:5000')
    assert.equal(props['dropdrop.websocketUrl'].default, 'ws://localhost:5000')
    assert.equal(props['dropdrop.publicAppUrl'].default, 'http://localhost:5173')

    try {
      await setSettings('https://api.example.com', 'wss://api.example.com', 'https://my-dropdrop.vercel.app')
      assert.deepEqual(api.service.endpoints, { apiUrl: 'https://api.example.com', wsUrl: 'wss://api.example.com/ws', publicAppUrl: 'https://my-dropdrop.vercel.app' })
      await setSettings('nope', 'nope', 'nope')
      // The extension is a separate bundle, so its ConfigError is a different class object: compare by name.
      assert.throws(() => api.service.endpoints, (e: any) => e?.name === 'ConfigError' && e.problems.length === 3)
    } finally {
      await setSettings(backend.apiUrl, backend.wsUrl, 'https://my-dropdrop.vercel.app')
    }
  })

  test('3. joining validates room names with the website rules', async () => {
    for (const bad of ['bad name', '-x', 'x'.repeat(65), '']) {
      assert.equal(await vscode.commands.executeCommand('dropdrop.joinRoom', bad), undefined, JSON.stringify(bad))
    }
    assert.equal(api.service.session, null)
    assert.equal(validateRoomName('ok-name_1'), null)
  })

  test('4/5. Join Room creates-or-retrieves the room, connects, and opens the editor', async () => {
    const r = room()
    const result = (await vscode.commands.executeCommand('dropdrop.joinRoom', r)) as { roomName: string; created: boolean }
    assert.deepEqual(result, { roomName: r, created: true })
    await connected()
    assert.equal(api.service.session!.roomName, r)
    assert.equal(api.panel.isOpen, true, 'editor webview panel is open')
    const again = (await vscode.commands.executeCommand('dropdrop.joinRoom', r)) as { created: boolean }
    assert.equal(again.created, false)
  })

  test('4. Create Room generates a valid random room and joins it', async () => {
    const result = (await vscode.commands.executeCommand('dropdrop.createRoom')) as { roomName: string; created: boolean }
    assert.ok(result)
    assert.equal(validateRoomName(result.roomName), null)
    assert.equal(result.created, true)
    await connected()
    assert.equal(api.service.session!.roomName, result.roomName)
    cleanupLater(result.roomName)
  })

  test('7. Copy Room Link puts the configured production URL on the clipboard', async () => {
    const r = room()
    await vscode.commands.executeCommand('dropdrop.joinRoom', r)
    await vscode.env.clipboard.writeText('')
    const link = await vscode.commands.executeCommand('dropdrop.copyRoomLink')
    assert.equal(link, `https://my-dropdrop.vercel.app/${r}`)
    assert.equal(await vscode.env.clipboard.readText(), `https://my-dropdrop.vercel.app/${r}`)
  })

  test('8. API failure: join fails cleanly with no half-open session', async () => {
    await setSettings('http://127.0.0.1:9', 'ws://127.0.0.1:9', 'https://my-dropdrop.vercel.app')
    try {
      assert.equal(await vscode.commands.executeCommand('dropdrop.joinRoom', room()), undefined)
      assert.equal(api.service.session, null)
    } finally {
      await setSettings(backend.apiUrl, backend.wsUrl, 'https://my-dropdrop.vercel.app')
    }
  })

  test('9/11. WebSocket + Yjs: edits sync between the extension and an independent client, both ways', async () => {
    const r = room()
    await vscode.commands.executeCommand('dropdrop.joinRoom', r)
    await connected()
    const other = (await extra().join(r)).session
    await waitFor(() => other.state.phase === 'connected' && other.state.synced, 'second client connected')
    const mine = api.service.session!
    mine.ytext.insert(0, 'from the extension')
    await waitFor(() => other.text === 'from the extension', 'second client receives the extension edit')
    other.ytext.insert(other.ytext.length, ' + from another client')
    await waitFor(() => mine.text === 'from the extension + from another client', 'extension receives the other edit')
    await waitFor(() => mine.state.peers.length === 2, 'real presence: two participants')
  })

  test('12. a different room stays isolated', async () => {
    const r1 = room(), r2 = room()
    await vscode.commands.executeCommand('dropdrop.joinRoom', r1)
    await connected()
    const other = (await extra().join(r2)).session
    await waitFor(() => other.state.synced, 'other synced')
    api.service.session!.ytext.insert(0, 'room one only')
    await waitFor(() => api.service.session!.state.persisted, 'persisted')
    assert.equal(other.text, '')
  })

  test('6/13. Leave Room disconnects, disposes resources, keeps server data, and closes the editor', async () => {
    const r = room()
    await vscode.commands.executeCommand('dropdrop.joinRoom', r)
    await connected()
    const session = api.service.session!
    session.ytext.insert(0, 'kept on the server')
    await waitFor(() => session.state.persisted, 'persisted')
    const watcher = (await extra().join(r)).session
    await waitFor(() => watcher.state.synced && watcher.state.peers.length === 2, 'watcher sees extension')

    assert.equal(await vscode.commands.executeCommand('dropdrop.leaveRoom'), true)
    assert.equal(api.service.session, null)
    assert.equal(session.isDisposed, true)
    assert.equal(session.provider.wsconnected, false)
    assert.equal(api.panel.isOpen, false, 'editor webview closed')
    await waitFor(() => watcher.state.peers.length === 1, 'presence removed on the server')

    await vscode.commands.executeCommand('dropdrop.joinRoom', r)
    await connected()
    assert.equal(api.service.session!.text, 'kept on the server')
    assert.equal(await vscode.commands.executeCommand('dropdrop.leaveRoom'), true)
    assert.equal(await vscode.commands.executeCommand('dropdrop.leaveRoom'), false, 'leaving when not in a room is harmless')
  })

  test('10. Reconnection: backend crash and restart are survived, offline edits are kept', async () => {
    const r = room()
    const port = backend.port
    await vscode.commands.executeCommand('dropdrop.joinRoom', r)
    await connected()
    const s = api.service.session!
    s.ytext.insert(0, 'before')
    await waitFor(() => s.state.persisted, 'persisted before crash')
    await backend.kill()
    await waitFor(() => s.state.phase === 'disconnected' || s.state.phase === 'reconnecting', 'outage detected')
    assert.notEqual(s.state.phase, 'connected')
    s.ytext.insert(s.ytext.length, ' + offline')
    backend = await startBackend({ port })
    await waitFor(() => s.state.phase === 'connected' && s.state.synced && s.state.persisted, 'reconnected and persisted', 90_000)
    const late = (await extra().join(r)).session
    await waitFor(() => late.state.synced, 'late client synced')
    assert.equal(late.text, 'before + offline')
  })

  function cleanupLater(_room: string) {
    /* rooms share the test prefix only for joinRoom tests; random Create Room names are removed by name below */
    randomRooms.push(_room)
  }
  const randomRooms: string[] = []
  suiteTeardown(() => {
    for (const r of randomRooms) {
      try {
        cleanupRooms(r)
      } catch {
        /* best effort */
      }
    }
  })
})
