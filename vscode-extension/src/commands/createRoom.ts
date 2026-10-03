import * as vscode from 'vscode'
import { RoomService } from '../services/roomService'
import { showError } from '../utils/config'
import { randomRoomName } from '../utils/validation'
import { Deps, JoinResult, isCancelled, joinAndShow, withWakeProgress } from './context'

export function registerCreateRoom(deps: Deps): vscode.Disposable {
  return vscode.commands.registerCommand('dropdrop.createRoom', async (): Promise<JoinResult | undefined> => {
    try {
      const rooms = new RoomService(deps.service.endpoints.apiUrl)
      // Wait for a possibly sleeping server first (read-only), then reserve a random unused name. The reservation
      // request is idempotent and only repeated with a NEW name when the previous one already existed.
      const name = await withWakeProgress('DropDrop: creating a room…', async (wake) => {
        await rooms.waitUntilAwake(wake)
        let candidate = randomRoomName()
        for (let attempt = 0; attempt < 5; attempt++) {
          const { created } = await rooms.createRoom(candidate, wake.signal)
          if (created) break
          candidate = randomRoomName()
        }
        return candidate
      })
      const joined = await joinAndShow(deps, name, 'Created')
      // The name was reserved above, so from the user's point of view this room was just created.
      return joined && { ...joined, created: true }
    } catch (err) {
      if (isCancelled(err)) vscode.window.setStatusBarMessage('DropDrop: cancelled', 3000)
      else void showError(err, "Couldn't create a room")
      return undefined
    }
  })
}
