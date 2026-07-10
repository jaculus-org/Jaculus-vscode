import type { UploaderProgress } from '@jaculus/device';

export type FlashProgressEvent = {
    message: string;
    increment?: number;
};

export function getFlashProgressEvent(
    progress: UploaderProgress,
    previousCurrent: number
): FlashProgressEvent {
    if (progress.phase === 'getDirHashes') {
        return {
            message: `Hashing ${progress.filePath ?? ''}`.trim(),
        };
    }

    const filePath = progress.filePath ?? '';
    const action = progress.action ?? 'sync';
    const message = `${action}: ${filePath}`.trim();

    if (progress.total === undefined || progress.total <= 0) {
        return { message };
    }

    const safePrevious = Math.min(previousCurrent, progress.total);
    const safeCurrent = Math.min(progress.current, progress.total);
    const increment = Math.max(0, ((safeCurrent - safePrevious) / progress.total) * 100);

    return {
        message,
        increment,
    };
}
