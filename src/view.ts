import * as vscode from 'vscode';

export class JaculusViewProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | null | void> = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private selectedPort: string | undefined | null;
    private selectedSocket: string | undefined | null;
    private isMinimalMode: boolean = false;
    private logLevel: string = 'info'; // Default log level

    constructor(context: vscode.ExtensionContext) {
        const refreshCommand = vscode.commands.registerCommand('jaculus.refreshTree', () => this.refresh());

        this.isMinimalMode = context.globalState.get('minimalMode', false);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeItem): Thenable<TreeItem[]> {
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
            case 'project-management':
                return Promise.resolve(this.getProjectManagementItems());
            default:
                return Promise.resolve([]);
        }
    }

    private getRootItems(): TreeItem[] {
        return [
            new TreeItem(
                'Connection',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('plug'),
                'connection'
            ),
            new TreeItem(
                'Build & Flash',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('tools'),
                'build'
            ),
            new TreeItem(
                'Device Control',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('device-desktop'),
                'device'
            ),
            new TreeItem(
                'WiFi Configuration',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('rss'),
                'wifi'
            ),
            new TreeItem(
                'Settings',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('gear'),
                'settings'
            ),
            new TreeItem(
                'Project Management',
                vscode.TreeItemCollapsibleState.Expanded,
                new vscode.ThemeIcon('folder'),
                'project-management'
            )
        ];
    }

    private getConnectionItems(): TreeItem[] {
        const items: TreeItem[] = [];

        // Port selection
        items.push(new TreeItem(
            'Select Port',
            vscode.TreeItemCollapsibleState.None,
            new vscode.ThemeIcon('selection'),
            'port-select',
            'jaculus.SelectComPort',
            'Select COM port or Socket connection'
        ));

        // Selected port info
        if (this.selectedPort) {
            items.push(new TreeItem(
                `Port: ${this.selectedPort}`,
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('info'),
                'port-info',
                'jaculus.SelectComPort'
            ));
        } else if (this.selectedSocket) {
            items.push(new TreeItem(
                `Socket: ${this.selectedSocket}`,
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('info'),
                'socket-info',
                'jaculus.SelectComPort'
            ));
        }

        return items;
    }

    private getBuildItems(): TreeItem[] {
        return [
            new TreeItem(
                'Build',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('database'),
                'build-action',
                'jaculus.Build',
                'Build the project'
            ),
            new TreeItem(
                'Flash',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('zap'),
                'flash-action',
                'jaculus.Flash',
                'Flash firmware to device'
            ),
            new TreeItem(
                'Monitor',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('eye'),
                'monitor-action',
                'jaculus.Monitor',
                'Monitor device output'
            ),
            new TreeItem(
                'Build, Flash & Monitor',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('diff-renamed'),
                'build-flash-monitor',
                'jaculus.BuildFlashMonitor',
                'Build, flash and monitor in one step'
            ),
        ];
    }

    private getDeviceItems(): TreeItem[] {
        return [
            new TreeItem(
                'Start Program',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('play-circle'),
                'start-program',
                'jaculus.Start',
                'Start the program on device'
            ),
            new TreeItem(
                'Stop Program',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('stop-circle'),
                'stop-program',
                'jaculus.Stop',
                'Stop the program on device'
            ),
            new TreeItem(
                'Show Version',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('versions'),
                'show-version',
                'jaculus.ShowVersion',
                'Show device version information'
            ),
            new TreeItem(
                'Show Status',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('pulse'),
                'show-status',
                'jaculus.ShowStatus',
                'Show device status'
            ),
            new TreeItem(
                'Format Storage',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('trash'),
                'format-storage',
                'jaculus.Format',
                'Format device storage'
            )
        ];
    }

    private getWiFiItems(): TreeItem[] {
        return [
            new TreeItem(
                'Configure WiFi',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('settings-gear'),
                'wifi-config',
                'jaculus.ConfigWiFi',
                'Configure WiFi settings'
            ),
        ];
    }

    private getSettingsItems(): TreeItem[] {
        let items: TreeItem[] = [
            new TreeItem(
                'Check for Jac Updates',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('sync'),
                'check-updates',
                'jaculus.CheckForUpdates',
                'Check for Jaculus tools updates'
            )
        ];

        if (this.isMinimalMode) {
            items.push(new TreeItem(
                'Disable Minimal Mode',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('eye-closed'),
                'disable-minimal-mode',
                'jaculus.ToggleMinimalMode',
                'Disable minimal mode'
            ));
        } else {
            items.push(new TreeItem(
                'Enable Minimal Mode',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('eye'),
                'enable-minimal-mode',
                'jaculus.ToggleMinimalMode',
                'Enable minimal mode'
            ));
        }

        items.push(new TreeItem(
            `Set Log Level (${this.logLevel})`,
            vscode.TreeItemCollapsibleState.None,
            new vscode.ThemeIcon('debug'),
            'log-level',
            'jaculus.SetLogLevel',
            'Set log level for Jaculus'
        ));

        return items
    }

    private getProjectManagementItems(): TreeItem[] {
        return [
            new TreeItem(
                'Create New Project',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('new-file'),
                'create-project',
                'jaculus.CreateProject',
                'Create a new Jaculus project'
            ),
            new TreeItem(
                'Update Project',
                vscode.TreeItemCollapsibleState.None,
                new vscode.ThemeIcon('sync'),
                'updateProject',
                '',
                'Update the current Jaculus project',
                {
                    command: 'jaculus.UpdateProject',
                    title: 'Update Project',
                    arguments: []
                }
            )
        ];
    }

    // Method to update connection status from the main extension
    public updateConnectionStatus(port?: string | null, socket?: string | null): void {
        this.selectedPort = port;
        this.selectedSocket = socket;

        this.refresh();
    }

    // Method to update minimal mode status
    public updateMinimalMode(isMinimal: boolean): void {
        this.isMinimalMode = isMinimal;
        this.refresh();
    }

    // Method to update log level
    public updateLogLevel(level: string): void {
        this.logLevel = level;
        this.refresh();
    }
}

class TreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly iconPath?: string | vscode.ThemeIcon | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri },
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
