import * as vscode from 'vscode';

export const DEFAULT_TERMINAL_NAME = 'Jaculus';

export class JaculusMonitorPseudoterminal implements vscode.Pseudoterminal {
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    private readonly closeEmitter = new vscode.EventEmitter<number | void>();
    private isOpen = false;
    private pendingOutput = '';

    public readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    public readonly onDidClose?: vscode.Event<number | void> = this.closeEmitter.event;

    constructor(
        private readonly onOpen: () => Promise<void>,
        private readonly onInput: (data: string) => Promise<void>,
        private readonly onCloseTerminal: () => Promise<void>
    ) {}

    open(): void {
        this.isOpen = true;
        if (this.pendingOutput.length > 0) {
            this.writeEmitter.fire(this.pendingOutput);
            this.pendingOutput = '';
        }
        void this.onOpen();
    }

    close(): void {
        void this.onCloseTerminal();
    }

    handleInput(data: string): void {
        void this.onInput(data);
    }

    public write(data: string): void {
        const normalized = data.replace(/(?<!\r)\n/g, '\r\n');
        if (!this.isOpen) {
            this.pendingOutput += normalized;
            return;
        }
        this.writeEmitter.fire(normalized);
    }

    public closeTerminal(): void {
        this.closeEmitter.fire();
    }

    public dispose(): void {
        this.writeEmitter.dispose();
        this.closeEmitter.dispose();
    }
}
