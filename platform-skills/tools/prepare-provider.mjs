#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readProviderRegistration,readProviderRegistrations,repositoryRoot} from './provider-ci.mjs';
export function prepareProvider(skill,mode,{root=repositoryRoot,run=spawnSync}={}) {
  if(!['check','prepare-test','prepare-package','test'].includes(mode))throw Error('provider_ci_invalid_mode');
  const registration=readProviderRegistration(skill,{root});
  if(mode==='check')return Boolean(registration);
  // Existing providers retain their reviewed historical workflow unchanged.
  if(!registration)return true;
  const execute=args=>{
    const result=run(process.execPath,args,{cwd:root,stdio:'inherit',shell:false,windowsHide:true});
    if(result.error || result.status!==0)throw Error('provider_ci_command_failed');
  };
  execute([path.join(root,registration.prepareFile),mode==='prepare-package'?'package':'test']);
  if(mode==='test') {
    execute([path.join(root,'platform-skills/tools/build-runtime-package.mjs'),'--skill-dir',`platform-skills/${skill}`,'--check']);
    execute(['--test',path.join(root,registration.matrix.testFile)]);
  }
  return true;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const argv=process.argv.slice(2);
    if(argv.length===2 && argv[0]==='--mode' && argv[1]==='list') {
      for(const skill of Object.keys(readProviderRegistrations()).sort())process.stdout.write(skill+'\n');
    } else {
      if(argv.length!==4 || argv[0]!=='--skill' || argv[2]!=='--mode')throw Error('provider_ci_arguments');
      if(!prepareProvider(argv[1],argv[3]))process.exitCode=1;
    }
  } catch {process.stderr.write('Provider CI preparation failed; inspect the exact registered source and command result.\n');process.exitCode=1;}
}
