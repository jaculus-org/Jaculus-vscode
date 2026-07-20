import * as assert from 'assert';
import type { JacDevice } from '@jaculus/device';

import { DeviceManager, type DeviceManagerScheduler } from '../../jaculus/deviceManager.js';
import type { ConnectionTarget } from '../../jaculus/integration.js';

class FakeScheduler implements DeviceManagerScheduler {
    private now = 0;
    private nextId = 0;
    private readonly timers = new Map<number, { due: number; callback: () => void }>();

    public setTimeout(callback: () => void, delay: number): number {
        const id = this.nextId++;
        this.timers.set(id, { due: this.now + delay, callback });
        return id;
    }

    public clearTimeout(id: unknown): void {
        this.timers.delete(id as number);
    }

    public advance(milliseconds: number): void {
        const end = this.now + milliseconds;
        while (true) {
            const due = [...this.timers.entries()]
                .filter(([, timer]) => timer.due <= end)
                .sort(([, left], [, right]) => left.due - right.due)[0];
            if (!due) {
                break;
            }
            const [id, timer] = due;
            this.timers.delete(id);
            this.now = timer.due;
            timer.callback();
        }
        this.now = end;
    }
}

function createDevice() {
    let onEnd: (() => void) | undefined;
    let lockCalls = 0;
    let unlockCalls = 0;
    const device = {
        controller: {
            lock: async () => { lockCalls++; },
            unlock: async () => { unlockCalls++; },
        },
        onEnd: (callback: () => void) => { onEnd = callback; },
    } as unknown as JacDevice;

    return {
        device,
        disconnect: () => onEnd?.(),
        get lockCalls() { return lockCalls; },
        get unlockCalls() { return unlockCalls; },
    };
}

suite('DeviceManager', () => {
    const target: ConnectionTarget = { type: 'port', value: '/dev/ttyUSB0' };

    test('reuses a connection and held lock for chained commands', async () => {
        const scheduler = new FakeScheduler();
        const fake = createDevice();
        let connections = 0;
        const manager = new DeviceManager({
            getTarget: () => target,
            connect: async () => { connections++; return fake.device; },
            destroy: async () => undefined,
            scheduler,
        });

        const first = await manager.acquire();
        await first.runLocked(async () => undefined);
        await first.release();

        const second = await manager.acquire();
        await second.runLocked(async () => undefined);
        await second.release();

        assert.strictEqual(connections, 1);
        assert.strictEqual(fake.lockCalls, 1);
        assert.strictEqual(fake.unlockCalls, 0);
    });

    test('runs a transient locked operation without exposing lease cleanup to callers', async () => {
        const scheduler = new FakeScheduler();
        const fake = createDevice();
        const manager = new DeviceManager({
            getTarget: () => target,
            connect: async () => fake.device,
            destroy: async () => undefined,
            scheduler,
        });

        const result = await manager.runLocked(async (device) => {
            assert.strictEqual(device, fake.device);
            return 'ok';
        });

        assert.strictEqual(result, 'ok');
        assert.strictEqual(fake.lockCalls, 1);
    });

    test('uses its configured target for locked operations', async () => {
        const scheduler = new FakeScheduler();
        const fake = createDevice();
        const manager = new DeviceManager({
            getTarget: () => target,
            connect: async () => fake.device,
            destroy: async () => undefined,
            scheduler,
        });

        await manager.runLocked(async () => undefined);
        assert.strictEqual(fake.lockCalls, 1);
    });

    test('releases the lock after its idle timeout while monitor ownership remains', async () => {
        const scheduler = new FakeScheduler();
        const fake = createDevice();
        let destroyed = 0;
        const manager = new DeviceManager({
            getTarget: () => target,
            connect: async () => fake.device,
            destroy: async () => { destroyed++; },
            scheduler,
        });

        const monitor = await manager.acquire();
        const command = await manager.acquire();
        await command.runLocked(async () => undefined);
        await command.release();

        scheduler.advance(500);
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.strictEqual(fake.unlockCalls, 1);
        assert.strictEqual(destroyed, 0);
        await monitor.release();
    });

    test('waits for the reconnect cooldown after a disconnect instead of failing a new request', async () => {
        const scheduler = new FakeScheduler();
        const firstDevice = createDevice();
        const secondDevice = createDevice();
        let connections = 0;
        const manager = new DeviceManager({
            getTarget: () => target,
            connect: async () => (++connections === 1 ? firstDevice.device : secondDevice.device),
            destroy: async () => undefined,
            scheduler,
        });

        const lease = await manager.acquire();
        firstDevice.disconnect();
        await lease.release();

        let acquired = false;
        const waiting = manager.acquire().then((next) => {
            acquired = true;
            return next;
        });
        await Promise.resolve();
        assert.strictEqual(acquired, false);
        assert.strictEqual(connections, 1);

        scheduler.advance(999);
        await Promise.resolve();
        assert.strictEqual(acquired, false);

        scheduler.advance(1);
        const nextLease = await waiting;
        assert.strictEqual(acquired, true);
        assert.strictEqual(connections, 2);
        await nextLease.release();
    });
});
