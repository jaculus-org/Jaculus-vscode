import * as assert from 'assert';
import * as vscode from 'vscode';

import {
    createDeviceBrowserItems,
    DeviceFileSystemProvider,
    getDeviceChildPath,
    getDeviceParentPath,
} from '../../deviceFileBrowser.js';

suite('Device File Browser', () => {
    test('createDeviceBrowserItems sorts directories before files', () => {
        const items = createDeviceBrowserItems('.', [
            { name: 'z.js', isDirectory: false, size: 42 },
            { name: 'beta', isDirectory: true, size: 0 },
            { name: 'a.js', isDirectory: false, size: 3 },
            { name: 'alpha', isDirectory: true, size: 0 },
        ]);

        assert.deepStrictEqual(items.map((item) => item.name), ['alpha', 'beta', 'a.js', 'z.js']);
        assert.strictEqual(items[2].description, '3 B');
    });

    test('createDeviceBrowserItems includes parent outside root', () => {
        const items = createDeviceBrowserItems('code/lib', []);
        assert.strictEqual(items[0].action, 'parent');
        assert.strictEqual(items[0].label, '$(arrow-up) ..');
    });

    test('createDeviceBrowserItems describes an empty root', () => {
        const items = createDeviceBrowserItems('.', []);
        assert.strictEqual(items[0].kind, vscode.QuickPickItemKind.Separator);
        assert.strictEqual(items[0].label, 'Directory is empty');
    });

    test('device paths use POSIX navigation rooted at dot', () => {
        assert.strictEqual(getDeviceChildPath('.', 'code'), 'code');
        assert.strictEqual(getDeviceChildPath('code', 'lib'), 'code/lib');
        assert.strictEqual(getDeviceParentPath('code/lib'), 'code');
        assert.strictEqual(getDeviceParentPath('code'), '.');
    });

    test('DeviceFileSystemProvider preserves the remote path and bytes', async () => {
        const provider = new DeviceFileSystemProvider();
        const data = new Uint8Array([0, 1, 2, 255]);
        const uri = provider.setFile('code/main.js', data);

        assert.strictEqual(uri.toString(), 'jaculus-device:/code/main.js');
        assert.deepStrictEqual(await provider.readFile(uri), data);
        assert.strictEqual((await provider.stat(uri)).type, vscode.FileType.File);
    });

    test('DeviceFileSystemProvider rejects writes', () => {
        const provider = new DeviceFileSystemProvider();
        const uri = provider.setFile('code/main.js', new Uint8Array());

        assert.throws(() => provider.writeFile(
            uri,
            new Uint8Array(),
            { create: true, overwrite: true }
        ));
    });
});
