import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';
import { run } from '../scripts/trelio-consultant-plus.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillId = 'consultant-plus';
const manifest = JSON.parse(await fs.readFile(new URL('../release.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-search-test-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const host = path.join(dir, 'visual.mjs');
  await fs.writeFile(host, `
    export const VISUAL_PRESENTATION_API = 'trelio.visual-presentation/v1';
    export const VISUAL_ATTACHMENT_FILE_API = 'trelio.visual-attachment-file/v1';
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

test('signed provider preserves shared headless, paced search, manual handoff and original exports', async t => {
  const {env,question} = await fixture(t);
  const opened = await run(['open'], env);
  assert.equal(opened.operation, 'navigate');
  assert.equal(opened.args.url, 'https://cloud.consultant.ru/');
  assert.equal(opened.presentation, 'hidden');
  assert.equal(opened.observationMode, 'text');
  assert.equal(opened.semanticControls, true);
  assert.deepEqual(opened.domains, ['consultant.ru']);
  assert.deepEqual(opened.attachmentFilePolicy, { origins: ['https://cloud.consultant.ru'] });
  assert.equal(opened.attachmentDownloads, true);
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
  const download = await run(['download-original','--frameId','fresh','--x','74','--y','45'],env);
  assert.deepEqual(download.args, {frameId:'fresh',x:74,y:45});
  assert.equal(download.operation, 'download-attachment');
  assert.deepEqual(download.attachmentFilePolicy, opened.attachmentFilePolicy);
  const reference = 'https://independent-source.example.test/document';
  assert.deepEqual((await run(['navigate','--url',reference],env)).args, { url: reference });
  await assert.rejects(run(['download-original','--url','https://cloud.consultant.ru/example'],env),
    /MANAGED_SEARCH_INVALID_INPUT/);
});

test('rejects client overrides and unpaced Enter, while the exact package can discover accounts', async () => {
  for (const args of [['key','--frameId','fresh','--key','Enter'], ['open','--presentation','windowed'],
    ['submit','--frameId','fresh','--x','25'],
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

test("skill keeps onboarding, browser handoff, workspace evidence, export and fallback decisions explicit", async () => {
  const instructions = await fs.readFile(new URL('../SKILL.md', import.meta.url), 'utf8');

  // Keep every pre-refactor security/evidence decision explicit while allowing
  // concise phrasing. These assertions cover the main delivered text itself;
  // the Markdown skill must not depend on inaccessible package references.
  const decisions = [
    /The user completes protected input/u,
    /Keep routine work headless/u,
    /will\*\*[\s\S]*Продолжить работу[\s\S]*not logout/u,
    /`download-original --frameId --x --y`/u,
    /Download\s+autonomously/u,
    /Before Agent Workspace handoff\/submit, save every exact source materially/u,
    /supporting conclusions, recommendations, controlling dates, quotes or edition/u,
    /Exclude exploratory\/unrelied results/u,
    /commentary[\s\S]*labeled commentary rather than primary source/u,
    /Do not automatically attach\s+or publish all sources outside that Workspace/u,
    /Prefer DOCX/u,
    /PDF for forms/u,
    /Unicode text/u,
    /no bulk result-list,[\s\S]*all-edition or corpus exports/u,
    /Never request, receive, store or inspect\s+login\/password, OTP, cookies, profile\s+files or session tokens/u,
    /independent public legal source/u,
    /wait for explicit selection/u,
    /not automatic switching/u,
    /Never enter protected ConsultantPlus via alternate credentials/u,
  ];
  for (const decision of decisions) assert.match(instructions, decision);
  assert.ok(Buffer.byteLength(instructions.trim()) <= 16384);

});
