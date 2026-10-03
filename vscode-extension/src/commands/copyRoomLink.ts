import * as vscode from 'vscode'
import { showError } from '../utils/config'
import { roomShareUrl } from '../utils/urls'
import { Deps } from './context'

export function registerCopyRoomLink(deps: Deps): vscode.Disposable {
  return vscode.commands.registerCommand('dropdrop.copyRoomLink', async (): Promise<string | undefined> => {
    const session = deps.service.session
    if (!session) {
      void vscode.window.showInformationMessage('DropDrop: join or create a room first.')
      return undefined
    }
    try {
      const link = roomShareUrl(deps.service.endpoints, session.roomName)
      if (!link) {
        void vscode.window
          .showWarningMessage('DropDrop: set "dropdrop.publicAppUrl" (your website address) to copy a room link.', 'Open Settings')
          .then((pick) => pick && vscode.commands.executeCommand('dropdrop.openSettings'))
        return undefined
      }
      await vscode.env.clipboard.writeText(link)
      void vscode.window.showInformationMessage(`DropDrop: room link copied. ${link}`)
      return link
    } catch (err) {
      void showError(err, "Couldn't copy the room link")
      return undefined
    }
  })
}
