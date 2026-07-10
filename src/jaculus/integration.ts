import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { JaculusRequestError, ProjectBundle, type RequestFunction } from '@jaculus/common';
import { JacDevice, WifiMode, WifiStaMode, type UploaderProgress } from '@jaculus/device';
import { loadPackage as loadFirmwarePackage } from '@jaculus/firmware';
import { getBoardVersionFirmwareTarUrl, getBoardsIndex as getLibBoardsIndex, getBoardVersions as getLibBoardVersions, type BoardVariant, type BoardVersion } from '@jaculus/firmware/boards';
import { Project } from '@jaculus/project';
import { compileProjectPath } from '@jaculus/project/compiler';
import { createFromBundle, updateFromBundle } from '@jaculus/project/creation';
import { extractArchive, loadPackageFromUri } from '@jaculus/project/import';
import { loadPackageJson } from '@jaculus/project/package';
import { Registry } from '@jaculus/project/registry';
import { SerialPort } from 'serialport';

import { getFlashProgressEvent } from './flashProgress.js';

export type SerialPortInfo = {
    path: string;
    manufacturer?: string;
};

export type ConnectionTarget =
    | { type: 'port'; value: string }
    | { type: 'socket'; value: string };

export type JaculusLogger = {
    info: (message?: string) => void;
    warn: (message?: string) => void;
    error: (message?: string) => void;
    verbose: (message?: string) => void;
    debug: (message?: string) => void;
    silly: (message?: string) => void;
};

export type FlashProgress = {
    message: string;
    increment?: number;
};

export type ProjectLibrary = {
    name: string;
    version: string;
};

export type AvailableLibrary = {
    id: string;
    description?: string;
};

export type ProjectTemplate = {
    id: string;
    description?: string;
    projectType?: 'code' | 'jacly';
    templatePriority?: number;
};

export type { BoardVariant, BoardVersion };

function createRequestFunction(): RequestFunction {
    return async (baseUri: string, libFile: string): Promise<Uint8Array> => {
        const uri = new URL(
            libFile.replace(/^\/+/, ''),
            baseUri.endsWith('/') ? baseUri : `${baseUri}/`
        ).toString();

        if (uri.startsWith('file:')) {
            const filePath = fileURLToPath(uri);
            try {
                return new Uint8Array(fs.readFileSync(filePath));
            } catch (error) {
                throw new JaculusRequestError(
                    `Failed to read ${filePath}: ${(error as Error).message}`
                );
            }
        }

        const response = await fetch(uri);
        if (!response.ok) {
            throw new JaculusRequestError(`HTTP ${response.status}: ${response.statusText} for ${uri}`);
        }

        return new Uint8Array(await response.arrayBuffer());
    };
}

export async function listBoards(logger: JaculusLogger): Promise<BoardVariant[]> {
    const request = createRequestFunction();
    const boardsIndex = await getLibBoardsIndex(request, logger);
    return boardsIndex.flatMap(board => board.variants);
}

export async function listBoardVersions(boardId: string, logger: JaculusLogger): Promise<BoardVersion[]> {
    const request = createRequestFunction();
    return getLibBoardVersions(request, boardId, logger);
}

export function getBoardFirmwareUrl(boardId: string, version: string): string {
    return getBoardVersionFirmwareTarUrl(boardId, version);
}

const DEFAULT_BAUDRATE = 921600;
function parseSocketValue(value: string): { host: string; port: number } {
    const separatorIndex = value.lastIndexOf(':');
    if (separatorIndex === -1) {
        return { host: 'localhost', port: Number(value) };
    }

    return {
        host: value.slice(0, separatorIndex),
        port: Number(value.slice(separatorIndex + 1)),
    };
}

type OpenableStream = {
    put: (c: number) => void;
    write: (buf: Uint8Array) => void;
    onData: (callback?: (data: Uint8Array) => void) => void;
    onEnd: (callback?: () => void) => void;
    onError: (callback?: (err: Error) => void) => void;
    destroy: () => Promise<void>;
};

class SerialPortStream {
    private callbacks: {
        data?: (data: Uint8Array) => void;
        error?: (err: Error) => void;
        end?: () => void;
    } = {};
    private readonly port: SerialPort;

    constructor(
        serialPortCtor: typeof SerialPort,
        devicePath: string,
        baudRate: number,
        openCallbacks: {
            open?: () => void;
            error?: (err: Error) => void;
        } = {}
    ) {
        this.port = new serialPortCtor(
            {
                path: devicePath,
                baudRate,
            },
            (err: Error | null | undefined) => {
                if (err) {
                    openCallbacks.error?.(err);
                    return;
                }

                this.port.set({ rts: false, dtr: false });

                setTimeout(() => {
                    this.port.set({ rts: true, dtr: true });
                    openCallbacks.open?.();
                }, 10);
            }
        );

        this.port.on('data', (data: Uint8Array) => this.callbacks.data?.(new Uint8Array(data)));
        this.port.on('error', (err: Error) => this.callbacks.error?.(err));
        this.port.on('close', () => this.callbacks.end?.());
    }

    public put(c: number): void {
        this.port.write(Buffer.from([c]));
    }

    public write(buf: Uint8Array): void {
        this.port.write(buf);
    }

    public onData(callback?: (data: Uint8Array) => void): void {
        this.callbacks.data = callback;
    }

    public onEnd(callback?: () => void): void {
        this.callbacks.end = callback;
    }

    public onError(callback?: (err: Error) => void): void {
        this.callbacks.error = callback;
    }

    public destroy(): Promise<void> {
        if (this.port.closing || this.port.closed) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            this.port.close((err: Error | null | undefined) => {
                if (err) {
                    this.callbacks.error?.(err);
                    this.callbacks.end?.();
                    reject(err);
                    return;
                }

                this.callbacks.end?.();
                resolve();
            });
        });
    }
}

class SocketStream {
    private callbacks: {
        data?: (data: Uint8Array) => void;
        error?: (err: Error) => void;
        end?: () => void;
    } = {};
    private readonly socket: net.Socket;

    constructor(
        host: string,
        port: number,
        openCallbacks: {
            open?: () => void;
            error?: (err: Error) => void;
        } = {}
    ) {
        this.socket = new net.Socket();
        const openErrorHandler = (err: Error) => openCallbacks.error?.(err);

        this.socket.on('ready', () => {
            openCallbacks.open?.();
            this.socket.off('error', openErrorHandler);
            this.socket.on('error', (err: Error) => this.callbacks.error?.(err));
        });

        this.socket.on('error', openErrorHandler);
        this.socket.on('data', (data: Uint8Array) => this.callbacks.data?.(new Uint8Array(data)));
        this.socket.on('close', () => this.callbacks.end?.());
        this.socket.connect(port, host);
    }

    public put(c: number): void {
        this.socket.write(new Uint8Array([c]));
    }

    public write(buf: Uint8Array): void {
        this.socket.write(buf);
    }

    public onData(callback?: (data: Uint8Array) => void): void {
        this.callbacks.data = callback;
    }

    public onEnd(callback?: () => void): void {
        this.callbacks.end = callback;
    }

    public onError(callback?: (err: Error) => void): void {
        this.callbacks.error = callback;
    }

    public destroy(): Promise<void> {
        if (this.socket.destroyed) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const previousEnd = this.callbacks.end;
            const previousError = this.callbacks.error;

            this.callbacks.end = () => {
                previousEnd?.();
                resolve();
            };
            this.callbacks.error = (err: Error) => {
                previousError?.(err);
                reject(err);
            };

            this.socket.destroy();
        });
    }
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((port) => ({
        path: port.path,
        manufacturer: port.manufacturer,
    }));
}

export async function createDeviceWithStreamReady<TDevice>(
    streamFactory: (
        onReady: () => void,
        onError: (error: Error) => void
    ) => OpenableStream,
    deviceCtor: new (stream: OpenableStream, logger?: JaculusLogger) => TDevice,
    logger: JaculusLogger,
    onDeviceCreated?: (device: TDevice) => void
): Promise<TDevice> {
    let device: TDevice | undefined;
    let stream: OpenableStream | undefined;
    let isReady = false;
    let isDeviceCreated = false;

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const rejectAndDestroy = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            void stream?.destroy().catch(() => undefined);
            reject(error);
        };
        const resolveIfReady = () => {
            if (isReady && isDeviceCreated && !settled) {
                settled = true;
                resolve();
            }
        };

        try {
            stream = streamFactory(
                () => {
                    isReady = true;
                    resolveIfReady();
                },
                rejectAndDestroy
            );
            device = new deviceCtor(stream, logger);
            onDeviceCreated?.(device);
            isDeviceCreated = true;
            resolveIfReady();
        } catch (error) {
            rejectAndDestroy(error);
        }
    });

    if (!device) {
        throw new Error('Failed to create device');
    }

    return device;
}

export async function connectToDevice(
    target: ConnectionTarget,
    logger: JaculusLogger,
    onDeviceCreated?: (device: JacDevice) => void
): Promise<JacDevice> {
    const device = await createDeviceWithStreamReady(
        (onReady, onError) => {
            if (target.type === 'port') {
                return new SerialPortStream(
                    SerialPort,
                    target.value,
                    DEFAULT_BAUDRATE,
                    {
                        open: onReady,
                        error: onError,
                    }
                );
            }

            const { host, port } = parseSocketValue(target.value);
            return new SocketStream(host, port, {
                open: onReady,
                error: onError,
            });
        },
        JacDevice,
        logger,
        onDeviceCreated
    );

    const textDecoder = new TextDecoder();
    device.errorOutput.onData((data: Uint8Array) => logger.error(textDecoder.decode(data, { stream: true })));
    device.logOutput.onData((data: Uint8Array) => logger.info(textDecoder.decode(data, { stream: true })));
    device.debugOutput.onData((data: Uint8Array) => logger.debug(textDecoder.decode(data, { stream: true })));

    return device;
}

export async function destroyDevice(device: JacDevice): Promise<void> {
    const controller = device.controller as unknown as {
        unlock: () => PromiseLike<void>;
    };
    const unlock = controller.unlock;

    controller.unlock = () => Promise.resolve();
    void Promise.resolve(unlock.call(device.controller)).catch(() => undefined);

    await device.destroy();
}

export function runUntilDeviceEnd<T>(device: JacDevice, action: Promise<T>): Promise<T> {
    const disconnected = new Promise<never>((_, reject) => {
        device.onEnd(() => reject(new Error('Device disconnected')));
    });

    return Promise.race([action, disconnected]);
}

async function withDevice<T>(
    target: ConnectionTarget,
    logger: JaculusLogger,
    action: (device: JacDevice) => Promise<T>
): Promise<T> {
    const device = await connectToDevice(target, logger);
    try {
        return await runUntilDeviceEnd(device, action(device));
    } finally {
        await destroyDevice(device);
    }
}

async function withLockedDevice<T>(
    target: ConnectionTarget,
    logger: JaculusLogger,
    action: (device: JacDevice) => Promise<T>
): Promise<T> {
    return withDevice(target, logger, async (device) => {
        await device.controller.lock();
        try {
            return await action(device);
        } finally {
            await device.controller.unlock();
        }
    });
}

async function getRegistry(
    projectPath: string,
    logger: JaculusLogger
): Promise<Registry> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const pkg = fs.existsSync(packageJsonPath)
        ? await loadPackageJson(fs, packageJsonPath)
        : undefined;
    return new Registry(pkg?.jaculus?.registry, createRequestFunction(), logger);
}

export async function compileProject(
    projectPath: string,
    logger: JaculusLogger
): Promise<boolean> {
    return compileProjectPath(fs, projectPath, logger);
}

export async function listInstalledLibraries(
    projectPath: string,
    logger: JaculusLogger
): Promise<ProjectLibrary[]> {
    const project = new Project(fs, projectPath, logger);
    const dependencies = await project.listDependencies(false);

    return (Object.entries(dependencies) as Array<[string, string]>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, version]) => ({ name, version }));
}

export async function listAvailableLibraries(
    projectPath: string,
    logger: JaculusLogger
): Promise<AvailableLibrary[]> {
    const registry = await getRegistry(projectPath, logger);
    const libraries = await registry.listPackages();
    return libraries.sort((left: AvailableLibrary, right: AvailableLibrary) => left.id.localeCompare(right.id));
}

export async function listProjectTemplates(
    projectPath: string,
    logger: JaculusLogger
): Promise<ProjectTemplate[]> {
    const registry = await getRegistry(projectPath, logger);
    return registry.listTemplates('code');
}

async function createProjectFromBundle(
    projectPath: string,
    bundle: ProjectBundle,
    logger: JaculusLogger
): Promise<void> {
    await createFromBundle(fs, projectPath, bundle, logger);
    const project = new Project(fs, projectPath, logger);
    const registry = await getRegistry(projectPath, logger);
    await project.install(registry);
}

export async function createProjectFromTemplate(
    projectPath: string,
    templateId: string,
    version: string,
    logger: JaculusLogger
): Promise<void> {
    const registry = await getRegistry(projectPath, logger);
    const archive = await registry.getPackageTgz(templateId, version);
    const bundle = await extractArchive(archive);
    await createProjectFromBundle(projectPath, bundle, logger);
}

export async function createProjectFromArchiveData(
    projectPath: string,
    archiveData: Uint8Array,
    logger: JaculusLogger
): Promise<void> {
    const bundle = await extractArchive(archiveData);
    await createProjectFromBundle(projectPath, bundle, logger);
}

export async function listLibraryVersions(
    projectPath: string,
    libraryName: string,
    logger: JaculusLogger
): Promise<string[]> {
    const registry = await getRegistry(projectPath, logger);
    return registry.listVersions(libraryName);
}

export async function installLibraryVersion(
    projectPath: string,
    libraryName: string,
    version: string,
    logger: JaculusLogger
): Promise<void> {
    const project = new Project(fs, projectPath, logger);
    const registry = await getRegistry(projectPath, logger);
    await project.addLibraryVersion(registry, libraryName, version);
}

export async function removeLibrary(
    projectPath: string,
    libraryName: string,
    logger: JaculusLogger
): Promise<void> {
    const project = new Project(fs, projectPath, logger);
    const registry = await getRegistry(projectPath, logger);
    await project.removeLibrary(registry, libraryName);
}

export async function flashProject(
    projectPath: string,
    target: ConnectionTarget,
    logger: JaculusLogger,
    onProgress?: (progress: FlashProgress) => void,
    autoStart = true
): Promise<void> {
    const project = new Project(fs, projectPath, logger);
    const bundle = await project.getFlashFiles();

    await withLockedDevice(target, logger, async (device) => {
        try {
            await device.controller.stop();
        } catch (error) {
            logger.verbose(`Error stopping device: ${String(error)}`);
        }

        let previousCurrent = 0;
        await device.uploader.uploadFiles(bundle, 'code', (progress: UploaderProgress) => {
            const event = getFlashProgressEvent(progress, previousCurrent);
            previousCurrent = progress.current;
            onProgress?.(event);
        });

        if (autoStart) {
            const entryPoint = bundle.files['package.json'] ? '' : 'index.js';
            await device.controller.start(entryPoint);
        }
    });
}

async function fetchPackageBundle(
    packageUrl: string
): Promise<ProjectBundle> {
    const result = await loadPackageFromUri(createRequestFunction(), packageUrl);
    return result.package;
}

export async function createProjectFromPackage(
    projectPath: string,
    packageUrl: string,
    logger: JaculusLogger
): Promise<void> {
    const bundle = await fetchPackageBundle(packageUrl);
    await createProjectFromBundle(projectPath, bundle, logger);
}

export async function updateProjectFromPackage(
    projectPath: string,
    packageUrl: string,
    logger: JaculusLogger
): Promise<void> {
    const bundle = await fetchPackageBundle(packageUrl);
    await updateFromBundle(fs, projectPath, bundle, logger, false);
}

export async function startProgram(
    target: ConnectionTarget,
    logger: JaculusLogger
): Promise<void> {
    await withLockedDevice(target, logger, async (device) => {
        await device.controller.start('');
    });
}

export async function stopProgram(
    target: ConnectionTarget,
    logger: JaculusLogger
): Promise<void> {
    await withLockedDevice(target, logger, async (device) => {
        await device.controller.stop();
    });
}

export async function readVersion(
    target: ConnectionTarget,
    logger: JaculusLogger
): Promise<string[]> {
    return withDevice(target, logger, async (device) => device.controller.version());
}

export async function readStatus(
    target: ConnectionTarget,
    logger: JaculusLogger
): Promise<{ running: boolean; exitCode?: number; status: string }> {
    return withLockedDevice(target, logger, async (device) => device.controller.status());
}

export async function formatStorage(
    target: ConnectionTarget,
    logger: JaculusLogger
): Promise<void> {
    await withLockedDevice(target, logger, async (device) => {
        await device.uploader.formatStorage();
    });
}

export async function readWifiStatus(
    target: ConnectionTarget,
    logger: JaculusLogger
): Promise<string> {
    return withLockedDevice(target, logger, async (device) => {
        const mode = await device.controller.getWifiMode();
        const staMode = await device.controller.getWifiStaMode();
        const staSpecific = await device.controller.getWifiStaSpecific();
        const apSsid = await device.controller.getWifiApSsid();
        const currentIp = await device.controller.getCurrentWifiIp();

        return `Current IP: ${currentIp}\n\nWiFi Mode: ${WifiMode[mode]}\n\nStation Mode: ${WifiStaMode[staMode]}\nStation Specific SSID: ${staSpecific}\n\nAP SSID: ${apSsid}\n`;
    });
}

export async function addWifiNetwork(
    target: ConnectionTarget,
    ssid: string,
    password: string,
    logger: JaculusLogger
): Promise<void> {
    await withLockedDevice(target, logger, async (device) => {
        await device.controller.addWifiNetwork(ssid, password);
    });
}

export async function removeWifiNetwork(
    target: ConnectionTarget,
    ssid: string,
    logger: JaculusLogger
): Promise<void> {
    await withLockedDevice(target, logger, async (device) => {
        await device.controller.removeWifiNetwork(ssid);
    });
}

export async function setWifiApMode(
    target: ConnectionTarget,
    ssid: string,
    password: string | undefined,
    logger: JaculusLogger
): Promise<void> {
    await withLockedDevice(target, logger, async (device) => {
        await device.controller.setWifiMode(WifiMode.AP);
        await device.controller.setWifiApSsid(ssid);
        if (password !== undefined) {
            await device.controller.setWifiApPassword(password);
        }
    });
}

export async function setWifiStationMode(
    target: ConnectionTarget,
    logger: JaculusLogger
): Promise<void> {
    await withLockedDevice(target, logger, async (device) => {
        await device.controller.setWifiMode(WifiMode.STATION);
        await device.controller.setWifiStaMode(WifiStaMode.BEST_SIGNAL);
        await device.controller.setWifiStaApFallback(true);
    });
}

export async function disableWifi(
    target: ConnectionTarget,
    logger: JaculusLogger
): Promise<void> {
    await withLockedDevice(target, logger, async (device) => {
        await device.controller.setWifiMode(WifiMode.DISABLED);
    });
}

export async function installFirmwarePackage(
    packageUrl: string,
    port: string,
    noErase: boolean
): Promise<void> {
    const pkg = await loadFirmwarePackage(packageUrl);
    await pkg.flash(port, noErase);
}
