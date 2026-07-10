import * as path from 'path';
import { fileURLToPath } from 'url';

import { runTests } from '@vscode/test-electron';

const fileName = fileURLToPath(import.meta.url);
const dirName = path.dirname(fileName);

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(dirName, '../../');

        const extensionTestsPath = path.resolve(dirName, './suite/index.js');

        await runTests({ extensionDevelopmentPath, extensionTestsPath });
    } catch (err) {
        console.error('Failed to run tests', err);
        process.exit(1);
    }
}

main();
