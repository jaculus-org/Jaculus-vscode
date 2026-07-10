import * as path from 'path';
import * as vscode from 'vscode';

import {
    createProjectFromArchiveData,
    createProjectFromPackage,
    createProjectFromTemplate,
    listLibraryVersions,
    listProjectTemplates,
    updateProjectFromPackage,
} from './integration.js';
import { createLogger, LogLevel } from './logging.js';
import type { JaculusLogger } from './integration.js';
import { DEFAULT_TERMINAL_NAME } from './monitorTerminal.js';

export type ProjectImportSource =
    | { type: 'template'; templateId: string; version?: string }
    | { type: 'package'; packageUrl: string }
    | { type: 'archive'; archiveData: Uint8Array };

export async function updateProjectFromPrompt(
    context: vscode.ExtensionContext,
    projectPath: string,
    logger: JaculusLogger
): Promise<void> {
    const packageUrl = await vscode.window.showInputBox({
        placeHolder: 'Enter the package URL for the Jaculus project',
        prompt: 'Package URL',
        value: context.globalState.get('jaculus.lastPackageUrl') as string || '',
    });

    const projectName = path.basename(projectPath);
    const authorized = await vscode.window.showWarningMessage(
        `This will update your Jaculus project in directory "${projectPath}". Some files may be overwritten.\nDo you want to continue?`,
        { modal: true },
        'Yes',
    );
    if (authorized !== 'Yes') {
        return;
    }

    if (!packageUrl) {
        vscode.window.showErrorMessage('Package URL is required');
        return;
    }

    await updateProjectFromPackage(projectPath, packageUrl, logger);
    vscode.window.showInformationMessage(`Updated project ${projectName}`);
    await context.globalState.update('jaculus.lastPackageUrl', packageUrl);
}

export function normalizeBase64(value: string): string {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const remainder = normalized.length % 4;
    return remainder === 0 ? normalized : `${normalized}${'='.repeat(4 - remainder)}`;
}

export function parseProjectImportSource(uri: vscode.Uri): ProjectImportSource {
    const params = new URLSearchParams(uri.query);
    const data = params.get('data');
    if (data) {
        return {
            type: 'archive',
            archiveData: Uint8Array.from(Buffer.from(normalizeBase64(data), 'base64')),
        };
    }

    const packageUrl = params.get('uri');
    if (packageUrl) {
        return { type: 'package', packageUrl };
    }

    const templateId = params.get('template');
    if (templateId) {
        return {
            type: 'template',
            templateId,
            version: params.get('version') ?? undefined,
        };
    }

    throw new Error('Unsupported project import URL. Expected one of: data, uri, template.');
}

async function selectProjectImportSource(
    context: vscode.ExtensionContext,
    projectPath: string,
    logger: JaculusLogger
): Promise<ProjectImportSource | undefined> {
    const customUrlLabel = 'Custom package URL';
    const templates = await listProjectTemplates(projectPath, logger);
    const source = await vscode.window.showQuickPick(
        [
            ...templates.map((template) => ({
                label: template.id,
                description: template.description,
            })),
            {
                label: customUrlLabel,
                description: 'Enter a template package URL manually',
            },
        ],
        { placeHolder: 'Select a project template or choose a custom package URL' }
    );

    if (!source) {
        return undefined;
    }

    if (source.label === customUrlLabel) {
        const packageUrl = await vscode.window.showInputBox({
            placeHolder: 'Enter package URL',
            prompt: 'Package URL',
            value: context.globalState.get('jaculus.lastPackageUrl')
                ? context.globalState.get('jaculus.lastPackageUrl') as string
                : undefined,
        });

        if (!packageUrl) {
            vscode.window.showErrorMessage('Package URL is required');
            return undefined;
        }

        await context.globalState.update('jaculus.lastPackageUrl', packageUrl);

        return { type: 'package', packageUrl };
    }

    return { type: 'template', templateId: source.label };
}

async function resolveTemplateVersion(
    projectPath: string,
    source: Extract<ProjectImportSource, { type: 'template' }>,
    logger: JaculusLogger
): Promise<string | undefined> {
    if (source.version) {
        return source.version;
    }

    const versions = await listLibraryVersions(projectPath, source.templateId, logger);
    const selectedVersion = await vscode.window.showQuickPick(versions, {
        placeHolder: `Select a version for ${source.templateId}`,
    });
    return selectedVersion ?? undefined;
}

async function closeJaculusTerminals(): Promise<void> {
    const jaculusTerminals = vscode.window.terminals.filter(t => t.name === DEFAULT_TERMINAL_NAME);

    if (jaculusTerminals.length === 0) {
        return;
    }

    const allClosed = new Promise<void>(resolve => {
        let remaining = jaculusTerminals.length;
        const disposable = vscode.window.onDidCloseTerminal(closedTerminal => {
            if (jaculusTerminals.includes(closedTerminal)) {
                remaining--;
                if (remaining <= 0) {
                    disposable.dispose();
                    resolve();
                }
            }
        });
    });

    for (const terminal of jaculusTerminals) {
        terminal.dispose();
    }

    await Promise.race([
        allClosed,
        new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
}

export async function createProjectWithSource(
    context: vscode.ExtensionContext,
    presetSource?: ProjectImportSource
): Promise<void> {
    const folderUri = await vscode.window.showOpenDialog({
        defaultUri: context.globalState.get('jaculus.lastProjectPath')
            ? vscode.Uri.file(context.globalState.get('jaculus.lastProjectPath') as string)
            : undefined,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Project Location',
        title: 'Choose where to create the project',
    });

    if (!folderUri || folderUri.length === 0) {
        vscode.window.showErrorMessage('No folder selected');
        return;
    }

    await context.globalState.update('jaculus.lastProjectPath', folderUri[0].fsPath);

    const projectName = await vscode.window.showInputBox({
        placeHolder: 'Enter project name',
        prompt: 'Project name',
    });
    if (!projectName) {
        vscode.window.showErrorMessage('Project name is required');
        return;
    }

    const projectPath = path.join(folderUri[0].fsPath, projectName);

    const outputChannel = vscode.window.createOutputChannel('Jaculus');
    const persistedLogLevel = context.globalState.get<LogLevel>('debugMode');
    const logLevel = Object.values(LogLevel).includes(persistedLogLevel as LogLevel)
        ? persistedLogLevel as LogLevel
        : LogLevel.info;
    const logger = createLogger(outputChannel, logLevel);

    try {
        const source = presetSource ?? await selectProjectImportSource(context, projectPath, logger);
        if (!source) {
            return;
        }

        if (source.type === 'package') {
            await context.globalState.update('jaculus.lastPackageUrl', source.packageUrl);
            await createProjectFromPackage(projectPath, source.packageUrl, logger);
        } else if (source.type === 'archive') {
            await createProjectFromArchiveData(projectPath, source.archiveData, logger);
        } else {
            const selectedVersion = await resolveTemplateVersion(projectPath, source, logger);
            if (!selectedVersion) {
                return;
            }
            await createProjectFromTemplate(
                projectPath,
                source.templateId,
                selectedVersion,
                logger
            );
        }

        await closeJaculusTerminals();
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), false);
        vscode.window.showInformationMessage(`Project ${projectName} created successfully at ${projectPath}`);
    } catch (error) {
        outputChannel.show(true);
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`[error] Error creating project: ${message}`);
        vscode.window.showErrorMessage(`Error creating project: ${message}`);
    }
}
