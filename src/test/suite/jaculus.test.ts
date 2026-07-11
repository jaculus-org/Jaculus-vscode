import * as assert from 'assert';
import type { JacDevice } from '@jaculus/device';
import chalk from 'chalk';

import {
    createDeviceWithStreamReady,
    destroyDevice,
    runUntilDeviceEnd,
    runDeviceStorageSession,
} from '../../jaculus/integration.js';
import { getFlashProgressEvent } from '../../jaculus/flashProgress.js';
import { getMonitorEcho, getMonitorErrorOutput } from '../../jaculus/monitor.js';

suite('Jaculus Integration Helpers', () => {
    test('runUntilDeviceEnd fans out disconnect notifications before rejecting', async () => {
        let disconnectHandler: (() => void) | undefined;
        let notified = false;
        const device = {
            onEnd: (handler: () => void) => { disconnectHandler = handler; },
        } as unknown as JacDevice;

        const pending = runUntilDeviceEnd(device, async (onDidDisconnect) => {
            onDidDisconnect(() => { notified = true; });
            await new Promise<never>(() => undefined);
        });
        disconnectHandler?.();

        await assert.rejects(pending, /Device disconnected/);
        assert.strictEqual(notified, true);
    });

    test('runDeviceStorageSession releases the lock between storage operations', async () => {
        let lockCalls = 0;
        let unlockCalls = 0;
        const bytes = new Uint8Array([1, 2, 3]);
        const device = {
            controller: {
                lock: async () => { lockCalls++; },
                unlock: async () => { unlockCalls++; },
            },
            uploader: {
                listDirectory: async () => [
                    ['code', true, 0],
                    ['main.js', false, 42],
                ],
                readFile: async () => bytes,
            },
        } as unknown as JacDevice;

        const result = await runDeviceStorageSession(device, async (storage) => {
            const entries = await storage.listDirectory('.');
            assert.strictEqual(lockCalls, 1);
            assert.strictEqual(unlockCalls, 1);

            const data = await storage.readFile('main.js');
            assert.strictEqual(lockCalls, 2);
            assert.strictEqual(unlockCalls, 2);
            return { entries, data };
        });

        assert.strictEqual(lockCalls, 2);
        assert.strictEqual(unlockCalls, 2);
        assert.deepStrictEqual(result.entries, [
            { name: 'code', isDirectory: true, size: 0 },
            { name: 'main.js', isDirectory: false, size: 42 },
        ]);
        assert.deepStrictEqual(result.data, bytes);
    });

    test('runDeviceStorageSession unlocks after a failed storage operation', async () => {
        let unlockCalls = 0;
        const device = {
            controller: {
                lock: async () => undefined,
                unlock: async () => { unlockCalls++; },
            },
            uploader: {
                listDirectory: async () => { throw new Error('list failed'); },
                readFile: async () => new Uint8Array(),
            },
        } as unknown as JacDevice;

        await assert.rejects(
            runDeviceStorageSession(device, (storage) => storage.listDirectory('.')),
            /list failed/
        );
        assert.strictEqual(unlockCalls, 1);
    });

    test('runDeviceStorageSession exposes device disconnection', async () => {
        let disconnectHandler: (() => void) | undefined;
        const device = {
            controller: {
                lock: async () => undefined,
                unlock: async () => undefined,
            },
            uploader: {
                listDirectory: async () => [],
                readFile: async () => new Uint8Array(),
            },
            onEnd: (handler: () => void) => { disconnectHandler = handler; },
        } as unknown as JacDevice;

        let disconnected = false;
        await runDeviceStorageSession(device, async (storage) => {
            storage.onDidDisconnect(() => { disconnected = true; });
            disconnectHandler?.();
        });

        assert.strictEqual(disconnected, true);
    });

    test('destroyDevice consumes an unlock rejection before destroying the device', async () => {
        let unlockCalls = 0;
        let destroyed = false;
        const device = {
            controller: {
                unlock: () => {
                    unlockCalls++;
                    return Promise.reject(new Error('Timeout'));
                },
            },
            destroy: async () => {
                destroyed = true;
            },
        } as unknown as JacDevice;

        await destroyDevice(device);

        assert.strictEqual(unlockCalls, 1);
        assert.strictEqual(destroyed, true);
    });

    test('createDeviceWithStreamReady constructs device before stream becomes ready', async () => {
        const events: string[] = [];

        class FakeStream {
            constructor(onReady: () => void) {
                events.push('stream-created');
                setTimeout(() => {
                    events.push('stream-ready');
                    onReady();
                }, 0);
            }

            public put(): void {}
            public write(): void {}
            public onData(): void {}
            public onEnd(): void {}
            public onError(): void {}
            public async destroy(): Promise<void> {}
        }

        class FakeDevice {
            constructor(_: unknown, __: unknown) {
                events.push('device-created');
            }
        }

        await createDeviceWithStreamReady(
            (onReady) => new FakeStream(onReady),
            FakeDevice,
            {
                info: () => undefined,
                warn: () => undefined,
                error: () => undefined,
                verbose: () => undefined,
                debug: () => undefined,
                silly: () => undefined,
            }
        );

        assert.deepStrictEqual(events, ['stream-created', 'device-created', 'stream-ready']);
    });

    test('createDeviceWithStreamReady runs setup before stream becomes ready', async () => {
        const events: string[] = [];

        class FakeStream {
            constructor(onReady: () => void) {
                events.push('stream-created');
                setTimeout(() => {
                    events.push('stream-ready');
                    onReady();
                }, 0);
            }

            public put(): void {}
            public write(): void {}
            public onData(): void {}
            public onEnd(): void {}
            public onError(): void {}
            public async destroy(): Promise<void> {}
        }

        class FakeDevice {
            constructor(_: unknown, __: unknown) {
                events.push('device-created');
            }
        }

        await createDeviceWithStreamReady(
            (onReady) => new FakeStream(onReady),
            FakeDevice,
            {
                info: () => undefined,
                warn: () => undefined,
                error: () => undefined,
                verbose: () => undefined,
                debug: () => undefined,
                silly: () => undefined,
            },
            () => {
                events.push('device-setup');
            }
        );

        assert.deepStrictEqual(events, ['stream-created', 'device-created', 'device-setup', 'stream-ready']);
    });

    test('getMonitorEcho echoes regular input and expands enter', () => {
        assert.strictEqual(getMonitorEcho('a'), 'a');
        assert.strictEqual(getMonitorEcho('\r'), '\r\n');
        assert.strictEqual(getMonitorEcho('\x03'), null);
    });

    test('getMonitorErrorOutput uses red ANSI output and resets the terminal style', () => {
        assert.strictEqual(getMonitorErrorOutput('failure\n'), chalk.red('failure\n'));
    });

    test('getFlashProgressEvent computes percentage increment for upload progress', () => {
        const event = getFlashProgressEvent({
            phase: 'uploadIfDifferent',
            current: 3,
            total: 10,
            filePath: 'main.js',
            action: 'upload',
        }, 1);

        assert.strictEqual(event.message, 'upload: main.js');
        assert.strictEqual(event.increment, 20);
    });

    test('getFlashProgressEvent reports hashing without increment', () => {
        const event = getFlashProgressEvent({
            phase: 'getDirHashes',
            current: 5,
            filePath: 'src/index.ts',
        }, 4);

        assert.strictEqual(event.message, 'Hashing src/index.ts');
        assert.strictEqual(event.increment, undefined);
    });
});
