/** Data-only registration for new providers. Adding a provider must not edit
 * the shared selector/workflow/executor: its ci.json stays in its own scope.
 * Common code still gets the full gate. Paths cannot select another provider,
 * shell command or a file outside this repository. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url));
const slug=/^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
function sourcePath(root,skill,value,kind) {
  const prefix=kind==='test'?'tests/':'development/';
  if(typeof value!=='string' || !value.startsWith(prefix) || !value.endsWith('.mjs') ||
      value.split('/').some(part=>!part || part==='.' || part==='..' || !/^[a-zA-Z0-9_.-]+$/u.test(part)))throw Error('provider_ci_invalid_path');
  const relative=`platform-skills/${skill}/${value}`,absolute=path.join(root,relative);
  // Check every existing ancestor too: a symlink directory must not turn an
  // apparently provider-local script into a sibling's preparation command.
  let current=root;
  for(const part of relative.split('/')) {
    current=path.join(current,part);const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink())throw Error('provider_ci_symlink');
  }
  if(!fs.statSync(absolute).isFile())throw Error('provider_ci_not_file');
  return relative;
}
export function readProviderRegistration(skill,{root=repositoryRoot}={}) {
  if(!slug.test(skill))throw Error('provider_ci_invalid_skill');
  const file=path.join(root,'platform-skills',skill,'ci.json');
  if(!fs.existsSync(file))return null;
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>4096)throw Error('provider_ci_invalid_manifest');
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!data || Object.keys(data).sort().join()!=='language,prepareFile,schemaVersion,testFile' || data.schemaVersion!==1 || data.language!=='node')throw Error('provider_ci_invalid_schema');
  return {owner:'general',matrix:{language:'node',testFile:sourcePath(root,skill,data.testFile,'test')},
    prepareFile:sourcePath(root,skill,data.prepareFile,'prepare')};
}
export function readProviderRegistrations({root=repositoryRoot}={}) {
  const result=Object.create(null);
  for(const entry of fs.readdirSync(path.join(root,'platform-skills'),{withFileTypes:true})) {
    if(!entry.isDirectory() || !slug.test(entry.name))continue;
    const registration=readProviderRegistration(entry.name,{root});
    if(registration)result[entry.name]=registration;
  }
  return result;
}
