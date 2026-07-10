import chalk from 'chalk';

chalk.level = chalk.level || 1;

export function getMonitorEcho(data: string): string | null {
    if (data === '\x03') {
        return null;
    }

    if (data === '\r') {
        return '\r\n';
    }

    return data;
}

export function getMonitorErrorOutput(data: string): string {
    return chalk.red(data);
}

export function getMonitorStatusOutput(data: string): string {
    return chalk.yellow(data);
}
