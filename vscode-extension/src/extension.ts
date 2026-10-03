import * as vscode from 'vscode'
import { registerCopyRoomLink } from './commands/copyRoomLink'
import { registerCreateRoom } from './commands/createRoom'
import { registerJoinRoom } from './commands/joinRoom'
import { registerLeaveRoom } from './commands/leaveRoom'
import { registerOpen } from './commands/open'
import { DropDropViewProvider } from './providers/dropdropViewProvider'
import { EditorPanel } from './providers/editorPanel'
import { CollaborationService, SessionState } from './services/collaborationService'
import { SECTION, getEndpoints, showError } from './utils/config'

/** Returned from activate() so integration tests can inspect real state. */
export interface DropDropApi {
  service: CollaborationService
  panel: EditorPanel
}

const STATUS_TEXT: Record<SessionState['phase'], string> = {
  connecting: '$(sync~spin) Connecting',
  connected: '$(check) Connected',
  disconnected: '$(debug-disconnect) Disconnected',
  reconnecting: '$(sync~spin) Reconnecting',
  closed: '$(error) Disconnected',
}

export function activate(context: vscode.ExtensionContext): DropDropApi {
  const service = new CollaborationService(getEndpoints)
  const panel = new EditorPanel(context, service, {
    copyLink: async () => void (await vscode.commands.executeCommand('dropdrop.copyRoomLink')),
    leave: () => void vscode.commands.executeCommand('dropdrop.leaveRoom'),
  })
  const deps = { service, panel }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  status.command = 'dropdrop.open'
  const renderStatus = (s: SessionState | null) => {
    void vscode.commands.executeCommand('setContext', 'dropdrop.inRoom', !!s)
    if (!s) {
      status.text = '$(droplet) DropDrop'
      status.tooltip = 'DropDrop: click to create or join a room'
    } else {
      status.text = `$(droplet) ${s.roomName} · ${STATUS_TEXT[s.phase]}`
      status.tooltip = s.closeMessage ?? `DropDrop room "${s.roomName}". Click to open the editor.`
    }
    status.show()
  }
  renderStatus(null)
  service.on('state', renderStatus)

  context.subscriptions.push(
    status,
    panel,
    { dispose: () => service.dispose() },
    vscode.window.registerWebviewViewProvider(DropDropViewProvider.viewType, new DropDropViewProvider(service)),
    registerJoinRoom(deps),
    registerCreateRoom(deps),
    registerLeaveRoom(deps),
    registerCopyRoomLink(deps),
    ...registerOpen(deps),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(SECTION) || !service.session) return
      const pick = await vscode.window.showInformationMessage('DropDrop: server settings changed. Reconnect to use the new addresses?', 'Reconnect')
      if (pick) service.rejoin().catch((err) => showError(err, 'Could not reconnect'))
    }),
  )
  return { service, panel }
}

export function deactivate(): void {
  /* everything is disposed through context.subscriptions */
}
