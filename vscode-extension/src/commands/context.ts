import * as vscode from 'vscode'
import { CollaborationService } from '../services/collaborationService'
import type { EditorPanel } from '../providers/editorPanel'
import { WAKE_MESSAGE, WakeOptions } from '../services/roomService'
import { showError } from '../utils/config'
import { ACCESS_WARNING } from '../utils/validation'
import { roomShareUrl } from '../utils/urls'

export interface Deps {
  service: CollaborationService
  panel: EditorPanel
}

export interface JoinResult {
  roomName: string
  created: boolean
}

export const isCancelled = (err: unknown) => (err as { name?: string })?.name === 'AbortError'

/**
 * Runs `fn` under a cancellable progress notification. If the server turns out to be asleep (a free-tier host),
 * the notification says so; pressing Cancel aborts the wait cleanly.
 */
export function withWakeProgress<T>(title: string, fn: (wake: Required<Pick<WakeOptions, 'signal' | 'onWaking'>>) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
    const controller = new AbortController()
    token.onCancellationRequested(() => controller.abort())
    return fn({ signal: controller.signal, onWaking: () => progress.report({ message: WAKE_MESSAGE }) })
  })
}

/** Shared by Join and Create: connect, open the editor, and tell the user how to share. */
export async function joinAndShow(deps: Deps, roomName: string, verb: 'Joined' | 'Created'): Promise<JoinResult | undefined> {
  try {
    const result = await withWakeProgress(`DropDrop: opening ${roomName}…`, (wake) => deps.service.join(roomName, wake))
    deps.panel.show()
    let link: string | null = null
    try {
      link = roomShareUrl(deps.service.endpoints, roomName)
    } catch {
      /* invalid settings were already reported by join */
    }
    const what = verb === 'Created' || result.created ? `Created room "${roomName}".` : `Joined room "${roomName}".`
    const actions = link ? ['Copy Link'] : []
    void vscode.window
      .showInformationMessage(`DropDrop: ${what}${link ? ` Share: ${link}` : ''}\n${ACCESS_WARNING}`, ...actions)
      .then((pick) => pick === 'Copy Link' && vscode.commands.executeCommand('dropdrop.copyRoomLink'))
    return { roomName, created: result.created }
  } catch (err) {
    if (isCancelled(err)) {
      vscode.window.setStatusBarMessage('DropDrop: cancelled', 3000) // the user pressed Cancel: not an error
    } else {
      void showError(err, `Couldn't open room "${roomName}"`)
    }
    return undefined
  }
}
