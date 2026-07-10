import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JACLY_REPOSITORY = 'https://github.com/jaculus-org/JacLy';
export const JACLY_COMMIT = '01de244';
export const JACLY_DIRECTORY = '.jacly';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = path.join(root, JACLY_DIRECTORY);
const revisionFile = path.join(checkout, '.jacly-revision');

function runGit(args) {
  execFileSync('git', args, { cwd: root, stdio: 'inherit' });
}

function hasExpectedRevision() {
  return existsSync(revisionFile) && readFileSync(revisionFile, 'utf8').trim() === JACLY_COMMIT;
}

export function fetchJacly() {
  if (!hasExpectedRevision()) {
    rmSync(checkout, { recursive: true, force: true });
    runGit(['clone', '--filter=blob:none', '--no-checkout', JACLY_REPOSITORY, JACLY_DIRECTORY]);
    runGit(['-C', JACLY_DIRECTORY, 'sparse-checkout', 'set', 'extensions/vscode', 'packages/jacly', 'media/logo']);
    runGit(['-C', JACLY_DIRECTORY, 'checkout', '--detach', JACLY_COMMIT]);
    mkdirSync(checkout, { recursive: true });
    writeFileSync(revisionFile, `${JACLY_COMMIT}\n`);
  }

  mkdirSync(path.join(root, 'media'), { recursive: true });
  mkdirSync(path.join(root, 'syntaxes'), { recursive: true });
  cpSync(path.join(checkout, 'extensions/vscode/media/index.html'), path.join(root, 'media/index.html'));
  cpSync(path.join(checkout, 'extensions/vscode/syntaxes/jacly.tmLanguage.json'), path.join(root, 'syntaxes/jacly.tmLanguage.json'));
  cpSync(path.join(checkout, 'media/logo/jacly.png'), path.join(root, 'images/jacly.png'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchJacly();
}
