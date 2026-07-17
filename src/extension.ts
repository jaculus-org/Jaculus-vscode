import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { JacDevice } from '@jaculus/device';
import { WifiMode } from '@jaculus/device';
import {
    createDeviceBrowserItems,
    DeviceFileSystemProvider,
    getDeviceChildPath,
    getDeviceParentPath,
} from './deviceFileBrowser.js';
import {
    addWifiNetwork,
    compileProject,
    connectToDevice,
    ConnectionTarget,
    createProjectFromArchiveData,
    createProjectFromPackage,
    createProjectFromTemplate,
    disableWifi,
    destroyDevice,
    formatStorage,
    getSkippedBuildMessage,
    getBoardFirmwareUrl,
    installFirmwarePackage,
    installLibraryVersion,
    getWifiMode,
    listAvailableLibraries,
    listBoardVersions,
    listBoards,
    listInstalledLibraries,
    listLibraryVersions,
    listSavedWifiNetworks,
    listSerialPorts,
    readStatus,
    readVersion,
    readWifiStatus,
    refreshLibraries as refreshProjectLibraries,
    removeLibrary as removeProjectLibrary,
    removeWifiNetwork,
    setWifiApMode,
    setWifiStationMode,
    startProgram,
    stopProgram,
    updateLibraries as updateProjectLibraries,
    withDeviceStorage,
    shouldBuildProject,
    flashProject,
    flashProjectOnDevice,
} from './jaculus/integration.js';
import type { JaculusLogger, BoardVariant, BoardVersion } from './jaculus/integration.js';
import { LogLevel, createLogger } from './jaculus/logging.js';
import { getMonitorEcho, getMonitorErrorOutput, getMonitorStatusOutput } from './jaculus/monitor.js';
import { DEFAULT_TERMINAL_NAME, JaculusMonitorPseudoterminal } from './jaculus/monitorTerminal.js';
import {
    createProjectWithSource,
    parseProjectImportSource,
    updateProjectFromPrompt,
} from './jaculus/projectManagement.js';
import { JaculusViewProvider } from './view.js';

enum ConnectionType {
    comPort = "comPort",
    socket = "socket"
}

enum ContextKey {
    selectedComPort = "selectedComPort",
    selectedSocket = "selectedSocket",
    selectedSocketMemory = "selectedSocketMemory",
    lastSelectedConnection = "lastSelectedConnection",
    minimalMode = "minimalMode",
    debugMode = "debugMode"
}

type PortSelectionItem = {
    label: string;
    description?: string;
    type: 'port' | 'socket';
};

const DEFAULT_PORT = "17531";

class JaculusInterface {
    private selectComPortBtn: vscode.StatusBarItem | null = null;
    private outputChannel: vscode.OutputChannel;
    private terminalJaculus: vscode.Terminal | null = null;
    private monitorDevice: JacDevice | null = null;
    private monitorPty: JaculusMonitorPseudoterminal | null = null;
    private monitorConnection: Promise<void> | null = null;

    private selectedComPort: string | null = null;
    private selectedSocket: string | null = null;
    private selectedSocketMemory: string[] = [];
    private lastSelectedConnection: ConnectionType | null = null;
    private minimalMode: boolean = false;
    private debugMode: LogLevel = LogLevel.info;

    constructor(
        private context: vscode.ExtensionContext,
        private readonly viewProvider: JaculusViewProvider,
        private readonly deviceFileSystemProvider: DeviceFileSystemProvider,
        private projectPath: string
    ) {
        this.outputChannel = vscode.window.createOutputChannel('Jaculus');
        this.context.subscriptions.push(this.outputChannel);

        this.selectedComPort = this.context.globalState.get<string>(ContextKey.selectedComPort) ?? null;
        this.selectedSocket = this.context.globalState.get<string>(ContextKey.selectedSocket) ?? null;
        this.selectedSocketMemory = this.context.globalState.get<string[]>(ContextKey.selectedSocketMemory) ?? [];
        const persistedConnection = this.context.globalState.get<ConnectionType>(ContextKey.lastSelectedConnection);
        this.lastSelectedConnection = Object.values(ConnectionType).includes(persistedConnection as ConnectionType)
            ? persistedConnection ?? null
            : null;

        this.minimalMode = this.context.globalState.get<boolean>(ContextKey.minimalMode) ?? false;
        const persistedLogLevel = this.context.globalState.get<LogLevel>(ContextKey.debugMode);
        this.debugMode = Object.values(LogLevel).includes(persistedLogLevel as LogLevel)
            ? persistedLogLevel ?? LogLevel.info
            : LogLevel.info;
        this.viewProvider.updateMinimalMode(this.minimalMode);
        this.viewProvider.updateLogLevel(this.debugMode);

        this.context.subscriptions.push(vscode.window.onDidCloseTerminal((closedTerminal: vscode.Terminal) => {
            if (this.terminalJaculus === closedTerminal) {
                void this.disposeMonitorTerminal();
            }
        }));
    }

    private async selectPort() {
        try {
            const socketSelectionLabel = "Remote socket";
            let items: PortSelectionItem[] = (await listSerialPorts())
                .map(port => ({ label: port.path, description: port.manufacturer, type: 'port' as const }));
            items.push({ label: socketSelectionLabel, description: "Enter IP and port of your Jaculus device", type: 'socket' as const });
            items = [...items, ...this.selectedSocketMemory.map(socket => ({ label: socket, description: "Previously selected socket", type: 'socket' as const }))];

            const selected = await vscode.window.showQuickPick(items);
            if (selected === undefined || selected.label === undefined) {
                return;
            }

            if (selected.label === socketSelectionLabel || selected.type === 'socket') {
                const socketTmp = selected.label === socketSelectionLabel
                    ? await vscode.window.showInputBox({
                        placeHolder: 'Enter ip and port of your jaculus device',
                        title: 'Select Socket',
                        prompt: `IP:PORT (default port: ${DEFAULT_PORT})`,
                    })
                    : selected.label;

                if (socketTmp === undefined) {
                    vscode.window.showErrorMessage('No socket selected');
                    return;
                }

                const socketValue = socketTmp.trim().includes(":")
                    ? socketTmp.trim()
                    : `${socketTmp.trim()}:${DEFAULT_PORT}`;
                this.selectedSocket = socketValue;
                await this.context.globalState.update(ContextKey.selectedSocket, this.selectedSocket);
                this.lastSelectedConnection = ConnectionType.socket;
                this.viewProvider.updateConnectionStatus(undefined, this.selectedSocket);

                this.selectedSocketMemory = [
                    this.selectedSocket,
                    ...this.selectedSocketMemory.filter((socket): socket is string => socket !== this.selectedSocket),
                ].slice(0, 5);
                await this.context.globalState.update(ContextKey.selectedSocketMemory, this.selectedSocketMemory);
            } else {
                this.selectedComPort = selected.label;
                await this.context.globalState.update(ContextKey.selectedComPort, selected.label);
                this.lastSelectedConnection = ConnectionType.comPort;
                this.viewProvider.updateConnectionStatus(this.selectedComPort, undefined);
            }

            await this.context.globalState.update(ContextKey.lastSelectedConnection, this.lastSelectedConnection);
            this.updateSelectedPortMenu(true);
        } catch (error) {
            this.showError(error, 'Error listing ports');
        }
    }

    private updateSelectedPortMenu(showNotification = false): void {
        if (this.lastSelectedConnection === ConnectionType.comPort) {
            this.selectComPortBtn && (this.selectComPortBtn.text = this.getButtonText("$(plug) COM", `: ${this.selectedComPort!.replace('/dev/tty.', '')}`));
            if (showNotification) {
                vscode.window.showInformationMessage(`Selected COM port: ${this.selectedComPort}`);
            }
            this.viewProvider.updateConnectionStatus(this.selectedComPort, undefined);
        } else if (this.lastSelectedConnection === ConnectionType.socket) {
            this.selectComPortBtn && (this.selectComPortBtn.text = this.getButtonText("$(plug) Sock", `et: ${this.selectedSocket!}`));
            if (showNotification) {
                vscode.window.showInformationMessage(`Selected Socket: ${this.selectedSocket}`);
            }
            this.viewProvider.updateConnectionStatus(undefined, this.selectedSocket);
        } else {
            this.selectComPortBtn && (this.selectComPortBtn.text = this.getButtonText("$(plug)", " Select Port"));
        }
    }

    private async build(showSkippedMessage = true): Promise<boolean> {
        if (!shouldBuildProject(this.projectPath)) {
            const message = getSkippedBuildMessage(showSkippedMessage);
            if (message) {
                vscode.window.showInformationMessage(message);
            }
            return true;
        }

        try {
            const saved = await vscode.workspace.saveAll(false);
            if (!saved) {
                throw new Error('Failed to save all files');
            }
            const compiled = await compileProject(this.projectPath, this.getLogger());
            if (!compiled) {
                throw new Error('Compilation failed');
            }
            vscode.window.showInformationMessage('Build finished successfully');
            return true;
        } catch (error) {
            this.showError(error, 'Build failed');
            return false;
        }
    }

    private async flash(autoStart = true): Promise<boolean> {
        try {
            const target = this.getConnectedTarget();
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Flashing Jaculus device',
                cancellable: false,
            }, async (progress: vscode.Progress<{ message?: string; increment?: number }>) => {
                await this.runWithClosedMonitor(async () => {
                    await flashProject(
                        this.projectPath,
                        target,
                        this.getLogger(),
                        (event) => {
                            if (event.message.length > 0) {
                                this.outputChannel.appendLine(event.message);
                            }
                            progress.report({
                                message: event.message,
                                increment: event.increment,
                            });
                        },
                        autoStart
                    );
                });
            });
            vscode.window.showInformationMessage('Flash finished successfully');
            return true;
        } catch (error) {
            this.showError(error, 'Flash failed');
            return false;
        }
    }

    private bindMonitorDevice(device: JacDevice): void {
        const decoder = new TextDecoder();
        device.programOutput.onData((data: Uint8Array) => {
            this.monitorPty?.write(decoder.decode(data, { stream: true }));
        });
        const errorDecoder = new TextDecoder();
        device.programError.onData((data: Uint8Array) => {
            this.monitorPty?.write(getMonitorErrorOutput(errorDecoder.decode(data, { stream: true })));
        });
        device.onEnd(() => {
            if (this.monitorDevice !== device) {
                return;
            }
            this.monitorPty?.write(getMonitorStatusOutput('\nDevice disconnected\n'));
            void this.monitorStop();
        });
    }

    private createMonitorTerminal(): void {
        this.monitorPty = new JaculusMonitorPseudoterminal(
            async () => undefined,
            async (data: string) => {
                if (data === '\x03') {
                    await this.monitorStop();
                    this.monitorPty?.write(getMonitorStatusOutput('\nMonitoring stopped. Run Monitor to reconnect.\n'));
                    return;
                }

                const echo = getMonitorEcho(data);
                if (echo !== null) {
                    this.monitorPty?.write(echo);
                }

                if (this.monitorDevice) {
                    this.monitorDevice.programInput.write(new TextEncoder().encode(data === '\r' ? '\n' : data));
                }
            },
            async () => {
                await this.disposeMonitorTerminal();
            }
        );

        this.terminalJaculus = vscode.window.createTerminal({
            name: DEFAULT_TERMINAL_NAME,
            pty: this.monitorPty,
            iconPath: new vscode.ThemeIcon('gear'),
        });
    }

    private async connectMonitor(): Promise<void> {
        if (this.monitorDevice) {
            return;
        }

        if (this.monitorConnection) {
            return this.monitorConnection;
        }

        this.monitorConnection = (async () => {
            try {
                this.monitorDevice = await connectToDevice(
                    this.getConnectedTarget(),
                    this.getLogger(),
                    (device) => this.bindMonitorDevice(device)
                );
                this.monitorPty?.write(getMonitorStatusOutput('Connected. Press Ctrl+C to stop monitoring.\n'));
            } catch (error) {
                this.monitorPty?.write(getMonitorStatusOutput(`Connection failed: ${error instanceof Error ? error.message : String(error)}\n`));
                await this.monitorStop();
                throw error;
            } finally {
                this.monitorConnection = null;
            }
        })();

        return this.monitorConnection;
    }

    private async monitor(): Promise<void> {
        if (!this.terminalJaculus || !this.monitorPty) {
            this.createMonitorTerminal();
        }

        this.terminalJaculus?.show();
        await this.connectMonitor();
    }

    private async buildFlashMonitor(): Promise<void> {
        if (!await this.build(false)) {
            return;
        }

        try {
            await this.monitor();
            const device = this.monitorDevice;
            if (!device) {
                throw new Error('Monitor connection was cancelled');
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Flashing Jaculus device',
                cancellable: false,
            }, async (progress: vscode.Progress<{ message?: string; increment?: number }>) => {
                await flashProjectOnDevice(
                    this.projectPath,
                    device,
                    this.getLogger(),
                    (event) => {
                        if (event.message.length > 0) {
                            this.outputChannel.appendLine(event.message);
                        }
                        progress.report({ message: event.message, increment: event.increment });
                    },
                    true
                );
            });
            vscode.window.showInformationMessage('Flash finished successfully');
        } catch (error) {
            await this.monitorStop();
            this.showError(error, 'Build, flash and monitor failed');
        }
    }

    private async refreshInstalledLibraries(): Promise<void> {
        try {
            const libraries = await listInstalledLibraries(
                this.projectPath,
                this.getLogger()
            );
            this.viewProvider.updateInstalledLibraries(libraries);
        } catch (error) {
            this.showError(error, 'Failed to load installed libraries');
        }
    }

    private async refreshLibraries(): Promise<void> {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing libraries',
                cancellable: false,
            }, async () => refreshProjectLibraries(this.projectPath, this.getLogger()));
            await this.refreshInstalledLibraries();
            vscode.window.showInformationMessage('Libraries refreshed successfully');
        } catch (error) {
            this.showError(error, 'Failed to refresh libraries');
        }
    }

    private async updateLibraries(): Promise<void> {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Updating libraries',
                cancellable: false,
            }, async () => updateProjectLibraries(this.projectPath, this.getLogger()));
            await this.refreshInstalledLibraries();
            vscode.window.showInformationMessage('Libraries updated successfully');
        } catch (error) {
            this.showError(error, 'Failed to update libraries');
        }
    }

    private async installLibrary(): Promise<void> {
        try {
            const libraries = await listAvailableLibraries(
                this.projectPath,
                this.getLogger()
            );

            if (libraries.length === 0) {
                vscode.window.showInformationMessage('No libraries available in the configured registries.');
                return;
            }

            const selectedLibrary = await vscode.window.showQuickPick(
                libraries.map((library) => ({
                    label: library.id,
                    description: library.description,
                })),
                { placeHolder: 'Select a library to install' }
            );

            if (!selectedLibrary) {
                return;
            }

            const versions = await listLibraryVersions(
                this.projectPath,
                selectedLibrary.label,
                this.getLogger()
            );

            if (versions.length === 0) {
                vscode.window.showInformationMessage(`No versions available for ${selectedLibrary.label}.`);
                return;
            }

            const selectedVersion = await vscode.window.showQuickPick(versions, {
                placeHolder: `Select a version for ${selectedLibrary.label}`,
            });

            if (!selectedVersion) {
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Installing ${selectedLibrary.label}@${selectedVersion}`,
                cancellable: false,
            }, async () => {
                await installLibraryVersion(
                    this.projectPath,
                    selectedLibrary.label,
                    selectedVersion,
                    this.getLogger()
                );
            });

            await this.refreshInstalledLibraries();
            vscode.window.showInformationMessage(`Installed ${selectedLibrary.label}@${selectedVersion}`);
        } catch (error) {
            this.showError(error, 'Failed to install library');
        }
    }

    private async removeLibrary(): Promise<void> {
        try {
            const libraries = await listInstalledLibraries(
                this.projectPath,
                this.getLogger()
            );

            if (libraries.length === 0) {
                vscode.window.showInformationMessage('No installed libraries to remove.');
                return;
            }

            const selectedLibrary = await vscode.window.showQuickPick(
                libraries.map((library) => ({
                    label: library.name,
                    description: library.version,
                })),
                { placeHolder: 'Select a library to remove' }
            );

            if (!selectedLibrary) {
                return;
            }

            await removeProjectLibrary(
                this.projectPath,
                selectedLibrary.label,
                this.getLogger()
            );

            await this.refreshInstalledLibraries();
            vscode.window.showInformationMessage(`Removed ${selectedLibrary.label}`);
        } catch (error) {
            this.showError(error, 'Failed to remove library');
        }
    }

    private async start() {
        try {
            if (this.monitorDevice) {
                await this.monitorDevice.controller.lock();
                try {
                    await this.monitorDevice.controller.start('');
                } finally {
                    await this.monitorDevice.controller.unlock();
                }
            } else {
                const target = this.getConnectedTarget();
                await startProgram(target, this.getLogger());
            }
            vscode.window.showInformationMessage('Program started');
        } catch (error) {
            this.showError(error, 'Failed to start program');
        }
    }

    private async stop() {
        try {
            if (this.monitorDevice) {
                await this.monitorDevice.controller.lock();
                try {
                    await this.monitorDevice.controller.stop();
                } finally {
                    await this.monitorDevice.controller.unlock();
                }
            } else {
                const target = this.getConnectedTarget();
                await stopProgram(target, this.getLogger());
            }
            vscode.window.showInformationMessage('Program stopped');
        } catch (error) {
            this.showError(error, 'Failed to stop program');
        }
    }
    private async showVersion() {
        try {
            const target = this.getConnectedTarget();
            const version = await this.runWithClosedMonitor(async () =>
                readVersion(target, this.getLogger())
            );
            this.outputChannel.show(true);
            this.outputChannel.appendLine('Firmware version:');
            version.forEach(line => this.outputChannel.appendLine(`  ${line}`));
        } catch (error) {
            this.showError(error, 'Failed to read version');
        }
    }

    private async showStatus() {
        try {
            const target = this.getConnectedTarget();
            const status = await this.runWithClosedMonitor(async () =>
                readStatus(target, this.getLogger())
            );
            this.outputChannel.show(true);
            this.outputChannel.appendLine(`Running: ${status.running}`);
            if (!status.running) {
                this.outputChannel.appendLine(`Last exit code: ${status.exitCode}`);
            }
            this.outputChannel.appendLine(status.status);
        } catch (error) {
            this.showError(error, 'Failed to read status');
        }
    }

    private async format() {
        const confirmation = await vscode.window.showWarningMessage(
            'Formatting storage permanently deletes all files on the connected device.',
            { modal: true },
            'Format Storage'
        );
        if (confirmation !== 'Format Storage') {
            return;
        }

        try {
            const target = this.getConnectedTarget();
            await this.runWithClosedMonitor(async () => {
                await formatStorage(target, this.getLogger());
            });
            vscode.window.showInformationMessage('Storage formatted');
        } catch (error) {
            this.showError(error, 'Failed to format storage');
        }
    }

    private async monitorStop(): Promise<void> {
        const device = this.monitorDevice;
        this.monitorDevice = null;
        if (device) {
            await destroyDevice(device);
        }
    }

    private async disposeMonitorTerminal(): Promise<void> {
        const terminal = this.terminalJaculus;
        const pty = this.monitorPty;

        this.terminalJaculus = null;
        this.monitorPty = null;

        await this.monitorStop();
        terminal?.dispose();
        pty?.dispose();
    }

    private async selectLogLevel() {
        const items = Object.keys(LogLevel);
        const selected = await vscode.window.showQuickPick(items);
        if (!selected) {
            return;
        }

        this.debugMode = LogLevel[selected as keyof typeof LogLevel];
        await this.context.globalState.update(ContextKey.debugMode, this.debugMode);
        this.viewProvider.updateLogLevel(this.debugMode);
    }

    private getConnectedTarget(): ConnectionTarget {
        if (this.lastSelectedConnection === ConnectionType.comPort) {
            return { type: 'port', value: this.selectedComPort! };
        } else if (this.lastSelectedConnection === ConnectionType.socket) {
            return { type: 'socket', value: this.selectedSocket! };
        } else {
            vscode.window.showErrorMessage('Jaculus: No port selected');
            throw new Error('Jaculus: No port selected');
        }
    }

    private async stopRunningMonitor(): Promise<void> {
        const pendingConnection = this.monitorConnection;
        if (pendingConnection) {
            try {
                await pendingConnection;
            } catch {
                // The monitor reports connection errors through its own output path.
            }
        }
        await this.monitorStop();
    }

    private async runWithClosedMonitor<T>(operation: () => Promise<T>): Promise<T> {
        await this.stopRunningMonitor();
        return operation();
    }

    private async browseDeviceFiles(): Promise<void> {
        try {
            const target = this.getConnectedTarget();
            const selectedFile = await this.runWithClosedMonitor(() =>
                withDeviceStorage(target, this.getLogger(), async (storage) => {
                    let currentDirectory = '.';
                    const cancellation = new vscode.CancellationTokenSource();
                    storage.onDidDisconnect(() => cancellation.cancel());

                    try {
                        while (true) {
                            const entries = await storage.listDirectory(currentDirectory);
                            const selected = await vscode.window.showQuickPick(
                                createDeviceBrowserItems(currentDirectory, entries),
                                { placeHolder: `Device files: ${currentDirectory}` },
                                cancellation.token
                            );

                            if (!selected) {
                                return undefined;
                            }

                            switch (selected.action) {
                                case 'parent':
                                    currentDirectory = getDeviceParentPath(currentDirectory);
                                    break;
                                case 'directory':
                                    if (selected.name) {
                                        currentDirectory = getDeviceChildPath(currentDirectory, selected.name);
                                    }
                                    break;
                                case 'file': {
                                    if (!selected.name) {
                                        break;
                                    }
                                    const filePath = getDeviceChildPath(currentDirectory, selected.name);
                                    return {
                                        path: filePath,
                                        data: await storage.readFile(filePath),
                                    };
                                }
                                case 'empty':
                                    break;
                            }
                        }
                    } finally {
                        cancellation.dispose();
                    }
                })
            );

            if (!selectedFile) {
                return;
            }

            const uri = this.deviceFileSystemProvider.setFile(selectedFile.path, selectedFile.data);
            await vscode.commands.executeCommand('vscode.open', uri);
        } catch (error) {
            this.showError(error, 'Failed to browse device files');
        }
    }

    private async configWiFi() {
        /* eslint-disable @typescript-eslint/naming-convention */
        const wifiCommands: Record<string, string> = {
            "$(search) Display current WiFi config": "wifi-get",
            "$(list-unordered) List saved WiFi networks": "wifi-ls",
            "$(add) Add a WiFi network": "wifi-add",
            "$(remove) Remove a WiFi network": "wifi-rm",
            "$(debug-disconnect) Disable WiFi": "wifi-disable",
            "$(radio-tower) Set WiFi to Station mode (connect to a wifi)": "wifi-sta",
            "$(broadcast) Set WiFi to AP mode (create a hotspot)": "wifi-ap",
        };
        /* eslint-enable @typescript-eslint/naming-convention */

        const selectedOption = await vscode.window.showQuickPick(Object.keys(wifiCommands), { placeHolder: 'Select a WiFi configuration option' });

        if (selectedOption) {
            const command = wifiCommands[selectedOption];

            switch (command) {
                case "wifi-get":
                    this.wifiGet();
                    break;
                case "wifi-ls":
                    this.wifiList();
                    break;
                case "wifi-ap":
                    this.wifiAp();
                    break;
                case "wifi-add":
                    this.wifiAdd();
                    break;
                case "wifi-rm":
                    this.wifiRm();
                    break;
                case "wifi-sta":
                    this.wifiSta();
                    break;
                case "wifi-disable":
                    this.wifiDisable();
                    break;
                default:
                    vscode.window.showInformationMessage(`Error: ${command} does not exist`);
            }
        }
    }

    private async wifiGet() {
        try {
            const target = this.getConnectedTarget();
            const status = await this.runWithClosedMonitor(async () =>
                readWifiStatus(target, this.getLogger())
            );
            this.outputChannel.show(true);
            this.outputChannel.appendLine(status);
        } catch (error) {
            this.showError(error, 'Failed to read WiFi config');
        }
    }

    private async wifiList() {
        try {
            const target = this.getConnectedTarget();
            const networks = await this.runWithClosedMonitor(async () =>
                listSavedWifiNetworks(target, this.getLogger())
            );
            this.outputChannel.show(true);
            this.outputChannel.appendLine(networks.length === 0 ? 'No saved networks' : networks.join('\n'));
        } catch (error) {
            this.showError(error, 'Failed to list saved WiFi networks');
        }
    }

    private async getWifiCredentials(): Promise<{ ssid: string, password: string | undefined } | undefined> {
        const ssid = await vscode.window.showInputBox({ placeHolder: 'Enter WiFi network SSID', prompt: 'WiFi network SSID' });
        if (!ssid) {
            return undefined;
        }

        const password = await vscode.window.showInputBox({ placeHolder: 'Enter WiFi network password', prompt: 'WiFi network password', password: true });
        return { ssid, password };
    }

    private async wifiAp() {
        try {
            const credentials = await this.getWifiCredentials();
            if (!credentials) {
                return;
            }
            const { ssid, password } = credentials;
            const target = this.getConnectedTarget();
            await this.runWithClosedMonitor(async () => {
                await setWifiApMode(target, ssid, password, this.getLogger());
            });
            vscode.window.showInformationMessage('WiFi AP mode configured');
        } catch (error) {
            this.showError(error, 'Failed to configure WiFi AP mode');
        }
    }

    private async wifiAdd() {
        try {
            const credentials = await this.getWifiCredentials();
            if (!credentials) {
                return;
            }
            const { ssid, password } = credentials;
            const target = this.getConnectedTarget();
            await this.runWithClosedMonitor(async () => {
                await addWifiNetwork(target, ssid, password ?? '', this.getLogger());
            });

            const currentMode = await this.runWithClosedMonitor(async () => getWifiMode(target, this.getLogger()));
            if (currentMode !== WifiMode.STATION) {
                const connectLabel = 'Switch to station mode (connect to wifi)';
                const keepLabel = 'Keep current WiFi mode';
                const choice = await vscode.window.showQuickPick([connectLabel, keepLabel], { placeHolder: `Added WiFi network: ${ssid}. Connect to WiFi now?` });
                if (choice === connectLabel) {
                    if (await this.configureStationMode(target, ssid)) {
                        vscode.window.showInformationMessage(`Added WiFi network: ${ssid}. Connected to WiFi.`);
                    }
                    return;
                }
            }

            vscode.window.showInformationMessage(`Added WiFi network: ${ssid}`);
        } catch (error) {
            this.showError(error, 'Failed to add WiFi network');
        }
    }

    private async wifiRm() {
        try {
            const target = this.getConnectedTarget();
            const savedNetworks = await this.runWithClosedMonitor(async () =>
                listSavedWifiNetworks(target, this.getLogger())
            );
            if (savedNetworks.length === 0) {
                vscode.window.showInformationMessage('No saved networks to remove.');
                return;
            }
            const ssid = await vscode.window.showQuickPick(savedNetworks, { placeHolder: 'Select a saved network to remove' });
            if (!ssid) {
                return;
            }
            await this.runWithClosedMonitor(async () => {
                await removeWifiNetwork(target, ssid, this.getLogger());
            });
            vscode.window.showInformationMessage(`Removed WiFi network: ${ssid}`);
        } catch (error) {
            this.showError(error, 'Failed to remove WiFi network');
        }
    }

    private async configureStationMode(target: ConnectionTarget, preferredSsid?: string): Promise<boolean> {
        const bestSignalLabel = 'Best signal (auto-connect to any known network)';
        const specificLabel = preferredSsid ? `Specific network: ${preferredSsid}` : 'Specific network...';
        const modeChoice = await vscode.window.showQuickPick([specificLabel, bestSignalLabel], { placeHolder: 'Select a station mode' });
        if (!modeChoice) {
            return false;
        }

        let specificSsid: string | undefined;
        if (modeChoice === specificLabel) {
            if (preferredSsid) {
                specificSsid = preferredSsid;
            } else {
                const savedNetworks = await this.runWithClosedMonitor(async () =>
                    listSavedWifiNetworks(target, this.getLogger())
                );
                if (savedNetworks.length === 0) {
                    vscode.window.showInformationMessage('No saved networks. Add one first using "Add a WiFi network".');
                    return false;
                }
                specificSsid = await vscode.window.showQuickPick(savedNetworks, { placeHolder: 'Select a saved network' });
                if (!specificSsid) {
                    return false;
                }
            }
        }

        const enableFallbackLabel = 'Enable AP fallback';
        const disableFallbackLabel = 'Disable AP fallback';
        const fallbackChoice = await vscode.window.showQuickPick([disableFallbackLabel, enableFallbackLabel], { placeHolder: 'Fall back to AP mode if no network is found?' });
        if (!fallbackChoice) {
            return false;
        }
        const apFallback = fallbackChoice === enableFallbackLabel;

        await this.runWithClosedMonitor(async () => {
            await setWifiStationMode(target, this.getLogger(), { specificSsid, apFallback });
        });
        return true;
    }

    private async wifiSta() {
        try {
            const target = this.getConnectedTarget();
            if (await this.configureStationMode(target)) {
                vscode.window.showInformationMessage('Connected to WiFi network');
            }
        } catch (error) {
            this.showError(error, 'Failed to switch WiFi to station mode');
        }
    }

    private async wifiDisable() {
        try {
            const target = this.getConnectedTarget();
            await this.runWithClosedMonitor(async () => {
                await disableWifi(target, this.getLogger());
            });
            vscode.window.showInformationMessage('Disabled WiFi');
        } catch (error) {
            this.showError(error, 'Failed to disable WiFi');
        }
    }

    private async updateProject() {
        try {
            await updateProjectFromPrompt(this.context, this.projectPath, this.getLogger());
        } catch (error) {
            this.showError(error, 'Failed to update project');
        }
    }

    private async checkForUpdates(showIfUpToDate: boolean = false) {
        if (showIfUpToDate) {
            vscode.window.showInformationMessage('Jaculus now uses the integrated libraries directly. Update the extension to get newer Jaculus tooling.');
        }
    }

    private async toggleMinimalMode(): Promise<void> {
        this.minimalMode = !this.minimalMode;
        await this.context.globalState.update(ContextKey.minimalMode, this.minimalMode);
        this.viewProvider.updateMinimalMode(this.minimalMode);

        const selection = await vscode.window.showInformationMessage(
            'Minimal mode has been toggled. Changes will apply after a restart.',
            'Restart Now'
        );
        if (selection === 'Restart Now') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }

    private getButtonText(icon: string, text: string): string {
        return this.minimalMode ? icon : `${icon}${text}`;
    }

    private async installJaculusBoardVersion(): Promise<void> {
        if (this.lastSelectedConnection !== ConnectionType.comPort || !this.selectedComPort) {
            vscode.window.showErrorMessage('Please select a COM port before installing firmware');
            return;
        }
        const selectedComPort = this.selectedComPort;

        try {
            const boards = await listBoards(this.getLogger());

            const customUrlOption = 'Custom URL';
            const boardOptions = [...boards.map(board => board.name), customUrlOption];

            const boardOrCustomUrl = await vscode.window.showQuickPick(boardOptions, { placeHolder: 'Select a board or enter a custom URL' });
            let firmwareUrl = '';

            if (!boardOrCustomUrl) {
                vscode.window.showErrorMessage('Please select a board or enter a custom URL');
                return;
            }

            if (boardOrCustomUrl === customUrlOption) {
                firmwareUrl = await vscode.window.showInputBox({ placeHolder: 'Enter the custom URL for the tar.gz package' }) || '';
                if (firmwareUrl === '') {
                    vscode.window.showErrorMessage('Please enter a valid URL');
                    return;
                }
            } else {
                const boardId = boards.find(b => b.name === boardOrCustomUrl)?.id;
                if (!boardId) {
                    vscode.window.showErrorMessage('Error fetching board ID');
                    return;
                }

                const boardVersions = await listBoardVersions(boardId, this.getLogger());
                const selectedVersion = await vscode.window.showQuickPick(boardVersions.map(version => version.version), { placeHolder: 'Select a version to install' });
                if (selectedVersion) {
                    firmwareUrl = getBoardFirmwareUrl(boardId, selectedVersion);
                } else {
                    vscode.window.showErrorMessage('No version selected');
                    return;
                }
            }

            const eraseStorage = await vscode.window.showQuickPick(['No', 'Yes'], { placeHolder: 'Do you want to erase storage partitions?' });
            if (!eraseStorage) {
                return;
            }

            await this.runWithClosedMonitor(async () => {
                await installFirmwarePackage(
                    firmwareUrl,
                    selectedComPort,
                    eraseStorage === 'No'
                );
            });
            vscode.window.showInformationMessage(`Firmware installed from ${firmwareUrl}`);
        } catch (error) {
            this.showError(error, 'Error while installing firmware');
        }
    }


    public registerCommands(): void {
        let color = this.minimalMode ? "#e9b780" : "#ff8500";

        this.selectComPortBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.selectComPortBtn.command = "jaculus.SelectComPort";
        this.updateSelectedPortMenu();
        this.selectComPortBtn.tooltip = "Jaculus Select Port";
        this.selectComPortBtn.color = color;
        this.selectComPortBtn.show();

        const monitorBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        monitorBtn.command = "jaculus.Monitor";
        monitorBtn.text = this.getButtonText("$(device-desktop)", " Monitor");
        monitorBtn.tooltip = "Jaculus Monitor";
        monitorBtn.color = color;
        monitorBtn.show();

        const buildFlashMonitorBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        buildFlashMonitorBtn.command = "jaculus.BuildFlashMonitor";
        buildFlashMonitorBtn.text = this.getButtonText("$(diff-renamed)", " Build, Flash and Monitor");
        buildFlashMonitorBtn.tooltip = "Jaculus Build, Flash and Monitor";
        buildFlashMonitorBtn.color = color;
        buildFlashMonitorBtn.show();

        this.context.subscriptions.push(
            this.selectComPortBtn,
            monitorBtn,
            buildFlashMonitorBtn,
            new vscode.Disposable(() => void this.disposeMonitorTerminal()),
            vscode.commands.registerCommand('jaculus.SelectComPort', () => this.selectPort()),
            vscode.commands.registerCommand('jaculus.Build', () => this.build()),
            vscode.commands.registerCommand('jaculus.Flash', () => this.flash()),
            vscode.commands.registerCommand('jaculus.Monitor', async () => {
                try {
                    await this.monitor();
                } catch (error) {
                    this.showError(error, 'Failed to start monitor');
                }
            }),
            vscode.commands.registerCommand('jaculus.BuildFlashMonitor', () => this.buildFlashMonitor()),
            vscode.commands.registerCommand('jaculus.SetLogLevel', () => this.selectLogLevel()),
            vscode.commands.registerCommand('jaculus.Start', () => this.start()),
            vscode.commands.registerCommand('jaculus.Stop', () => this.stop()),
            vscode.commands.registerCommand('jaculus.ShowVersion', () => this.showVersion()),
            vscode.commands.registerCommand('jaculus.ShowStatus', () => this.showStatus()),
            vscode.commands.registerCommand('jaculus.Format', () => this.format()),
            vscode.commands.registerCommand('jaculus.CheckForUpdates', () => this.checkForUpdates(true)),
            vscode.commands.registerCommand('jaculus.ToggleMinimalMode', () => this.toggleMinimalMode()),
            vscode.commands.registerCommand('jaculus.InstallBoard', () => this.installJaculusBoardVersion()),
            vscode.commands.registerCommand('jaculus.ConfigWiFi', () => this.configWiFi()),
            vscode.commands.registerCommand('jaculus.BrowseDeviceFiles', () => this.browseDeviceFiles()),
            vscode.commands.registerCommand('jaculus.InstallLibrary', () => this.installLibrary()),
            vscode.commands.registerCommand('jaculus.RemoveLibrary', () => this.removeLibrary()),
            vscode.commands.registerCommand('jaculus.RefreshLibraries', () => this.refreshLibraries()),
            vscode.commands.registerCommand('jaculus.UpdateLibraries', () => this.updateLibraries()),
            vscode.commands.registerCommand('jaculus.UpdateProject', () => this.updateProject()),
        );

        this.refreshInstalledLibraries();
        this.checkForUpdates();
    }

    private getLogger(): JaculusLogger {
        return createLogger(this.outputChannel, this.debugMode);
    }

    private showError(error: unknown, title: string): void {
        const message = error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(`[error] ${title}: ${message}`);
        this.outputChannel.show(true);
        vscode.window.showErrorMessage(`${title}: ${message}`);
    }
}

async function createProject(context: vscode.ExtensionContext) {
    return createProjectWithSource(context);
}

class JaculusProjectUriHandler implements vscode.UriHandler {
    constructor(
        private readonly context: vscode.ExtensionContext
    ) {}

    public async handleUri(uri: vscode.Uri): Promise<void> {
        try {
            const source = parseProjectImportSource(uri);
            await createProjectWithSource(this.context, source);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error importing Jaculus project: ${message}`);
        }
    }
}

function updateConfigContext(): void {
    void vscode.commands.executeCommand('setContext', 'jaculus.hasProject', getJaculusWorkspaceFolder() !== undefined);
}

function getJaculusWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.find((folder) => {
        const packageJsonPath = path.join(folder.uri.fsPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return false;
        }

        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { jaculus?: unknown };
            return packageJson.jaculus !== undefined;
        } catch {
            return false;
        }
    });
}

function registerConfigWatcher(
    context: vscode.ExtensionContext,
    pattern: string
): void {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(updateConfigContext);
    watcher.onDidChange(updateConfigContext);
    watcher.onDidDelete(updateConfigContext);
    context.subscriptions.push(watcher);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    updateConfigContext();
    context.subscriptions.push(
        vscode.window.registerUriHandler(new JaculusProjectUriHandler(context)),
        vscode.commands.registerCommand('jaculus.CreateProject', () => createProject(context)),
        vscode.workspace.onDidChangeWorkspaceFolders(updateConfigContext)
    );
    registerConfigWatcher(context, 'package.json');

    const projectFolder = getJaculusWorkspaceFolder();
    if (!projectFolder) {
        return;
    }

    const jaculusProvider = new JaculusViewProvider(context);
    const deviceFileSystemProvider = new DeviceFileSystemProvider();
    const treeView = vscode.window.createTreeView('jaculusView', {
        treeDataProvider: jaculusProvider,
        showCollapseAll: false
    });
    context.subscriptions.push(
        treeView,
        vscode.workspace.registerFileSystemProvider('jaculus-device', deviceFileSystemProvider, {
            isCaseSensitive: true,
            isReadonly: true,
        })
    );

    const jaculus = new JaculusInterface(
        context,
        jaculusProvider,
        deviceFileSystemProvider,
        projectFolder.uri.fsPath
    );
    jaculus.registerCommands();
    await vscode.commands.executeCommand('setContext', 'jaculus.fileBrowserRegistered', true);
}

export function deactivate() { }
