/** Bound all model-visible content identically for CLI, MCP and file output.
 * Structural fields keep their meaning; truncation is explicit, strings are
 * Unicode-safe and prototype keys cannot be installed through seller specs. */
export function project(value: unknown): any {
  let remaining=96000, truncated=Boolean(value && typeof value === 'object' && (value as any).contentTruncated);
  const visit=(entry:any,key='',depth=0):any => {
    if (depth>8) {truncated=true;return null;}
    if (typeof entry==='string') {
      const limit=['description','fullDescription'].includes(key)?16000:2000;
      let result='';for(const point of entry) {
        const bytes=Buffer.byteLength(point);
        if(result.length+point.length>limit || bytes>remaining){truncated=true;break;}
        result+=point;remaining-=bytes;
      }return result;
    }
    if(Array.isArray(entry)){if(entry.length>1000)truncated=true;return entry.slice(0,1000).map(child=>visit(child,key,depth+1));}
    if(entry && typeof entry==='object') {
      const result:Record<string,unknown>=Object.create(null);
      for(const [name,child] of Object.entries(entry).slice(0,100)) {
        if(['__proto__','constructor','prototype'].includes(name))continue;
        result[name]=visit(child,name,depth+1);
      }return result;
    }
    return entry;
  };
  return {...visit(value),contentTruncated:truncated,untrustedContent:true,retrievedAt:new Date().toISOString()};
}
