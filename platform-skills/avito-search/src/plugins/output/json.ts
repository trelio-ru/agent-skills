/** Ascard JSON export, with bounded data and atomic owner-only output.
 * A requested filename is a destination, never executable code. We reject
 * symlink targets and propagate write errors rather than claiming success. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {SearchResult,ItemDetails} from '../../core/types.js';
import {project} from '../../projection.js';
export class JsonOutput {
  async saveResults(results:SearchResult[],filename:string):Promise<void> {await this.save({count:results.length,results},filename);}
  async saveDetails(details:ItemDetails,filename:string):Promise<void> {await this.save({details},filename);}
  async save(data:unknown,filename:string):Promise<void> {
    const target=path.resolve(filename),directory=path.dirname(target);
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    try {if((await fs.lstat(target)).isSymbolicLink())throw new Error('unsafe_output');}
    catch(error:any){if(error.code!=='ENOENT')throw error;}
    const temporary=path.join(directory,'.avito-'+randomUUID()+'.tmp');
    try {await fs.writeFile(temporary,JSON.stringify(project({timestamp:new Date().toISOString(),...(data as object)}),null,2)+'\n',{mode:0o600,flag:'wx'});await fs.rename(temporary,target);}
    finally {await fs.rm(temporary,{force:true});}
  }
}
