import * as vscode from 'vscode'
import { Deps } from './context'

export function registerLeaveRoom(deps: Deps): vscode.Disposable {
  return vscode.commands.registerCommand('dropdrop.leaveRoom', (): boolean => {
    const session = deps.service.session
    if (!session) {
      void vscode.window.showInformationMessage('DropDrop: you are not in a room.')
      return false
    }
    const name = session.roomName
    deps.service.leave() // disconnects the WebSocket and disposes the Y.Doc; server data is untouched
    void vscode.window.showInformationMessage(`DropDrop: left "${name}". The document stays saved on the server.`)
    return true
  })
}
