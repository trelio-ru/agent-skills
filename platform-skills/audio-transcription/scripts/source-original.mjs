/** Host-private original processing reuses the ordinary signed ASR job engine.
 * It prepares only the fixed signed local engine, never selects another
 * model/service, sends a message or treats a download as a transcript. Unknown starts are
 * status-only: an exclusive receipt precedes the one existing worker launch. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomicJson,privateDirectory} from './storage.mjs';

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
function readSourceBytes(file,maximum,{allowEmpty=false,progressSnapshot=false,afterStat}={}){
  const before=checkPath(file);
  if(!Number.isSafeInteger(before.size)||before.size<(allowEmpty?0:1)||before.size>maximum||before.nlink!==1)fail();
  // The worker atomically replaces its progress JSON. Windows ACL checking
  // deliberately takes a native round trip, so that pathname can legitimately
  // point at a newer inode before open. Only this internal mutable snapshot
  // may report "changed" without bytes; original/final evidence stays strict.
  const changed=()=>{throw Object.assign(Error(progressSnapshot?'AUDIO_SOURCE_SNAPSHOT_CHANGED':'AUDIO_SOURCE_INPUT_INVALID'),
    {code:progressSnapshot?'AUDIO_SOURCE_SNAPSHOT_CHANGED':'AUDIO_SOURCE_INPUT_INVALID'});};
  afterStat?.(); // Deterministic native filesystem-race fixture; no CLI/env hook.
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  const bytes=Buffer.alloc(before.size);
  try{
    const opened=fs.fstatSync(fd);
    if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)changed();
    let position=0;
    while(position<bytes.length){const count=fs.readSync(fd,bytes,position,bytes.length-position,position);if(!count)fail();position+=count;}
    if(fs.readSync(fd,Buffer.alloc(1),0,1,position))fail();
    const after=fs.fstatSync(fd),current=checkPath(file);
    if([after,current].some(info=>info.dev!==before.dev||info.ino!==before.ino||info.size!==before.size
      ||info.mtimeMs!==before.mtimeMs||info.ctimeMs!==before.ctimeMs))changed();
    return bytes;
  }catch(error){bytes.fill(0);throw error;}finally{fs.closeSync(fd);}
}

export function sourceFileFingerprint(file,maximum,options={}){
  const bytes=readSourceBytes(file,maximum,options);
  try{return {sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
  finally{bytes.fill(0);}
}

function sourceJson(file,maximum=32*1024*1024,options={}){
  const bytes=readSourceBytes(file,maximum,options);
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{fail();}finally{bytes.fill(0);}
}

export function readSourceProgressJson(file,options={}){
  return sourceJson(file,32*1024*1024,{...options,progressSnapshot:true});
}

export async function readSourceOriginalInput(stream){
  const chunks=[];let size=0;
  for await(const chunk of stream){if(!Buffer.isBuffer(chunk))fail();size+=chunk.length;if(size>8192)fail();chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{fail();}finally{bytes.fill(0);for(const chunk of chunks)chunk.fill(0);}
}

/** Only host-private source jobs participate. A fresh native original grant is
 * still required on every invocation; an old job is never a read permission.
 * Compare the frozen audio itself, model, terminal JSON and full text. Ordinary
 * task output directories, partial jobs and unknown starts cannot be adopted.
 * Discovery is bounded and exhaustive: neither newest-file selection nor the
 * first of conflicting transcripts is a valid answer. */
function completedOriginal(parent,original,model){
  if(!/^download-[A-Za-z0-9]{6}$/u.test(path.basename(parent)))return null;
  const scratch=path.dirname(parent);checkPath(scratch,{directory:true});
  const entries=fs.readdirSync(scratch,{withFileTypes:true});
  if(entries.length>256)fail();
  let selected=null,matches=0;
  try{
    for(const entry of entries){
      if(!/^download-[A-Za-z0-9]{6}$/u.test(entry.name))continue;
      const candidate=path.join(scratch,entry.name);if(candidate===parent)continue;
      // lstat is only a cheap existence check. Before reading any candidate,
      // the SAME private/ancestor/ACL reader checks its claim and every file.
      const claimPath=path.join(candidate,'.source-attempt.json');
      try{fs.lstatSync(claimPath);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      const claim=sourceJson(claimPath,8192);
      if(claim?.schemaVersion!==1||!uuid(claim.requestId)||claim.original?.sha256!==original.sha256
        ||claim.original?.sizeBytes!==original.sizeBytes)continue;
      if(!exact(claim,['schemaVersion','requestId','original'])||!exact(claim.original,['filePath','sha256','sizeBytes'])
        ||typeof claim.original.filePath!=='string'||!path.isAbsolute(claim.original.filePath))fail();
      if(++matches>8)fail();
      const directory=path.join(candidate,'job'),jobPath=path.join(directory,'job.json');
      try{fs.lstatSync(jobPath);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      let job;
      try{job=readSourceProgressJson(jobPath);}catch(error){if(error.code==='AUDIO_SOURCE_SNAPSHOT_CHANGED')continue;throw error;}
      if(job?.state!=='completed'||job.model!==model)continue;
      const frozen=path.join(candidate,'source.ogg');
      if(job.input!==frozen||job.originalSize!==original.sizeBytes||job.sourceSha256!==original.sha256)fail();
      const audio=sourceFileFingerprint(frozen,20*1024*1024);
      if(audio.sizeBytes!==original.sizeBytes||audio.sha256!==original.sha256)fail();
      const transcript=sourceJson(path.join(directory,'transcript.json'));
      if(transcript?.complete!==true||transcript.model!==model)fail();
      const bytes=readSourceBytes(path.join(directory,'transcript.txt'),24*1024*1024,{allowEmpty:true});
      try{
        new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        const text={sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
        if(selected&&(selected.text.sha256!==text.sha256||selected.text.sizeBytes!==text.sizeBytes))fail();
        if(!selected)selected={text,bytes:Buffer.from(bytes)};
      }finally{bytes.fill(0);}
    }
    // A matching old attempt without a verified terminal result is NOT a
    // cache miss. Its unknown/partial start must never become a new decoder.
    return selected??(matches?{pending:true}:null);
  }catch(error){selected?.bytes.fill(0);throw error;}
}

/** A cache hit publishes a NEW read result, never a fictional inference job.
 * The existing fsynced source claim is acquired before this copy. A crash with
 * no complete receipt stays unknown, and can never fall through to a decoder.
 * Text bytes are checked again on each read; no old grant/path is returned. */
function completedCopy(input,answer,model){
  const receiptPath=path.join(input.outputDirectory,'source-result.json');
  try{fs.lstatSync(receiptPath);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const receipt=sourceJson(receiptPath,8192);
  if(!exact(receipt,['schemaVersion','requestId','original','model','text'])||receipt.schemaVersion!==1
    ||receipt.requestId!==input.requestId||receipt.model!==model
    ||!exact(receipt.original,['sha256','sizeBytes'])||receipt.original.sha256!==input.original.sha256
    ||receipt.original.sizeBytes!==input.original.sizeBytes||!exact(receipt.text,['sha256','sizeBytes']))fail();
  const text=sourceFileFingerprint(path.join(input.outputDirectory,'transcript.txt'),24*1024*1024,{allowEmpty:true});
  if(text.sha256!==receipt.text.sha256||text.sizeBytes!==receipt.text.sizeBytes)fail();
  return {...answer,state:'completed',model,text};
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
  // An EXISTING attempt always keeps its own one-start/unknown fence. Only a
  // genuinely new source request may use completed derivations of these exact
  // freshly verified bytes; no existing job/claim is resumed or overwritten.
  let reused=null;
  try{fs.lstatSync(claimFile);}catch(error){
    if(error.code!=='ENOENT')throw error;
    reused=completedOriginal(parent,input.original,doctor.model);
  }
  if(reused?.pending)return {...answer,state:'unknown',code:'AUDIO_SOURCE_START_UNKNOWN'};
  let claimed=false;
  try{
    const fd=fs.openSync(claimFile,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(claim));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    claimed=true;
  }catch(error){reused?.bytes.fill(0);if(error.code!=='EEXIST')throw error;}
  let saved;
  try{saved=sourceJson(claimFile,8192);}catch(error){reused?.bytes.fill(0);throw error;}
  if(!exact(saved,['schemaVersion','requestId','original'])||saved.schemaVersion!==1||saved.requestId!==input.requestId
    ||!exact(saved.original,['filePath','sha256','sizeBytes'])
    ||['sha256','sizeBytes'].some(key=>saved.original[key]!==input.original[key])||typeof saved.original.filePath!=='string'){
    reused?.bytes.fill(0);fail();
  }
  if(claimed&&reused){
    try{
      const current=sourceFileFingerprint(input.original.filePath,20*1024*1024);
      if(current.sha256!==input.original.sha256||current.sizeBytes!==input.original.sizeBytes)fail();
      privateDirectory(input.outputDirectory);
      const fd=fs.openSync(path.join(input.outputDirectory,'transcript.txt'),'wx',0o600);
      try{fs.writeFileSync(fd,reused.bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      atomicJson(path.join(input.outputDirectory,'source-result.json'),{schemaVersion:1,requestId:input.requestId,
        original:{sha256:input.original.sha256,sizeBytes:input.original.sizeBytes},model:doctor.model,text:reused.text});
    }finally{reused.bytes.fill(0);}
  }else reused?.bytes.fill(0);
  const copied=completedCopy(input,answer,doctor.model);if(copied)return copied;
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
    let job;
    try{job=readSourceProgressJson(path.join(input.outputDirectory,'job.json'));}
    catch(error){
      if(error.code!=='AUDIO_SOURCE_SNAPSHOT_CHANGED')throw error;
      // No text/read success and no decoder restart: the next ordinary intake
      // read observes the SAME claimed job. Ownership/link/hash failures do
      // not enter this branch, nor do original or terminal transcript reads.
      return {...answer,state:'queued'};
    }
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
