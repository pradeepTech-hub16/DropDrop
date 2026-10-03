import * as vscode from 'vscode'
import { ApiError } from '../services/roomService'
import { ConfigError, Endpoints, EndpointSettings, requireEndpoints, resolveEndpoints } from './urls'

export const SECTION = 'dropdrop'
export const DEV_DEFAULTS: EndpointSettings = {
  apiUrl: 'http://localhost:5000',
  websocketUrl: 'ws://localhost:5000',
  publicAppUrl: 'http://localhost:5173',
}

export function readSettings(): EndpointSettings {
  const c = vscode.workspace.getConfiguration(SECTION)
  return {
    apiUrl: c.get<string>('apiUrl', DEV_DEFAULTS.apiUrl),
    websocketUrl: c.get<string>('websocketUrl', DEV_DEFAULTS.websocketUrl),
    publicAppUrl: c.get<string>('publicAppUrl', DEV_DEFAULTS.publicAppUrl),
  }
}

/** Current endpoints; throws ConfigError (with every problem listed) if the settings are invalid. */
export function getEndpoints(): Endpoints {
  return requireEndpoints(readSettings())
}

export function settingsWarnings(): string[] {
  return resolveEndpoints(readSettings()).warnings
}

export function openSettings(): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.action.openSettings', 'dropdrop.')
}

/** Turns any failure into a helpful, non-technical notification. Never includes document contents. */
export async function showError(err: unknown, context: string): Promise<void> {
  const settings = 'Open Settings'
  if (err instanceof ConfigError) {
    const pick = await vscode.window.showErrorMessage(`DropDrop: ${context}. Check your server settings:\n${err.problems.join('\n')}`, settings)
    if (pick === settings) await openSettings()
    return
  }
  if (err instanceof ApiError) {
    const msg = err.status === 0 ? err.message : `${err.message}`
    const pick = await vscode.window.showErrorMessage(`DropDrop: ${context}. ${msg}`, ...(err.status === 0 ? [settings] : []))
    if (pick === settings) await openSettings()
    return
  }
  if (err instanceof RangeError) {
    await vscode.window.showErrorMessage(`DropDrop: ${err.message}`)
    return
  }
  await vscode.window.showErrorMessage(`DropDrop: ${context}. ${err instanceof Error ? err.message : 'Unexpected error.'}`)
}
