import type { JacDevice } from '@jaculus/device';

import type { ConnectionTarget } from './integration.js';

export type DeviceManagerScheduler = {
    setTimeout: (callback: () => void, delay: number) => unknown;
    clearTimeout: (timer: unknown) => void;
};

export type DeviceManagerLogger = {
    debug: (message: string) => void;
    verbose: (message: string) => void;
};

export type DeviceManagerOptions = {
    getTarget: () => ConnectionTarget;
    connect: (target: ConnectionTarget) => Promise<JacDevice>;
    destroy: (device: JacDevice) => Promise<void>;
    logger?: DeviceManagerLogger;
    scheduler?: DeviceManagerScheduler;
    connectionIdleTimeoutMs?: number;
    lockIdleTimeoutMs?: number;
    reconnectDelayMs?: number;
};

const defaultScheduler: DeviceManagerScheduler = {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

function targetKey(target: ConnectionTarget): string {
    return `${target.type}:${target.value}`;
}

export class DeviceLease {
    private readonly disconnectCallbacks = new Set<() => void>();
    private released = false;

    public constructor(
        public readonly device: JacDevice,
        private readonly runLockedAction: <T>(action: (device: JacDevice) => Promise<T>) => Promise<T>,
        private readonly releaseAction: (lease: DeviceLease) => Promise<void>
    ) {}

    public runLocked<T>(action: (device: JacDevice) => Promise<T>): Promise<T> {
        if (this.released) {
            return Promise.reject(new Error('Device lease has been released'));
        }
        return this.runLockedAction(action);
    }

    public onDidDisconnect(callback: () => void): void {
        this.disconnectCallbacks.add(callback);
    }

    public async release(): Promise<void> {
        if (this.released) {
            return;
        }
        this.released = true;
        await this.releaseAction(this);
    }

    public disconnect(): void {
        if (this.released) {
            return;
        }
        this.released = true;
        for (const callback of this.disconnectCallbacks) {
            callback();
        }
    }
}

export class DeviceManager {
    private readonly scheduler: DeviceManagerScheduler;
    private readonly connectionIdleTimeoutMs: number;
    private readonly lockIdleTimeoutMs: number;
    private readonly reconnectDelayMs: number;
    private readonly owners = new Set<DeviceLease>();
    private readonly cooldowns = new Map<string, Promise<void>>();
    private target: ConnectionTarget | undefined;
    private device: JacDevice | undefined;
    private connection: Promise<JacDevice> | undefined;
    private connectionTimer: unknown;
    private lockTimer: unknown;
    private lockHeld = false;
    private lockQueue: Promise<void> = Promise.resolve();

    public constructor(private readonly options: DeviceManagerOptions) {
        this.scheduler = options.scheduler ?? defaultScheduler;
        this.connectionIdleTimeoutMs = options.connectionIdleTimeoutMs ?? 2_000;
        this.lockIdleTimeoutMs = options.lockIdleTimeoutMs ?? 500;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    }

    public async acquire(): Promise<DeviceLease> {
        const target = this.options.getTarget();
        await this.selectTarget(target);
        await this.cooldowns.get(targetKey(target));
        const device = await this.connect(target);
        const lease = new DeviceLease(
            device,
            (action) => this.runLockedOnDevice(device, action),
            (value) => this.release(value)
        );
        this.owners.add(lease);
        this.clearConnectionTimer();
        this.options.logger?.debug(`Device acquired: ${targetKey(target)} (owners: ${this.owners.size})`);
        return lease;
    }

    public async runLocked<T>(
        action: (device: JacDevice) => Promise<T>
    ): Promise<T> {
        const lease = await this.acquire();
        try {
            return await lease.runLocked(action);
        } finally {
            await lease.release();
        }
    }

    public async dispose(): Promise<void> {
        for (const owner of this.owners) {
            owner.disconnect();
        }
        this.owners.clear();
        await this.closeDevice();
    }

    private async selectTarget(target: ConnectionTarget): Promise<void> {
        if (!this.target || targetKey(this.target) === targetKey(target)) {
            this.target = target;
            return;
        }
        await this.dispose();
        this.target = target;
    }

    private async connect(target: ConnectionTarget): Promise<JacDevice> {
        if (this.device) {
            return this.device;
        }
        if (!this.connection) {
            this.options.logger?.verbose(`Connecting device: ${targetKey(target)}`);
            this.connection = this.options.connect(target).then((device) => {
                this.device = device;
                device.onEnd(() => this.handleDisconnect(device, target));
                this.options.logger?.verbose(`Device connected: ${targetKey(target)}`);
                return device;
            }).finally(() => {
                this.connection = undefined;
            });
        }
        return this.connection;
    }

    private async runLockedOnDevice<T>(device: JacDevice, action: (device: JacDevice) => Promise<T>): Promise<T> {
        let result!: T;
        await this.enqueueLock(async () => {
            if (this.device !== device) {
                throw new Error('Device disconnected');
            }
            this.clearLockTimer();
            if (!this.lockHeld) {
                await device.controller.lock();
                this.lockHeld = true;
            }
            try {
                result = await action(device);
            } finally {
                this.scheduleLockRelease();
            }
        });
        return result;
    }

    private release(lease: DeviceLease): Promise<void> {
        this.owners.delete(lease);
        if (this.target) {
            this.options.logger?.debug(`Device released: ${targetKey(this.target)} (owners: ${this.owners.size})`);
        }
        if (this.owners.size === 0) {
            this.scheduleConnectionRelease();
        }
        return Promise.resolve();
    }

    private enqueueLock(action: () => Promise<void>): Promise<void> {
        const next = this.lockQueue.then(action, action);
        this.lockQueue = next.catch(() => undefined);
        return next;
    }

    private scheduleLockRelease(): void {
        this.clearLockTimer();
        this.lockTimer = this.scheduler.setTimeout(() => {
            this.lockTimer = undefined;
            void this.releaseLock();
        }, this.lockIdleTimeoutMs);
    }

    private async releaseLock(): Promise<void> {
        await this.enqueueLock(async () => {
            if (!this.device || !this.lockHeld) {
                return;
            }
            this.lockHeld = false;
            await this.device.controller.unlock();
        });
    }

    private scheduleConnectionRelease(): void {
        this.clearConnectionTimer();
        this.connectionTimer = this.scheduler.setTimeout(() => {
            this.connectionTimer = undefined;
            void this.closeDevice();
        }, this.connectionIdleTimeoutMs);
    }

    private async closeDevice(): Promise<void> {
        this.clearConnectionTimer();
        this.clearLockTimer();
        const device = this.device;
        const target = this.target;
        this.device = undefined;
        this.connection = undefined;
        if (!device) {
            return;
        }
        await this.releaseLock();
        await this.options.destroy(device);
        if (target) {
            this.options.logger?.verbose(`Device disconnected: ${targetKey(target)}`);
            this.startCooldown(target);
        }
    }

    private handleDisconnect(device: JacDevice, target: ConnectionTarget): void {
        if (this.device !== device) {
            return;
        }
        this.device = undefined;
        this.connection = undefined;
        this.clearConnectionTimer();
        this.clearLockTimer();
        this.lockHeld = false;
        for (const owner of this.owners) {
            owner.disconnect();
        }
        this.owners.clear();
        this.options.logger?.verbose(`Device disconnected: ${targetKey(target)}`);
        this.startCooldown(target);
    }

    private startCooldown(target: ConnectionTarget): void {
        const key = targetKey(target);
        if (this.cooldowns.has(key)) {
            return;
        }
        const cooldown = new Promise<void>((resolve) => {
            this.scheduler.setTimeout(() => {
                this.cooldowns.delete(key);
                resolve();
            }, this.reconnectDelayMs);
        });
        this.cooldowns.set(key, cooldown);
    }

    private clearConnectionTimer(): void {
        if (this.connectionTimer !== undefined) {
            this.scheduler.clearTimeout(this.connectionTimer);
            this.connectionTimer = undefined;
        }
    }

    private clearLockTimer(): void {
        if (this.lockTimer !== undefined) {
            this.scheduler.clearTimeout(this.lockTimer);
            this.lockTimer = undefined;
        }
    }
}
