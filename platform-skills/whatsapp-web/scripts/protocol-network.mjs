import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const HOST = 'web.whatsapp.com';
const RESOLVERS = ['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query'];
const privateAddresses = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) privateAddresses.addSubnet(address,prefix,'ipv4');
const publicAddress = value => typeof value === 'string' && net.isIP(value) === 4 && !privateAddresses.check(value,'ipv4');
const providerName = value => typeof value === 'string' && value.length <= 253 &&
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*whatsapp\.(?:com|net)\.?$/i.test(value);
const canonical = name => name.toLowerCase().replace(/\.$/, '');
const failure = () => Object.assign(new Error('dns_fallback_unavailable'), { code: 'ENOTFOUND' });

// Resolve only the fixed protocol endpoint, never a name taken from a message,
// attachment or user input. Unrelated Answer rows cannot redirect this lookup;
// only an explicit bounded provider CNAME chain can supply its public A record.
export function dnsAnswer(value) {
  if (value?.Status !== 0 || value.TC === true || value.CD === true ||
      !Array.isArray(value.Question) || value.Question.length !== 1 ||
      typeof value.Question[0]?.name !== 'string' || canonical(value.Question[0].name) !== HOST || value.Question[0]?.type !== 1 ||
      !Array.isArray(value.Answer) || value.Answer.length > 32) throw failure();
  let name = HOST;
  for (let depth = 0; depth < 8; depth++) {
    const records = value.Answer.filter(row => typeof row?.name === 'string' && canonical(row.name) === name);
    const addresses = records.filter(row => row.type === 1);
    if (addresses.length) {
      if (addresses.some(row => !publicAddress(row.data) || !Number.isSafeInteger(row.TTL) || row.TTL < 0 || row.TTL > 2147483647)) throw failure();
      return { addresses: [...new Set(addresses.map(row => row.data))], ttlMs: Math.min(60000, ...addresses.map(row => row.TTL * 1000)) };
    }
    const aliases = records.filter(row => row.type === 5);
    if (aliases.length !== 1 || !providerName(aliases[0].data)) throw failure();
    name = canonical(aliases[0].data);
  }
  throw failure();
}

// These credential-free HTTPS reads use the normal system resolver for the
// resolver's OWN name. Redirects, unbounded bodies, ambient proxy credentials
// and a global DNS override are deliberately absent. One attempt per resolver,
// within the existing connection/native deadline; no provider operation replay.
export function readDnsJson(endpoint, { signal, request = https.get } = {}) {
  if (!RESOLVERS.includes(endpoint)) return Promise.reject(failure());
  return new Promise((resolve,reject) => {
    const url = new URL(endpoint); url.searchParams.set('name',HOST); url.searchParams.set('type','A');
    url.searchParams.set('edns_client_subnet','0.0.0.0/0');
    const req = request(url, { signal, timeout: 2500, headers: { accept:'application/dns-json' } }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(failure()); return; }
      const chunks=[]; let bytes=0;
      response.on('error',()=>reject(failure())); response.on('aborted',()=>reject(failure()));
      response.on('data',chunk => {
        bytes += chunk.length;
        if (bytes > 16384) { response.destroy(); reject(failure()); return; }
        chunks.push(chunk);
      });
      response.on('end',()=> { try { resolve(dnsAnswer(JSON.parse(Buffer.concat(chunks).toString('utf8')))); } catch { reject(failure()); } });
    });
    req.on('timeout',()=>req.destroy(failure())); req.on('error',()=>reject(failure()));
  });
}

export function createProtocolNetwork({ permit, onDiagnostic = () => {}, lookup = dns.lookup,
  query = readDnsJson, now = Date.now } = {}) {
  let stopped=false, cache=null, pending=null;
  const controller = new AbortController();
  const report = state => onDiagnostic({ strategy:'system_then_https', state });
  async function resolveFallback() {
    if (cache && cache.expiresAt > now()) { report('https_cache'); return cache.addresses; }
    if (pending) return pending;
    pending = (async () => {
      await permit(); if (stopped) throw failure();
      report('https_resolving');
      // Absolute timer also bounds a peer that trickles bytes past socket timeout.
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]);
      for (const endpoint of RESOLVERS) {
        try {
          const result = await query(endpoint,{signal});
          await permit(); if (stopped || signal.aborted) throw failure();
          cache = { ...result, expiresAt: now()+result.ttlMs };
          report('https_resolved'); return result.addresses;
        } catch { if (stopped || signal.aborted) break; }
      }
      report('https_failed'); throw failure();
    })();
    try { return await pending; } finally { pending=null; }
  }
  const agent = new https.Agent({ lookup(host, options, callback) {
    lookup(host,options,(error,address,family) => {
      if (stopped) { callback(failure()); return; }
      if (!error) { if (host===HOST) report('system_resolved'); callback(null,address,family); return; }
      // Recover a DNS lookup only. TLS, HTTP refusal, socket timeout/reset,
      // auth errors and explicit IPv6-only lookups keep their original result.
      if (stopped || host!==HOST || !['ENOTFOUND','EAI_AGAIN'].includes(error.code) || (typeof options==='number'?options:options?.family)===6) {
        callback(error); return;
      }
      report('system_failed');
      resolveFallback().then(addresses => options?.all
        ? callback(null,addresses.map(address=>({address,family:4}))) : callback(null,addresses[0],4),()=>callback(error));
    });
  } });
  // An Agent changes name lookup only: the WebSocket URL, Host, TLS SNI and
  // certificate verification remain web.whatsapp.com. Never set rejectUnauthorized
  // false or send the authenticated socket to a raw-IP URL.
  return { agent, close() { stopped=true; controller.abort(); cache=null; agent.destroy(); } };
}
