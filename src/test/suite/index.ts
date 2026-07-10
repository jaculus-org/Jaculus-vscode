import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Mocha from 'mocha';
import glob from 'glob';

const fileName = fileURLToPath(import.meta.url);
const dirName = path.dirname(fileName);

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    const testsRoot = path.resolve(dirName, '..');

    return new Promise((c, e) => {
        glob('**/**.test.js', { cwd: testsRoot }, async (err: Error | null, files: string[]) => {
            if (err) {
                return e(err);
            }

            try {
                // ESM imports run before mocha.run(), so install the TDD globals first.
                mocha.suite.emit('pre-require', globalThis, '', mocha);

                for (const file of files) {
                    await import(pathToFileURL(path.resolve(testsRoot, file)).href);
                }

                mocha.run((failures: number) => {
                    if (failures > 0) {
                        e(new Error(`${failures} tests failed.`));
                    } else {
                        c();
                    }
                });
            } catch (err) {
                console.error(err);
                e(err);
            }
        });
    });
}
