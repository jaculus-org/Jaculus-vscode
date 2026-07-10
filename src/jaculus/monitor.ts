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
    return `\x1b[31m${data}\x1b[0m`;
}

export function getMonitorStatusOutput(data: string): string {
    return `\x1b[33m${data}\x1b[0m`;
}
