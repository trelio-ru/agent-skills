#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identity, configRoot, check, Fault, VERSION, UUID, scope, childEnvironment, clean, id, hash, stable, credentials } from './core.mjs';
import { Store } from './storage.mjs';
import { Api } from './api.mjs';
import { AuthRecovery, assertAuthRecoveryIdle } from './auth-recovery.mjs';
import { input } from './form.mjs';
import { Operations } from './operations.mjs';
import { segments, audience, sources, counterGoals, placements, optimization, vkGroups } from './diagnostics.mjs';

export function argumentsOf(args) {
  const [command, ...rest] = args; const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    check(/^--[a-z-]+$/.test(rest[i]) && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') && !Object.hasOwn(flags, rest[i].slice(2)), 'arguments_invalid');
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  const allowed = { doctor: [], configure: [], reference: ['name'], 'setup-status': ['operation', 'wait-ms'],
    'auth-recovery-plan': [], 'auth-recovery-apply': ['plan', 'hash', 'operation', 'confirm'],
    'auth-recovery-status': ['operation'], 'auth-recovery-check': ['operation'],
    list: ['entity', 'parent', 'limit', 'status'], get: ['entity', 'id', 'fields'], catalog: ['name'],
    stats: ['entity', 'ids', 'from', 'to', 'family', 'period', 'metrics', 'attribution', 'conversion-type', 'breakdown'],
    audiences: ['id', 'limit'], sources: ['type', 'id', 'limit'], 'vk-groups': ['query', 'limit'], 'counter-goals': ['id'], placements: ['group'], optimization: ['group'],
    plan: ['file'], apply: ['plan', 'hash', 'operation'],
    receipt: ['operation'], reconcile: ['operation'], 'accept-unknown': ['operation', 'confirm'], reset: ['confirm'], 'recover-lock': ['confirm'], '__configure-worker': ['operation'],
    '__trelio_accounts_import': [] }[command];
  check(allowed && Object.keys(flags).every(k => allowed.includes(k)), 'command_invalid');
  return { command, flags };
}
export async function accountApi(store, initialCredentials, options = {}) {
  assertAuthRecoveryIdle(await store.read());
  let api = new Api(initialCredentials, options);
  if (api.access) return api;
  const expected = hash(stable(credentials(initialCredentials)));
  // Renewal changes remote token state, so acquire the same account lock
  // before OAuth IO, not only before saving its response. A competing caller
  // stays busy without issuing/refreshing another token. On its later retry,
  // reread the durable cache and reuse the winner's token. Reconfiguration or
  // pending setup must still block before any OAuth request.
  return store.lock(async () => {
    const current = await store.read();
    assertAuthRecoveryIdle(current);
    check(current.credentials && hash(stable(credentials(current.credentials))) === expected, 'credentials_changed');
    check(!current.setup || !['starting', 'waiting_input', 'checking'].includes(current.setup.phase), 'setup_already_pending');
    api = new Api(current.credentials, options);
    if (!api.access) {
      await api.login(); current.credentials = api.auth;
      await store.write(current);
    }
    return api;
  });
}
export async function configureWorker(store, operation, { prompt = input, makeApi = auth => new Api(auth) } = {}) {
  let value;
  try {
    await store.lock(async () => {
      const state = await store.read(); check(state.setup?.id === operation && state.setup.scope === scope(store.owner) && state.setup.expires > Date.now(), 'setup_scope_or_expiry_invalid');
      assertAuthRecoveryIdle(state);
      state.setup.pid = process.pid; state.setup.phase = 'waiting_input'; await store.write(state);
    });
    value = await prompt();
    await store.lock(async () => {
      const state = await store.read(); check(state.setup?.id === operation && state.setup.scope === scope(store.owner) && state.setup.expires > Date.now(), 'setup_scope_or_expiry_invalid');
      assertAuthRecoveryIdle(state);
      // Persist encrypted credentials even if the readiness probe is offline.
      // An explicit replacement retains the old value until submission succeeds.
      state.credentials = value;
      // Replacing a key invalidates unused plans, but never removes the source
      // of a dispatched receipt. Its evidence and replay fence must survive
      // both reset and reconfiguration of the same local account.
      state.plans = Object.fromEntries(Object.entries(state.plans).filter(([key]) => Object.values(state.operations).some(r => r.planId === key)));
      state.setup.phase = 'checking'; await store.write(state);
      // Save the privately returned grant before the first readiness GET.
      // Otherwise a denied/offline probe would lose a successfully issued
      // refresh token and consume another issuance on the next working call.
      const api = makeApi(value); await api.login(); state.credentials = api.auth; await store.write(state);
      await api.list('plans', {}, 1); await api.list('groups', {}, 1);
      state.setup.phase = 'ready'; await store.write(state);
    });
  } catch (error) {
    await store.lock(async () => {
      const state = await store.read(); if (state.setup?.id !== operation || state.setup.scope !== scope(store.owner)) return;
      state.setup.phase = error.code === 'user_cancelled' ? 'cancelled' : 'failed';
      state.setup.error = error instanceof Fault ? error.code : 'setup_failed'; await store.write(state);
    });
  } finally { value = null; store.close(); }
}
export async function setupStatus(store, operation, wait = 0) {
  check(UUID.test(operation || '') && Number.isInteger(wait) && wait >= 0 && wait <= 30000, 'setup_status_invalid');
  const started = Date.now(); let initialPhase;
  for (;;) {
    const state = await store.read(), setup = state.setup;
    check(setup?.id === operation && setup.scope === scope(store.owner), 'setup_not_found');
    const result = { operationId: setup.id, phase: setup.phase, expiresAt: new Date(setup.expires).toISOString(), ...(setup.error ? { error: setup.error } : {}) };
    if (!['starting', 'waiting_input', 'checking'].includes(setup.phase)) return result;
    if (Date.now() >= setup.expires) return { ...result, phase: 'expired' };
    if (setup.pid) { try { process.kill(setup.pid, 0); } catch (error) { if (error.code === 'ESRCH') return { ...result, phase: 'process_lost' }; throw new Fault('process_status_unavailable'); } }
    initialPhase ||= setup.phase;
    if (setup.phase !== initialPhase || Date.now() - started >= wait) return { ...result,
      requiredAction: setup.phase === 'checking' ? 'Wait for the API readiness check' : 'Complete the local input form',
      continuation: { command: 'setup-status', operation, waitMs: 30000 } };
    await new Promise(r => setTimeout(r, Math.min(250, wait - (Date.now() - started))));
  }
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const { command, flags } = argumentsOf(args);
  // No historical credentials exist for a new provider. Host metadata import
  // must not open Keychain, DPAPI, files or a provider connection.
  if (command === '__trelio_accounts_import') return { schemaVersion: 1, accounts: [] };
  const owner = identity(env);
  if (command === 'reference') {
    check(['workflow', 'security', 'diagnostics', 'audience-management', 'status-recovery', 'auth-recovery'].includes(flags.name), 'reference_invalid');
    return { markdown: await fs.readFile(new URL(`../references/${flags.name}.md`, import.meta.url), 'utf8') };
  }
  const store = new Store(configRoot(env), owner);
  try {
    await store.init();
    // Recovery planning/status does not call accountApi: issuing a token just
    // to prepare a plan would consume the very quota this flow must repair.
    const recovery = new AuthRecovery(store);
    if (command === 'auth-recovery-plan') return await recovery.plan();
    if (command === 'auth-recovery-apply') return await recovery.apply(flags.plan, flags.hash, flags.operation, flags.confirm);
    if (command === 'auth-recovery-status') return await recovery.status(flags.operation);
    if (command === 'auth-recovery-check') return await recovery.check(flags.operation);
    if (command === '__configure-worker') {
      check(UUID.test(flags.operation || ''), 'setup_not_found');
      // The parent persists the child PID and releases the setup lock before
      // sending this private start signal. No scheduler race can open two forms
      // or misreport a child which failed to acquire the initial account lock.
      let signal = ''; const timer = setTimeout(() => process.stdin.destroy(), 10000);
      try { for await (const chunk of process.stdin) { signal += chunk.toString(); check(signal.length <= 2, 'setup_start_invalid'); } }
      finally { clearTimeout(timer); }
      check(signal === 'go', 'setup_start_invalid');
      await configureWorker(store, flags.operation); return { phase: 'finished' };
    }
    if (command === 'recover-lock') { check(flags.confirm === 'recover-dead-process', 'confirmation_required'); return await store.recoverLock(); }
    if (command === 'setup-status') return await setupStatus(store, flags.operation, Number(flags['wait-ms'] || 0));
    if (command === 'configure') {
      const operation = crypto.randomUUID();
      await store.lock(async () => {
        const state = await store.read();
        assertAuthRecoveryIdle(state);
        check(!state.setup || !['starting', 'waiting_input', 'checking'].includes(state.setup.phase) || state.setup.expires <= Date.now(), 'setup_already_pending');
        check(!Object.values(state.operations).some(r => ['unknown', 'written_unverified'].includes(r.phase)), 'unresolved_write_blocks_reconfigure');
        state.setup = { id: operation, scope: scope(owner), phase: 'starting', expires: Date.now() + 5 * 60 * 1000 }; await store.write(state);
      });
      const childEnv = { ...childEnvironment(env), ...Object.fromEntries(['TRELIO_SKILL_ID', 'TRELIO_SKILL_COMPANY_ID', 'TRELIO_SKILL_MEMBER_ID', 'TRELIO_SKILL_ACCOUNT_JSON', 'TRELIO_CONFIG_HOME'].filter(k => env[k]).map(k => [k, env[k]])) };
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__configure-worker', '--operation', operation],
        { shell: false, detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: childEnv });
      try {
        await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); });
        await store.lock(async () => { const state = await store.read(); check(state.setup?.id === operation, 'setup_not_found'); state.setup.pid = child.pid; await store.write(state); });
        child.stdin.end('go'); child.unref();
      } catch { child.kill(); throw new Fault('setup_process_start_failed'); }
      return await setupStatus(store, operation);
    }
    if (command === 'reset') {
      check(flags.confirm === 'delete-local-credentials', 'confirmation_required');
      return await store.lock(async () => {
        const state = await store.read(); assertAuthRecoveryIdle(state); check(!state.setup || !['starting', 'waiting_input', 'checking'].includes(state.setup.phase), 'setup_already_pending');
        // Reset credentials, not receipts: deleting an unknown write history
        // would make resetting a way to duplicate an advertising mutation.
        state.credentials = null; state.plans = Object.fromEntries(Object.entries(state.plans).filter(([key]) => Object.values(state.operations).some(r => r.planId === key)));
        await store.write(state); return { configured: false, remoteCredentialRevoked: false, receiptsPreserved: true };
      });
    }
    const state = await store.read();
    if (command === 'receipt') { const receipt = state.operations[flags.operation]; check(receipt?.scope === scope(owner), 'operation_not_found'); return receipt; }
    if (command === 'accept-unknown') {
      check(flags.confirm === 'keep-result-without-replay', 'confirmation_required');
      return await store.lock(async () => {
        const latest = await store.read(), receipt = latest.operations[flags.operation];
        check(receipt?.scope === scope(owner) && ['unknown', 'written_unverified'].includes(receipt.phase), 'operation_not_found');
        receipt.phase = 'accepted_unknown'; receipt.humanAcceptedUnverifiedResult = true; await store.write(latest); return receipt;
      });
    }
    assertAuthRecoveryIdle(state);
    if (!state.credentials) return { availability: 'setup_required', runtimeVersion: VERSION, requiredAction: 'Create/select a local account, then configure' };
    check(!state.setup || !['starting', 'waiting_input', 'checking'].includes(state.setup.phase), 'setup_already_pending');
    const api = await accountApi(store, state.credentials), ops = new Operations(store, api);
    if (command === 'doctor') {
      await api.list('plans', {}, 1); await api.list('groups', {}, 1);
      return { availability: 'ready', runtimeVersion: VERSION, account: owner.account, groupResource: state.credentials.groups };
    }
    if (command === 'list') {
      const query = {};
      if (flags.parent) { check(['groups', 'banners'].includes(flags.entity), 'parent_invalid'); query[flags.entity === 'groups' ? '_ad_plan_id' : `_${state.credentials.groups === 'ad_groups' ? 'ad_group_id' : 'campaign_id'}`] = id(flags.parent); }
      if (flags.status) { check(['active', 'blocked', 'deleted'].includes(flags.status), 'status_invalid'); query._status = flags.status; }
      return api.list(flags.entity, query, Number(flags.limit || 1000));
    }
    if (command === 'get') {
      const fields = flags.fields?.split(','); check(!fields || fields.length <= 30 && fields.every(k => /^[a-z][a-z0-9_]{0,80}$/.test(k)), 'fields_invalid');
      return api.get(flags.entity, flags.id, fields);
    }
    if (command === 'catalog') return api.catalog(flags.name);
    if (command === 'audiences') return flags.id ? audience(api, flags.id) : segments(api, Number(flags.limit || 500));
    if (command === 'sources') return sources(api, flags.type, flags.id, Number(flags.limit || 500));
    if (command === 'vk-groups') return vkGroups(api, flags.query, Number(flags.limit || 500));
    if (command === 'counter-goals') return counterGoals(api, flags.id);
    if (command === 'placements') return placements(api, flags.group);
    if (command === 'optimization') return optimization(api, flags.group);
    if (command === 'stats') return api.stats(flags.entity, (flags.ids || '').split(','), flags.from, flags.to,
      { family: flags.family, period: flags.period, metrics: flags.metrics, attribution: flags.attribution,
        conversionType: flags['conversion-type'], breakdown: flags.breakdown });
    if (command === 'plan') {
      check(path.isAbsolute(flags.file || ''), 'plan_file_invalid'); const stat = await fs.lstat(flags.file);
      check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 200000, 'plan_file_invalid');
      let specification; try { specification = JSON.parse(await fs.readFile(flags.file, 'utf8')); } catch { throw new Fault('plan_file_invalid'); }
      return await ops.plan(specification);
    }
    if (command === 'apply') return await ops.apply(flags.plan, flags.hash, flags.operation);
    if (command === 'reconcile') return await ops.reconcile(flags.operation);
    throw new Fault('command_invalid');
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try { const result = await main(); const output = JSON.stringify(clean(result)); check(Buffer.byteLength(output) <= 512000, 'output_too_large'); process.stdout.write(`${output}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ error: error instanceof Fault ? error.code : 'runtime_failed', ...(error instanceof Fault ? error.details : {}) })}\n`); process.exitCode = 1; }
}
