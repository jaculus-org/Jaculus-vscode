import type * as vscode from 'vscode';
import { activate as activateJaculus, deactivate as deactivateJaculus } from '../src/extension.js';
import { activate as activateJacly, deactivate as deactivateJacly } from '../.jacly/extensions/vscode/src/extension.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activateJacly(context);
  await activateJaculus(context);
}

export function deactivate(): void {
  deactivateJacly();
  deactivateJaculus();
}
