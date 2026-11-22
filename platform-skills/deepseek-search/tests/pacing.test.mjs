import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';
import { run } from '../scripts/trelio-deepseek-search.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillId = 'deepseek-search';
const manifest = JSON.parse(await fs.readFile(new URL('../release.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-search-test-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const host = path.join(dir, 'visual.mjs');
  await fs.writeFile(host, `
    export const VISUAL_PRESENTATION_API = 'trelio.visual-presentation/v1';
    export const VISUAL_EXTERNAL_NAVIGATION_API = 'trelio.visual-external-navigation/v1';
    export const VISUAL_SEMANTIC_CONTROLS_API = 'trelio.visual-semantic-controls/v1';
    export function runVisualSession({env,...input}) { return input; }
  `);
  await fs.writeFile(path.join(dir, 'trelio-workspace.mjs'), `
    import fs from 'node:fs/promises';
    export async function readPrivateJsonFile(file, opts) {
      if (opts.maximumBytes !== 24576 || opts.fatalUtf8 !== true) throw Error('fixture guard failed');
      return JSON.parse(await fs.readFile(file,'utf8'));
    }
  `);
  const question = path.join(dir, 'question.json');
  await fs.writeFile(question, JSON.stringify({text:'RFC 9110 и пробел'}), {mode:0o600});
  const hostUrl = pathToFileURL(host).href;
  const env = { TRELIO_SKILL_ID: skillId, TRELIO_VISUAL_SESSION_MODULE_URL: hostUrl };
  return { dir, env, question };
}

test('signed provider preserves shared headless, pacing, manual handoff and references', async t => {
  const {env,question} = await fixture(t);
  const opened = await run(['open'], env);
  assert.equal(opened.operation, 'navigate');
  assert.equal(opened.args.url, 'https://chat.deepseek.com/');
  assert.equal(opened.presentation, 'hidden');
  assert.equal(opened.observationMode, 'text');
  assert.equal(opened.semanticControls, true);
  assert.equal(opened.externalNavigation, true);
  assert.equal(opened.referenceRoutes.length >= 1, true);
  assert.deepEqual((await run(['setup'], env)).args, opened.args);
  assert.equal((await run(['show-login'], env)).operation, 'show-login');
  assert.equal((await run(['ready'], env)).operation, 'ready');
  assert.equal((await run(['close'], env)).operation, 'close');
  assert.deepEqual((await run(['type-text','--frameId','fresh','--inputFile',question],env)).args,
    {frameId:'fresh',text:'RFC 9110 и пробел'});
  assert.deepEqual((await run(['submit','--frameId','fresh'],env)).args,
    {action:'key',key:'Enter',frameId:'fresh'});
  assert.deepEqual((await run(['submit','--frameId','fresh','--x','74','--y','45'],env)).args,
    {action:'click',frameId:'fresh',x:74,y:45});
  assert.equal((await run(['answer-ready','--frameId','fresh'],env)).operation,'request-ready');
  assert.deepEqual((await run(['open-source','--url','https://www.rfc-editor.org/rfc/rfc9110.html'],env)).args,
    {url:'https://www.rfc-editor.org/rfc/rfc9110.html'});
  await assert.rejects(run(['return-to-chat','--url','https://www.rfc-editor.org/'],env),/MANAGED_SEARCH_INVALID_INPUT/);
  await assert.rejects(run(['open-source','--url','file:///private/secret'],env),/MANAGED_SEARCH_INVALID_INPUT/);

});

test('rejects client overrides and unpaced Enter, while the exact package can discover accounts', async () => {
  for (const args of [['key','--frameId','fresh','--key','Enter'], ['open','--presentation','windowed'],
    ['navigate','--url','https://example.test/'], ['submit','--frameId','fresh','--x','25'],
    ['type-text','--frameId','fresh','--text','closed'],['setup','--url','https://other-provider.test/']]) {
    await assert.rejects(run(args, {}), /MANAGED_SEARCH_INVALID_INPUT/);
  }
  await assert.rejects(run(['open'],{}), /MANAGED_SEARCH_HOST_REQUIRED/);
  assert.equal((await run(['doctor'],{})).minimumHostVersion,manifest.runtime.minimumHostVersion);
  assert.equal((await run(['doctor'],{})).hostVisualAvailable,false);
  assert.deepEqual(await run(['__trelio_accounts_import'],new Proxy({},{
    get(){throw Error('account import must not consult the environment');}
  })),{schemaVersion:1,accounts:[]});
  const built = buildRuntimePackage(root);
  const { files } = JSON.parse(built.packageBytes);
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-search-package-')));
  try {
    for (const file of files) await fs.writeFile(path.join(dir,file.path),Buffer.from(file.contentBase64,'base64'));
    const result = spawnSync(process.execPath,
      [path.join(dir,manifest.runtime.entrypoint.path),'__trelio_accounts_import'],{encoding:'utf8',timeout:15000});
    assert.equal(result.stderr,'');
    assert.equal(result.status,0);
    assert.deepEqual(JSON.parse(result.stdout),{schemaVersion:1,accounts:[]});
  } finally { await fs.rm(dir, {recursive:true,force:true}); }
});
