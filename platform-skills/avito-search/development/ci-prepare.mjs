/** Provider-owned preparation. No website, secret, profile or personal runtime
 * is touched: npm uses the lockfile, browser download is fixture-only tooling. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const mode=process.argv[2];
if(!['test','package'].includes(mode))throw Error('invalid_ci_mode');
// GitHub's setup-node supplies npm beside its exact Node installation. Resolve
// that installation's JS entrypoint and execute it with Node on every OS;
// invoking npm.cmd through a shell would hide Windows quoting/errors.
const binaryRoot=path.dirname(process.execPath);
const candidates=[process.env.npm_execpath,
  path.join(binaryRoot,'node_modules/npm/bin/npm-cli.js'),
  path.join(binaryRoot,'../lib/node_modules/npm/bin/npm-cli.js'),
  path.join(binaryRoot,'npm')].filter(Boolean);
const npm=candidates.map(file=>{try{return fs.realpathSync(file);}catch{return null;}})
  .find(file=>file?.endsWith('npm-cli.js'));
if(!npm)throw Error('node_installation_npm_entrypoint_missing');
const run=args=>{
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',shell:false,windowsHide:true});
  if(result.error || result.status!==0)throw Error('provider_preparation_failed');
};
run([npm,'ci','--ignore-scripts','--no-audit','--no-fund']);
run([npm,'run','typecheck']);run([npm,'run','build']);
if(mode==='test')run([path.join(root,'node_modules/playwright/cli.js'),'install','--with-deps','chromium']);
