import { spawnSync } from 'node:child_process';
import { readFile, mkdir, copyFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// The exact lockfile owns every transitive dependency. Build output is disposable
// and packaged by the ordinary builder, never committed or downloaded at runtime.
const nodeDirectory = path.dirname(await realpath(process.execPath));
const npmCli = process.platform === 'win32'
  ? path.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js')
  : path.resolve(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js');
const install = spawnSync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: root, stdio: 'inherit', shell: false });
if (install.status !== 0) throw new Error('apple_calendar_dependencies_failed');
const { build } = await import(path.join(root, 'node_modules/esbuild/lib/main.js'));
await mkdir(path.join(root, '.build'), { recursive: true });
for (const [name, entry] of [['ical', 'ical.js'], ['temporal', '@js-temporal/polyfill'], ['xml', 'xml-js']]) {
  const contents = name === 'xml' ? `import xml from '${entry}';export const xml2js=xml.xml2js;`
    : `export * from '${entry}';${name === 'ical' ? `export {default} from '${entry}';` : ''}`;
  await build({ stdin: { contents,
    resolveDir: root }, outfile: path.join(root, '.build', `${name}.mjs`), bundle: true,
    format: 'esm', platform: 'node', target: 'node22', legalComments: 'inline' });
}
for (const [dependency, filename] of [['ical.js','LICENSE'], ['@js-temporal/polyfill','LICENSE'], ['xml-js','LICENSE'], ['sax','LICENSE.md'], ['jsbi','LICENSE']]) {
  const body = await readFile(path.join(root, 'node_modules', dependency, filename));
  const destination = path.join(root, '.build', `${dependency.replaceAll('/', '-')}.LICENSE`);
  await copyFile(path.join(root, 'node_modules', dependency, filename), destination);
  if (!body.length) throw new Error('dependency_license_missing');
}
