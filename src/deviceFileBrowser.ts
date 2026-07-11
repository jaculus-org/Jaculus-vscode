import * as path from 'path';
import * as vscode from 'vscode';

import type { DeviceStorageEntry } from './jaculus/integration.js';

export type DeviceBrowserItem = vscode.QuickPickItem & {
    action: 'parent' | 'directory' | 'file' | 'empty';
    name?: string;
};

type CachedDeviceFile = {
    data: Uint8Array;
    ctime: number;
    mtime: number;
};

export class DeviceFileSystemProvider implements vscode.FileSystemProvider {
    private readonly files = new Map<string, CachedDeviceFile>();
    private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

    public readonly onDidChangeFile = this.changeEmitter.event;

    public setFile(remotePath: string, data: Uint8Array): vscode.Uri {
        const uri = vscode.Uri.from({
            scheme: 'jaculus-device',
            path: path.posix.normalize(`/${remotePath.replace(/^\.\//, '')}`),
        });
        const key = uri.toString();
        const existing = this.files.get(key);
        const now = existing ? Math.max(Date.now(), existing.mtime + 1) : Date.now();

        this.files.set(key, {
            data,
            ctime: existing?.ctime ?? now,
            mtime: now,
        });
        this.changeEmitter.fire([{
            type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
            uri,
        }]);
        return uri;
    }

    public watch(
        _uri: vscode.Uri,
        _options: { readonly recursive: boolean; readonly excludes: readonly string[] }
    ): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    public stat(uri: vscode.Uri): vscode.FileStat {
        const file = this.getFile(uri);
        return {
            type: vscode.FileType.File,
            ctime: file.ctime,
            mtime: file.mtime,
            size: file.data.byteLength,
            permissions: vscode.FilePermission.Readonly,
        };
    }

    public readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        throw vscode.FileSystemError.FileNotADirectory(uri);
    }

    public createDirectory(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    public readFile(uri: vscode.Uri): Uint8Array {
        return this.getFile(uri).data;
    }

    public writeFile(
        uri: vscode.Uri,
        _content: Uint8Array,
        _options: { readonly create: boolean; readonly overwrite: boolean }
    ): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    public delete(uri: vscode.Uri, _options: { readonly recursive: boolean }): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    public rename(
        oldUri: vscode.Uri,
        _newUri: vscode.Uri,
        _options: { readonly overwrite: boolean }
    ): void {
        throw vscode.FileSystemError.NoPermissions(oldUri);
    }

    private getFile(uri: vscode.Uri): CachedDeviceFile {
        const file = this.files.get(uri.toString());
        if (!file) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return file;
    }
}

export function getDeviceChildPath(directory: string, name: string): string {
    return path.posix.join(directory, name);
}

export function getDeviceParentPath(directory: string): string {
    const parent = path.posix.dirname(directory);
    return parent === '.' ? '.' : parent;
}

export function createDeviceBrowserItems(
    directory: string,
    entries: DeviceStorageEntry[]
): DeviceBrowserItem[] {
    const items: DeviceBrowserItem[] = [];

    if (directory !== '.') {
        items.push({
            label: '$(arrow-up) ..',
            action: 'parent',
        });
    }

    const sortedEntries = [...entries].sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
            return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
    });

    for (const entry of sortedEntries) {
        items.push({
            label: `$(${entry.isDirectory ? 'folder' : 'file'}) ${entry.name}`,
            description: entry.isDirectory ? undefined : `${entry.size} B`,
            action: entry.isDirectory ? 'directory' : 'file',
            name: entry.name,
        });
    }

    if (items.length === 0) {
        return [{
            label: 'Directory is empty',
            kind: vscode.QuickPickItemKind.Separator,
            action: 'empty',
        }];
    }

    return items;
}
