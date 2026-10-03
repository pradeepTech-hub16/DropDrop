import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import { CollaborationService, SessionState } from '../services/collaborationService'
import { ACCESS_WARNING } from '../utils/validation'

const ALLOWED_COMMANDS = new Set([
  'dropdrop.createRoom',
  'dropdrop.joinRoom',
  'dropdrop.open',
  'dropdrop.copyRoomLink',
  'dropdrop.leaveRoom',
  'dropdrop.openSettings',
])

/** Sidebar (activity bar) view: room controls and live status. The editor itself opens as a tab. */
export class DropDropViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'dropdrop.home'
  private view: vscode.WebviewView | undefined

  constructor(private readonly service: CollaborationService) {
    service.on('state', () => this.push())
    service.on('session', () => this.push())
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((m) => {
      if (m?.type === 'command' && typeof m.command === 'string' && ALLOWED_COMMANDS.has(m.command)) {
        void vscode.commands.executeCommand(m.command)
      } else if (m?.type === 'ready') {
        this.push()
      }
    })
    view.onDidDispose(() => (this.view = undefined))
  }

  private push(): void {
    const s = this.service.session?.state ?? null
    void this.view?.webview.postMessage({ type: 'state', state: s satisfies SessionState | null })
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64')
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root { --mint: #3ddc97; }
  body { padding: 0 12px 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  h1 { font-size: 15px; margin: 14px 0 2px; } h1 span { color: var(--mint); }
  .tag { color: var(--vscode-descriptionForeground); margin: 0 0 14px; }
  button { width: 100%; margin: 3px 0; padding: 6px 10px; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-radius: 2px; font: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--mint); color: #12201a; font-weight: 600; border-color: transparent; }
  button.primary:hover { filter: brightness(0.92); }
  .card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; padding: 8px 10px; margin: 10px 0; }
  .room { font-family: var(--vscode-editor-font-family); word-break: break-all; }
  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; margin-top: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b949e; }
  .connected .dot { background: var(--mint); } .busy .dot { background: #f5a623; } .bad .dot { background: #f14c4c; }
  .peers { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .warn { font-size: 11px; color: var(--vscode-descriptionForeground); border-left: 2px solid #f5a623; padding-left: 8px; margin-top: 14px; }
  .err { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 6px; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  [hidden] { display: none !important; }
</style></head>
<body>
<h1>Drop<span>Drop</span></h1>
<p class="tag">Drop it. Share it. Sync it.</p>
<button class="primary" data-cmd="dropdrop.createRoom">Create Room</button>
<button data-cmd="dropdrop.joinRoom">Join Room…</button>
<div id="room" class="card" hidden>
  <div>Current room</div>
  <div class="room" id="name"></div>
  <div class="pill" id="pill"><span class="dot"></span><span id="status"></span></div>
  <div class="pill" id="saved"></div>
  <div class="peers" id="peers"></div>
  <div class="err" id="err" hidden></div>
  <div style="margin-top:8px">
    <button class="primary" data-cmd="dropdrop.open">Open Editor</button>
    <button data-cmd="dropdrop.copyRoomLink">Copy Room Link</button>
    <button data-cmd="dropdrop.leaveRoom">Leave Room</button>
  </div>
</div>
<p class="warn">${ACCESS_WARNING}</p>
<p><a data-cmd="dropdrop.openSettings">Server settings</a></p>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]'); if (el) vscode.postMessage({ type: 'command', command: el.dataset.cmd });
  });
  const $ = (id) => document.getElementById(id);
  const LABEL = { connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected', reconnecting: 'Reconnecting…', closed: 'Disconnected' };
  window.addEventListener('message', (e) => {
    const s = e.data && e.data.state;
    $('room').hidden = !s; if (!s) return;
    $('name').textContent = s.roomName;
    $('status').textContent = LABEL[s.phase];
    $('pill').className = 'pill ' + (s.phase === 'connected' ? 'connected' : s.phase === 'closed' || s.phase === 'disconnected' ? 'bad' : 'busy');
    $('saved').textContent = s.phase === 'connected' ? (s.persisted ? '✓ Saved' : 'Saving…') : (s.persisted ? 'Offline' : 'Unsynced: kept locally');
    const online = s.phase === 'connected' && s.synced ? s.peers : null;
    $('peers').textContent = online ? online.length + ' online: ' + online.map((p) => p.name + (p.isSelf ? ' (you)' : '')).join(', ') : '';
    $('err').hidden = !s.closeMessage; $('err').textContent = s.closeMessage || '';
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`
  }
}
