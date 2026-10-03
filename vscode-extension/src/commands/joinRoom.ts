import * as vscode from 'vscode'
import { validateRoomName } from '../utils/validation'
import { Deps, JoinResult, joinAndShow } from './context'

export function registerJoinRoom(deps: Deps): vscode.Disposable {
  return vscode.commands.registerCommand('dropdrop.joinRoom', async (roomArg?: unknown): Promise<JoinResult | undefined> => {
    let name = typeof roomArg === 'string' ? roomArg : undefined
    if (name === undefined) {
      name = await vscode.window.showInputBox({
        title: 'DropDrop: Join Room',
        prompt: 'Room name. Anyone who enters the same name shares the same document.',
        placeHolder: 'e.g. team-notes',
        ignoreFocusOut: true,
        validateInput: (v) => validateRoomName(v.trim()) ?? undefined,
      })
      if (name === undefined) return undefined // cancelled
    }
    name = name.trim()
    const problem = validateRoomName(name)
    if (problem) {
      void vscode.window.showErrorMessage(`DropDrop: ${problem}`)
      return undefined
    }
    return joinAndShow(deps, name, 'Joined')
  })
}
