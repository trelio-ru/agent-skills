import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
// No browser download, dotenv or lifecycle script. Bundle locked Node modules
// into one deterministic artifact; Playwright is loaded only from Trelio host.
const result=await build({absWorkingDir:root,entryPoints:['src/trelio.ts'],outfile:path.join(root,'dist/trelio-avito.cjs'),
  metafile:true,bundle:true,platform:'node',format:'cjs',target:'node22',legalComments:'eof',sourcemap:false,external:['playwright'],logLevel:'warning'});
// Preserve each dependency's notice with the artifact. These files are public
// package metadata, never environment/release secrets. Do not invent a project
// license; upstream's MIT declaration is retained separately.
const packages=new Set();
for(const input of Object.keys(result.metafile.inputs)) {
  if(!input.startsWith('node_modules/'))continue;
  let directory=path.dirname(path.join(root,input));
  while(directory!==root && !fs.existsSync(path.join(directory,'package.json')))directory=path.dirname(directory);
  if(directory!==root)packages.add(directory);
}
const notices=[];
for(const directory of [...packages].sort()) {
  for(const name of fs.readdirSync(directory).sort()) {
    if(!/^licen[cs]e(?:[.-]|$)|^notice(?:[.-]|$)/iu.test(name))continue;
    const file=path.join(directory,name);
    if(fs.statSync(file).isFile())notices.push(path.relative(root,file).split(path.sep).join('/')+'\n'+fs.readFileSync(file,'utf8'));
  }
}
fs.writeFileSync(path.join(root,'dist/THIRD-PARTY-NOTICES.txt'),notices.join('\n\n'));
