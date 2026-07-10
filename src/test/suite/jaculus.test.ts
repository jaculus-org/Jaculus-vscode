import * as assert from 'assert';
import type { JacDevice } from '@jaculus/device';
import chalk from 'chalk';

import { createDeviceWithStreamReady, destroyDevice } from '../../jaculus/integration.js';
import { getFlashProgressEvent } from '../../jaculus/flashProgress.js';
import { getMonitorEcho, getMonitorErrorOutput } from '../../jaculus/monitor.js';

suite('Jaculus Integration Helpers', () => {
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
