// Native concurrency fixture only: three independent parents execute the
// actual production dispatch guard. The installer is a short owned process,
// so this regression needs neither network nor a model/credential override.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ensureSetup} from '../scripts/bootstrap.mjs';

const root=process.argv[2];
let owned;
const result=ensureSetup(root,{launcher:(executable,_args,options)=>{
  fs.appendFileSync(path.join(root,'fixture-dispatches'),'one\n',{mode:0o600});
  // The parent intentionally waits for its own child. The other parents must
  // observe that same live dispatch, never create another worker from polling.
  owned=spawn(executable,['-e','setTimeout(()=>{},1500)'],{...options,detached:false});
  return owned;
}});
owned?.ref();
process.stdout.write(JSON.stringify(result));
