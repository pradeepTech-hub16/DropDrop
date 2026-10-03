import * as vscode from 'vscode'
import { Deps } from './context'

export function registerOpen(deps: Deps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('dropdrop.open', async (): Promise<boolean> => {
      if (deps.panel.show()) return true
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(add) Create Room', description: 'Start a new random room', command: 'dropdrop.createRoom' },
          { label: '$(sign-in) Join Room', description: 'Enter a room name', command: 'dropdrop.joinRoom' },
        ],
        { title: 'DropDrop', placeHolder: 'You are not in a room yet' },
      )
      if (pick) await vscode.commands.executeCommand(pick.command)
      return false
    }),
    vscode.commands.registerCommand('dropdrop.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'dropdrop.'),
    ),
  ]
}
