import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {parseArguments} from '../scripts/trelio-max.mjs';
import {buildRuntimePackage} from '../../tools/build-runtime-package.mjs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const policy=JSON.parse(fs.readFileSync(path.join(root,'scripts/trelio-assistant-execution.json'),'utf8'));
const environment={TRELIO_SKILL_ID:'max-web',TRELIO_SKILL_RUNTIME_VERSION:'2.10.2',
  TRELIO_SKILL_COMPANY_ID:'11111111-1111-4111-8111-111111111111',
  TRELIO_SKILL_MEMBER_ID:'22222222-2222-4222-8222-222222222222',
  TRELIO_SKILL_CONNECTION_ID:'33333333-3333-4333-8333-333333333333'};

test('MAX signed task policy classifies the real parser and keeps setup/admin private',()=>{
  assert.deepEqual(Object.keys(policy).sort(),['deniedOptions','schemaVersion','taskCommands']);
  assert.equal(policy.schemaVersion,2);
  assert.equal(new Set(policy.taskCommands.map(prefix=>JSON.stringify(prefix))).size,policy.taskCommands.length);
  for(const prefix of policy.taskCommands){
    if(prefix[0]==='guides')continue; // Existing real packaged guides entry is metadata-only.
    const parsed=parseArguments(prefix,environment);
    assert.equal(parsed.command,prefix[0]);
    if(prefix[0]==='policy')assert.equal(parsed.policyCommand,'show');
  }
  for(const denied of [['login'],['bootstrap'],['policy','set'],['monitor'],['watch'],['ack-reference'],
    ['assist-start'],['assist-click'],['edit'],['delete'],['forward'],['create-group'],['member-add'],['chat-update']])
    assert.equal(policy.taskCommands.some(prefix=>prefix.every((token,index)=>denied[index]===token)),false);
  // This override is intentionally valid for a human CLI. A task descriptor
  // must therefore opt into v2 enforcement, not pretend prefix checks alone
  // stop a different executable before the shared browser layer sees it.
  assert.ok(parseArguments(['read','--chrome','/synthetic-browser'],environment).chromeExecutable);
  assert.deepEqual(policy.deniedOptions,['--chrome','--headed','--headless','--hold-ms','--timeout-ms']);
  for(const option of policy.deniedOptions) {
    // The shared deny is literal, so introducing CLI abbreviations here would
    // reopen an override unless the signed policy/contract is reviewed too.
    assert.throws(()=>parseArguments(['read',option.slice(0,-1),'/synthetic-value'],environment),/Unknown argument/);
  }
  assert.throws(()=>parseArguments(['read','--Chrome','/synthetic-browser'],environment),/Unknown argument/);
});

test('MAX command restrictions are present in the existing signed file inventory',()=>{
  const packaged=JSON.parse(buildRuntimePackage(root).packageBytes);
  const declaration=packaged.files.find(file=>file.path==='trelio-assistant-execution.json');
  assert.ok(declaration);
  assert.deepEqual(JSON.parse(Buffer.from(declaration.contentBase64,'base64').toString('utf8')),policy);
});
