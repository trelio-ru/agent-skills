/** Host-private original processing reuses the ordinary signed ASR job engine.
 * It prepares only the fixed signed local engine, never selects another
 * model/service, sends a message or treats a download as a transcript. Unknown starts are
 * status-only: an exclusive receipt precedes the one existing worker launch. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {privateDirectory} from './storage.mjs';

const fail=()=>{throw Error('AUDIO_SOURCE_INPUT_INVALID');};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/u.test(value);

/** Reject links/junctions at every existing ancestor, before native file I/O.
 * Inputs/destination are host-owned, never a provider/native filename or URL.
 * Do not repair a foreign source's ownership/permissions. */
function checkPath(file,{directory=false}={}){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0')||Buffer.byteLength(file)>4096)fail();
  let cursor=path.parse(file).root;
  const parts=file.slice(cursor.length).split(path.sep).filter(Boolean);
  for(const [index,part] of parts.entries()){
    cursor=path.join(cursor,part);const stat=fs.lstatSync(cursor);
    if(stat.isSymbolicLink()||(stat.mode&0o170000)===0o120000
      ||(index<parts.length-1||directory?!stat.isDirectory():!stat.isFile()))fail();
  }
  const stat=fs.lstatSync(file);
  if(process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o777)!==(directory?0o700:0o600)))fail();
  if(process.platform==='win32'){
    // Node Stats has no native FileAttributes/ACL view. Verify every ancestor
    // and the existing leaf with the OS, without repairing a foreign file.
    const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const helper=fileURLToPath(new URL('source-path.ps1',import.meta.url));
    const checked=spawnSync(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,
      '-LiteralPath',file,'-Kind',directory?'directory':'file'],{shell:false,windowsHide:true,encoding:'utf8',timeout:30000});
    if(checked.status!==0||checked.stdout?.trim()!=='{"privateSource":true}'){
      // Preserve only this helper's closed native verification stage for
      // diagnostics. The ordinary CLI error message/refusal stays unchanged;
      // raw stderr, filesystem paths and ownership values remain private.
      const stage=/^AUDIO_SOURCE_INPUT_INVALID_(IDENTITY|PATH|KIND|ACL|OWNER|AUDIENCE)$/u.exec(checked.stderr?.trim()??'')?.[1];
      throw Object.assign(Error('AUDIO_SOURCE_INPUT_INVALID'),{code:stage?`AUDIO_SOURCE_INPUT_INVALID_${stage}`:'AUDIO_SOURCE_INPUT_INVALID'});
    }
  }
  return stat;
}

/** A complete bounded handle read with EOF and pathname identity recheck.
 * The file remains private; only its digest/size enter the process receipt. */
function readSourceBytes(file,maximum,{allowEmpty=false}={}){
  const before=checkPath(file);
  if(!Number.isSafeInteger(before.size)||before.size<(allowEmpty?0:1)||before.size>maximum||before.nlink!==1)fail();
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  const bytes=Buffer.alloc(before.size);
  try{
    const opened=fs.fstatSync(fd);
    if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)fail();
    let position=0;
    while(position<bytes.length){const count=fs.readSync(fd,bytes,position,bytes.length-position,position);if(!count)fail();position+=count;}
    if(fs.readSync(fd,Buffer.alloc(1),0,1,position))fail();
    const after=fs.fstatSync(fd),current=checkPath(file);
    if([after,current].some(info=>info.dev!==before.dev||info.ino!==before.ino||info.size!==before.size
      ||info.mtimeMs!==before.mtimeMs||info.ctimeMs!==before.ctimeMs))fail();
    return bytes;
  }catch(error){bytes.fill(0);throw error;}finally{fs.closeSync(fd);}
}

export function sourceFileFingerprint(file,maximum,options={}){
  const bytes=readSourceBytes(file,maximum,options);
  try{return {sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
  finally{bytes.fill(0);}
}

function sourceJson(file,maximum=32*1024*1024){
  const bytes=readSourceBytes(file,maximum);
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{fail();}finally{bytes.fill(0);}
}

export async function readSourceOriginalInput(stream){
  const chunks=[];let size=0;
  for await(const chunk of stream){if(!Buffer.isBuffer(chunk))fail();size+=chunk.length;if(size>8192)fail();chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{fail();}finally{bytes.fill(0);for(const chunk of chunks)chunk.fill(0);}
}

export async function processSourceOriginal(input,{root,run}){
  if(!exact(input,['schemaVersion','requestId','original','outputDirectory'])||input.schemaVersion!==1||!uuid(input.requestId)
    ||!exact(input.original,['filePath','sizeBytes','sha256'])||!digest(input.original.sha256)
    ||!Number.isSafeInteger(input.original.sizeBytes)||input.original.sizeBytes<1||input.original.sizeBytes>20*1024*1024
    ||typeof input.outputDirectory!=='string'||path.basename(input.outputDirectory)!=='job')fail();
  const original=sourceFileFingerprint(input.original.filePath,20*1024*1024);
  if(original.sizeBytes!==input.original.sizeBytes||original.sha256!==input.original.sha256)fail();
  const parent=path.dirname(input.outputDirectory);checkPath(parent,{directory:true});
  const answer={schemaVersion:1,protocol:'assistant-source-audio/v1',requestId:input.requestId,contentRead:false};
  // Doctor remains offline. First authorized use prepares only this signed
  // provider's fixed model/environment. Pending setup maps to the existing
  // queued protocol, so the host keeps this SAME intake without an owner
  // question, a new account/task or an expanded setup command surface.
  const doctor=await run(['doctor'],{root});
  if(doctor.ready!==true){
    const preparation=await run(['ensure'],{root});
    if(preparation.state==='unknown')return {...answer,state:'unknown',code:'AUDIO_SOURCE_START_UNKNOWN'};
    if(preparation.ok!==true)return {...answer,state:'unavailable',code:'AUDIO_SOURCE_PROCESSING_UNAVAILABLE'};
    // Another installer may have completed between doctor and ensure. Keep
    // this read pending until a fresh doctor confirms the exact model before
    // creating the source's irreversible decoder claim.
    return {...answer,state:'queued'};
  }
  const claimFile=path.join(parent,'.source-attempt.json');
  const claim={schemaVersion:1,requestId:input.requestId,original:input.original};
  let claimed=false;
  try{
    const fd=fs.openSync(claimFile,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(claim));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    claimed=true;
  }catch(error){if(error.code!=='EEXIST')throw error;}
  const saved=sourceJson(claimFile,8192);
  if(!exact(saved,['schemaVersion','requestId','original'])||saved.schemaVersion!==1||saved.requestId!==input.requestId
    ||!exact(saved.original,['filePath','sha256','sizeBytes'])
    ||['sha256','sizeBytes'].some(key=>saved.original[key]!==input.original[key])||typeof saved.original.filePath!=='string')fail();
  let result;
  const jobSource=path.join(parent,'source.ogg');
  if(claimed){
    // One irreversible local start, durably fenced BEFORE ordinary start.
    // A lost process/result cannot create a second decoder for this original.
    // The common original-file receipt has its own one-hour deletion timer.
    // Freeze exactly these already verified bytes into this SAME owned job
    // before start, so that timer cannot remove an active decoder's input.
    // A crash after the durable claim still remains unknown/status-only.
    const bytes=readSourceBytes(input.original.filePath,20*1024*1024);
    try{
      if(bytes.length!==input.original.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==input.original.sha256)fail();
      checkPath(parent,{directory:true});
      const fd=fs.openSync(jobSource,'wx',0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }finally{bytes.fill(0);}
    privateDirectory(input.outputDirectory);
    result=await run(['start','--input',jobSource,'--output-dir',input.outputDirectory],{root});
  }else{
    if(!fs.existsSync(path.join(input.outputDirectory,'job.json')))return {...answer,state:'unknown',code:'AUDIO_SOURCE_START_UNKNOWN'};
    checkPath(input.outputDirectory,{directory:true});
    const job=sourceJson(path.join(input.outputDirectory,'job.json'));
    if(!job||job.input!==jobSource||job.originalSize!==input.original.sizeBytes)fail();
    result=await run(['status','--job-dir',input.outputDirectory],{root});
  }
  if(result.ok!==true)return {...answer,state:'unavailable',code:'AUDIO_SOURCE_PROCESSING_UNAVAILABLE'};
  const states=['queued','validating','loading','transcribing','completed','cancelled','interrupted','failed'];
  if(!states.includes(result.state))fail();
  if(result.state!=='completed')return {...answer,state:result.state};
  const job=sourceJson(path.join(input.outputDirectory,'job.json'));
  const transcript=sourceJson(path.join(input.outputDirectory,'transcript.json'));
  if(job?.state!=='completed'||job.sourceSha256!==input.original.sha256||transcript?.complete!==true
    ||transcript.model!==doctor.model||job.model!==doctor.model)fail();
  const text=sourceFileFingerprint(path.join(input.outputDirectory,'transcript.txt'),24*1024*1024,{allowEmpty:true});
  return {...answer,state:'completed',model:doctor.model,text};
}
