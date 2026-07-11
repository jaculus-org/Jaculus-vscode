import * as vscode from 'vscode';

export class JaculusViewProvider implements vscode.TreeDataProvider<JaculusTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<JaculusTreeItem | undefined | null | void> = new vscode.EventEmitter<JaculusTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<JaculusTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private selectedPort: string | undefined | null;
    private selectedSocket: string | undefined | null;
    private isMinimalMode: boolean = false;
    private logLevel: string = 'info';
    private installedLibraries: Array<{ name: string; version: string }> = [];

    constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.commands.registerCommand('jaculus.refreshTree', () => this.refresh()));

        this.isMinimalMode = context.globalState.get('minimalMode', false);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: JaculusTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: JaculusTreeItem): Thenable<JaculusTreeItem[]> {
        if (!element) {
            return Promise.resolve(this.getRootItems());
        }

        switch (element.contextValue) {
            case 'connection':
                return Promise.resolve(this.getConnectionItems());
            case 'build':
                return Promise.resolve(this.getBuildItems());
            case 'device':
                return Promise.resolve(this.getDeviceItems());
            case 'wifi':
                return Promise.resolve(this.getWiFiItems());
            case 'settings':
                return Promise.resolve(this.getSettingsItems());
            case 'libraries':
                return Promise.resolve(this.getLibraryItems());
            case 'project-management':
                return Promise.resolve(this.getProjectManagementItems());
            default:
                return Promise.resolve([]);
        }
    }

    private getRootItems(): JaculusTreeItem[] {
        return [
            new JaculusTreeItem(
                'Connection',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('plug'),
                'connection'
            ),
            new JaculusTreeItem(
                'Build & Flash',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('tools'),
                'build'
            ),
            new JaculusTreeItem(
                'Device Control',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('device-desktop'),
                'device'
            ),
            new JaculusTreeItem(
                'WiFi Configuration',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('rss'),
                'wifi'
            ),
            new JaculusTreeItem(
                'Settings',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('gear'),
                'settings'
            ),
            new JaculusTreeItem(
                'Libraries',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('library'),
                'libraries'
            ),
            new JaculusTreeItem(
                'Project Management',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('folder'),
                'project-management'
            )
        ];
    }

    private getConnectionItems(): JaculusTreeItem[] {
        const items: JaculusTreeItem[] = [];

        items.push(new JaculusTreeItem(
            'Select Port',
            vscode.TreeItemCollapsibleState.None,
            new vscode.ThemeIcon('selection'),
            'port-select',
            'jaculus.SelectComPort',
            'Select COM port or Socket connection'
        ));

        if (this.selectedPort) {
            items.push(new JaculusTreeItem(
                `Port: ${this.selectedPort}`,
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('info'),
                'port-info',
                'jaculus.SelectComPort'
            ));
        } else if (this.selectedSocket) {
            items.push(new JaculusTreeItem(
                `Socket: ${this.selectedSocket}`,
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('info'),
                'socket-info',
                'jaculus.SelectComPort'
            ));
        }

        return items;
    }

    private getBuildItems(): JaculusTreeItem[] {
        return [
            new JaculusTreeItem(
                'Build',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('database'),
                'build-action',
                'jaculus.Build',
                'Build the project'
            ),
            new JaculusTreeItem(
                'Flash',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('zap'),
                'flash-action',
                'jaculus.Flash',
                'Flash firmware to device'
            ),
            new JaculusTreeItem(
                'Monitor',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('eye'),
                'monitor-action',
                'jaculus.Monitor',
                'Monitor device output'
            ),
            new JaculusTreeItem(
                'Build, Flash & Monitor',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('diff-renamed'),
                'build-flash-monitor',
                'jaculus.BuildFlashMonitor',
                'Build, flash and monitor in one step'
            ),
        ];
    }

    private getDeviceItems(): JaculusTreeItem[] {
        return [
            new JaculusTreeItem(
                'Start Program',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('play-circle'),
                'start-program',
                'jaculus.Start',
                'Start the program on device'
            ),
            new JaculusTreeItem(
                'Stop Program',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('stop-circle'),
                'stop-program',
                'jaculus.Stop',
                'Stop the program on device'
            ),
            new JaculusTreeItem(
                'Show Version',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('versions'),
                'show-version',
                'jaculus.ShowVersion',
                'Show device version information'
            ),
            new JaculusTreeItem(
                'Show Status',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('pulse'),
                'show-status',
                'jaculus.ShowStatus',
                'Show device status'
            ),
            new JaculusTreeItem(
                'Browse Device Files',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('files'),
                'browse-device-files',
                'jaculus.BrowseDeviceFiles',
                'Browse files stored on the connected device'
            ),
            new JaculusTreeItem(
                'Format Storage',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('trash'),
                'format-storage',
                'jaculus.Format',
                'Format device storage'
            )
        ];
    }

    private getWiFiItems(): JaculusTreeItem[] {
        return [
            new JaculusTreeItem(
                'Configure WiFi',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('settings-gear'),
                'wifi-config',
                'jaculus.ConfigWiFi',
                'Configure WiFi settings'
            ),
        ];
    }

    private getSettingsItems(): JaculusTreeItem[] {
        let items: JaculusTreeItem[] = [
            new JaculusTreeItem(
                'Check for Jac Updates',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('sync'),
                'check-updates',
                'jaculus.CheckForUpdates',
                'Check for Jaculus tools updates'
            )
        ];

        if (this.isMinimalMode) {
            items.push(new JaculusTreeItem(
                'Disable Minimal Mode',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('eye-closed'),
                'disable-minimal-mode',
                'jaculus.ToggleMinimalMode',
                'Disable minimal mode'
            ));
        } else {
            items.push(new JaculusTreeItem(
                'Enable Minimal Mode',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('eye'),
                'enable-minimal-mode',
                'jaculus.ToggleMinimalMode',
                'Enable minimal mode'
            ));
        }

        items.push(new JaculusTreeItem(
            `Set Log Level (${this.logLevel})`,
            vscode.TreeItemCollapsibleState.None,
            new vscode.ThemeIcon('debug'),
            'log-level',
            'jaculus.SetLogLevel',
            'Set log level for Jaculus'
        ));

        return items;
    }

    private getLibraryItems(): JaculusTreeItem[] {
        const items: JaculusTreeItem[] = [
            new JaculusTreeItem(
                'Refresh Libraries',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('refresh'),
                'refresh-libraries',
                'jaculus.RefreshLibraries',
                'Reinstall the library versions declared by this project'
            ),
            new JaculusTreeItem(
                'Update Libraries',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('versions'),
                'update-libraries',
                'jaculus.UpdateLibraries',
                'Update direct project libraries to their newest versions'
            ),
            new JaculusTreeItem(
                'Install Library',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('cloud-download'),
                'install-library',
                'jaculus.InstallLibrary',
                'Install a library from the configured Jaculus registry'
            ),
            new JaculusTreeItem(
                'Remove Library',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('trash'),
                'remove-library',
                'jaculus.RemoveLibrary',
                'Remove an installed library from the project'
            ),
        ];

        if (this.installedLibraries.length === 0) {
            items.push(new JaculusTreeItem(
                'No installed libraries',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('info'),
                'library-info',
                undefined,
                'No direct project libraries are currently installed'
            ));
            return items;
        }

        for (const library of this.installedLibraries) {
            items.push(new JaculusTreeItem(
                `${library.name}@${library.version}`,
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('package'),
                'library-item',
                undefined,
                library.name
            ));
        }

        return items;
    }

    private getProjectManagementItems(): JaculusTreeItem[] {
        return [
            new JaculusTreeItem(
                'Create New Project',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('new-file'),
                'create-project',
                'jaculus.CreateProject',
                'Create a new Jaculus project'
            ),
            new JaculusTreeItem(
                'Update Project',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('sync'),
                'update-project',
                undefined,
                'Update the current Jaculus project',
                {
                    command: 'jaculus.UpdateProject',
                    title: 'Update Project',
                    arguments: []
                }
            )
        ];
    }

    public updateConnectionStatus(port?: string | null, socket?: string | null): void {
        this.selectedPort = port;
        this.selectedSocket = socket;

        this.refresh();
    }

    public updateMinimalMode(isMinimal: boolean): void {
        this.isMinimalMode = isMinimal;
        this.refresh();
    }

    public updateLogLevel(level: string): void {
        this.logLevel = level;
        this.refresh();
    }

    public updateInstalledLibraries(libraries: Array<{ name: string; version: string }>): void {
        this.installedLibraries = libraries;
        this.refresh();
    }
}

class JaculusTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly iconPath?: string | vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri },
        public readonly contextValue?: string,
        public readonly commandId?: string,
        public readonly tooltipText?: string,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);

        this.tooltip = tooltipText || label;
        this.contextValue = contextValue;
        this.command = command;

        if (commandId) {
            this.command = {
                command: commandId,
                title: label
            };
        }

        if (iconPath) {
            this.iconPath = iconPath;
        }
    }
}
