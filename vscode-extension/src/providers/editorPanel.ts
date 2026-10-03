import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import { CollaborationService, CollaborationSession } from '../services/collaborationService'
import { WebviewRelay } from '../services/webviewRelay'
import { showError } from '../utils/config'
import { roomShareUrl } from '../utils/urls'

export interface EditorPanelActions {
  copyLink(): Promise<void>
  leave(): void
}

/**
 * The collaborative editor, shown as a webview tab. The extension host owns the WebSocket and the shared
 * Y.Doc; the webview holds a CodeMirror editor bound to a replica of that doc. Updates are relayed both
 * ways by WebviewRelay, so there is exactly one connection to the server and no separate sync logic.
 */
export class EditorPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private relay: WebviewRelay | undefined
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: CollaborationService,
    private readonly actions: EditorPanelActions,
  ) {
    const onSession = (s: CollaborationSession | null) => this.onSession(s)
    service.on('session', onSession)
    this.disposables.push({ dispose: () => service.off('session', onSession) })
  }

  get isOpen(): boolean {
    return !!this.panel
  }

  /** Opens (or reveals) the editor for the current room. Returns false if no room is joined. */
  show(): boolean {
    const session = this.service.session
    if (!session) return false
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active)
      return true
    }
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist')
    const panel = vscode.window.createWebviewPanel('dropdrop.editor', `DropDrop: ${session.roomName}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [distUri],
    })
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon.png')
    panel.webview.html = this.html(panel.webview, distUri)
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m), undefined, this.disposables)
    panel.onDidDispose(() => {
      this.relay?.dispose()
      this.relay = undefined
      this.panel = undefined
    })
    this.panel = panel
    return true
  }

  dispose(): void {
    this.relay?.dispose()
    this.panel?.dispose()
    this.disposables.forEach((d) => d.dispose())
  }

  private onSession(session: CollaborationSession | null): void {
    this.relay?.dispose()
    this.relay = undefined
    if (!session) return void this.panel?.dispose() // left the room: close the editor tab
    if (this.panel) {
      this.panel.title = `DropDrop: ${session.roomName}`
      this.relay = this.createRelay(session)
      this.relay.sendInit() // push the new session's document into the already-open webview
    }
  }

  private createRelay(session: CollaborationSession): WebviewRelay {
    return new WebviewRelay(
      session,
      (msg) => void this.panel?.webview.postMessage(msg),
      {
        copyText: (text) => void vscode.env.clipboard.writeText(text).then(() => void this.panel?.webview.postMessage({ type: 'toast', text: 'Copied to clipboard' })),
        copyLink: () => void this.actions.copyLink(),
        reconnect: () => void this.service.rejoin().catch((e) => showError(e, 'Could not reconnect')),
        leave: () => this.actions.leave(),
      },
      () => {
        try {
          return roomShareUrl(this.service.endpoints, session.roomName)
        } catch {
          return null // invalid settings: no link
        }
      },
    )
  }

  private onMessage(raw: unknown): void {
    const session = this.service.session
    if (!session) return
    if (!this.relay || this.relay.session !== session) this.relay = this.createRelay(session)
    this.relay.handle(raw)
  }

  private html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64')
    const js = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js'))
    const css = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.css'))
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ')
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="csp-nonce" content="${nonce}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>DropDrop</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`
  }
}
