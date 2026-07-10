import * as vscode from 'vscode';

import type { JaculusLogger } from './integration.js';

export enum LogLevel {
    error = 'error',
    warn = 'warn',
    info = 'info',
    verbose = 'verbose',
    debug = 'debug',
    silly = 'silly',
}

const LOG_LEVEL_ORDER: LogLevel[] = [
    LogLevel.error,
    LogLevel.warn,
    LogLevel.info,
    LogLevel.verbose,
    LogLevel.debug,
    LogLevel.silly,
];

export function createLogger(
    outputChannel: vscode.OutputChannel,
    level: LogLevel = LogLevel.info
): JaculusLogger {
    const shouldLog = (candidate: LogLevel): boolean =>
        LOG_LEVEL_ORDER.indexOf(candidate) <= LOG_LEVEL_ORDER.indexOf(level);

    const write = (kind: LogLevel, message?: string) => {
        if (shouldLog(kind)) {
            outputChannel.appendLine(`[${kind}] ${message ?? ''}`);
        }
    };

    return {
        info: (message?: string) => write(LogLevel.info, message),
        warn: (message?: string) => write(LogLevel.warn, message),
        error: (message?: string) => write(LogLevel.error, message),
        verbose: (message?: string) => write(LogLevel.verbose, message),
        debug: (message?: string) => write(LogLevel.debug, message),
        silly: (message?: string) => write(LogLevel.silly, message),
    };
}
