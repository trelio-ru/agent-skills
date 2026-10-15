import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readProviderRegistration,readProviderRegistrations} from './provider-ci.mjs';
import {prepareProvider} from './prepare-provider.mjs';
import {selectProviderRegressions} from './select-provider-regressions.mjs';
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-ci-'));
  const directory=path.join(root,'platform-skills','new-fixture');
  fs.mkdirSync(path.join(directory,'tests'),{recursive:true});fs.mkdirSync(path.join(directory,'development'));
  fs.writeFileSync(path.join(directory,'tests/ci.mjs'),'// fixture');fs.writeFileSync(path.join(directory,'development/ci-prepare.mjs'),'// fixture');
  const manifest={schemaVersion:1,language:'node',testFile:'tests/ci.mjs',prepareFile:'development/ci-prepare.mjs'};
  const write=value=>fs.writeFileSync(path.join(directory,'ci.json'),JSON.stringify(value));
  write(manifest);return {root,directory,manifest,write,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('a new provider registers in its own scope and selects only its three OS jobs',()=>{
  const f=fixture();try {
    const registrations=readProviderRegistrations({root:f.root});
    const selection=selectProviderRegressions(['platform-skills/new-fixture/ci.json','platform-skills/new-fixture/src/reader.ts'],{registrations});
    assert.equal(selection.full,false);assert.deepEqual(selection.selectedSkills,['new-fixture']);
    assert.equal(selection.hostedMatrix.include.length,3);assert.ok(selection.hostedMatrix.include.every(row=>row.skill==='new-fixture'));
    const baseline=selectProviderRegressions(['platform-skills/max-web/scripts/trelio-max.mjs'],{registrations:{}});
    const unchanged=selectProviderRegressions(['platform-skills/max-web/scripts/trelio-max.mjs'],{registrations});
    assert.deepEqual(unchanged,baseline);
  } finally {f.cleanup();}
});
test('registration cannot override a historical provider or escape its own files',()=>{
  const f=fixture();try {
    for(const patch of [{testFile:'../max-web/tests/runtime.mjs'},{prepareFile:'/tmp/exec.mjs'},{testFile:'tests/no-file.mjs'},{prepareFile:'development/a;curl.mjs'},{language:'shell'},{extra:true}]) {
      f.write({...f.manifest,...patch});assert.throws(()=>readProviderRegistration('new-fixture',{root:f.root}));
    }
    f.write(f.manifest);const registration=readProviderRegistration('new-fixture',{root:f.root});
    assert.throws(()=>selectProviderRegressions(['platform-skills/max-web/ci.json'],{registrations:{'max-web':registration}}),/conflicts/u);
    assert.throws(()=>readProviderRegistration('../other',{root:f.root}));
  } finally {f.cleanup();}
});
test('registration rejects symlink entrypoints before any preparation',()=>{
  if(process.platform==='win32')return; // Windows unprivileged symlink is not a portable fixture primitive.
  const f=fixture();try {
    const script=path.join(f.directory,'development/ci-prepare.mjs');fs.unlinkSync(script);fs.symlinkSync(path.join(f.directory,'tests/ci.mjs'),script);
    assert.throws(()=>prepareProvider('new-fixture','test',{root:f.root,run:()=>{assert.fail('must not dispatch');}}),/symlink/u);
  } finally {f.cleanup();}
});
test('preparation is exact Node argv, package mode skips browsers/tests, failures stop dispatch',()=>{
  const f=fixture();try {
    const calls=[],run=(...args)=>{calls.push(args);return {status:0};};
    prepareProvider('new-fixture','prepare-package',{root:f.root,run});
    assert.equal(calls.length,1);assert.equal(calls[0][0],process.execPath);assert.equal(calls[0][1].at(-1),'package');assert.equal(calls[0][2].shell,false);
    calls.length=0;prepareProvider('new-fixture','test',{root:f.root,run});
    assert.equal(calls.length,3);assert.equal(calls[0][1].at(-1),'test');assert.equal(calls[2][1][0],'--test');
    let attempts=0;assert.throws(()=>prepareProvider('new-fixture','test',{root:f.root,run:()=>{attempts++;return {status:1};}}));assert.equal(attempts,1);
    calls.length=0;prepareProvider('legacy-fixture','prepare-test',{root:f.root,run});assert.equal(calls.length,0);
  } finally {f.cleanup();}
});
test('shared execution changes retain the full gate including newly registered providers',()=>{
  const f=fixture();try {
    const registrations=readProviderRegistrations({root:f.root});
    for(const file of ['platform-skills/tools/prepare-provider.mjs','.github/workflows/platform-skill-runtimes.yml']) {
      const selected=selectProviderRegressions([file],{registrations});assert.equal(selected.full,true);
      assert.ok(selected.selfHostedSkills.includes('new-fixture'));assert.ok(selected.selfHostedSkills.includes('vk-ads'));
    }
  } finally {f.cleanup();}
});
