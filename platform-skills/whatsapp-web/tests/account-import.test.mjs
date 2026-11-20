import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnvironment, identityFromEnv, identityKey, storageDirectory } from '../scripts/core.mjs';

const company = '10000000-0000-4000-8000-000000000001';
const member = '10000000-0000-4000-8000-000000000002';
const connection = '10000000-0000-4000-8000-000000000003';
const accountId = '10000000-0000-4000-8000-000000000004';
const oldCompany = '10000000-0000-4000-8000-000000000005';
const entrypoint = fileURLToPath(new URL('../scripts/trelio-whatsapp.mjs', import.meta.url));
const importCommand = ['__trelio_accounts_import'];
const environment = { ...childEnvironment(), TRELIO_SKILL_ID: 'whatsapp-web',
  TRELIO_SKILL_COMPANY_ID: company, TRELIO_SKILL_MEMBER_ID: member };
const binding = providerRef => JSON.stringify({ id: accountId, providerRef, companyBinding: 'a'.repeat(64) });
const nativePlatform = ['darwin', 'win32'].includes(process.platform);

function cli(args, overrides = {}, error = undefined) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    env: { ...environment, ...overrides }, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  assert.ifError(result.error);
  if (error) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, error);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

async function temporaryRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wa-account-import-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

test('the real importer returns an empty legacy inventory before reading storage when the host supplies no connection', () => {
  // An invalid storage root proves that the no-legacy branch never opens it.
  const cold = { TRELIO_CONFIG_HOME: 'must-not-be-resolved' };
  assert.deepEqual(cli(importCommand, cold), { schemaVersion: 1, accounts: [] });
  cli(importCommand, { ...cold, TRELIO_SKILL_COMPANY_ID: '' }, 'host_identity_required');
  cli(importCommand, { ...cold, TRELIO_SKILL_CONNECTION_ID: '' }, 'host_connection_required');
  cli(importCommand, { ...cold, TRELIO_SKILL_CONNECTION_ID: 'bad-id' }, 'host_connection_required');
  cli(importCommand, { ...cold, TRELIO_SKILL_ACCOUNT_JSON: binding(null) }, 'account_import_context_invalid');
  cli(['doctor'], cold, 'host_connection_required');
});

test('the real importer keeps the exact legacy namespace and rejects unsafe storage', { skip: !nativePlatform }, async t => {
  const root = await temporaryRoot(t);
  const legacy = { TRELIO_CONFIG_HOME: root, TRELIO_SKILL_CONNECTION_ID: connection };
  const identity = identityFromEnv({ ...environment, ...legacy });
  const directory = storageDirectory(root, identity);
  assert.deepEqual(cli(importCommand, legacy), { schemaVersion: 1, accounts: [] });
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.writeFile(directory, 'not a directory');
  cli(importCommand, legacy, 'unsafe_storage');
  await fs.unlink(directory);
  await fs.mkdir(directory);
  const result = cli(importCommand, legacy);
  assert.deepEqual(result, { schemaVersion: 1, accounts: [{ sourceKey: connection, scope: 'company',
    name: 'Основной аккаунт', comment: '', providerRef: JSON.stringify(identity) }] });
});

test('a selected new or imported account reaches the provider doctor without a legacy config', { skip: !nativePlatform }, async t => {
  const root = await temporaryRoot(t);
  const oldIdentity = { skill: 'whatsapp-web', company: oldCompany, member, connection };
  for (const reference of [null, JSON.stringify(oldIdentity)]) {
    const selected = { TRELIO_CONFIG_HOME: root, TRELIO_SKILL_ACCOUNT_JSON: binding(reference) };
    const identity = identityFromEnv({ ...environment, ...selected });
    assert.equal(identity.company, company);
    assert.equal(identity.connection, null);
    const directory = storageDirectory(root, identity);
    assert.equal(directory, reference ? storageDirectory(root, oldIdentity)
      : path.join(root, 'integrations', 'whatsapp-web', 'accounts', accountId));
    if (reference) assert.equal(identityKey(identity), identityKey(oldIdentity));
    // Browser doctor reaches the native account directory without touching a
    // Keychain key, opening a browser, or starting a WhatsApp session.
    const receipt = cli(['doctor', '--mode', 'browser'], selected);
    assert.equal(receipt.mode, 'browser');
    assert.equal(receipt.leaseActive, false);
    assert.equal((await fs.stat(directory)).isDirectory(), true);
    cli(['doctor', '--mode', 'browser'], { ...selected, TRELIO_SKILL_CONNECTION_ID: 'bad-id' },
      'host_connection_required');
    cli(['doctor', '--mode', 'browser'], { ...selected, TRELIO_SKILL_CONNECTION_CONFIG_JSON: '{' },
      'host_connection_config_required');
  }
  cli(['doctor', '--mode', 'browser'], { TRELIO_CONFIG_HOME: root, TRELIO_SKILL_CONNECTION_ID: connection },
    'host_connection_config_required');
  cli(['doctor', '--mode', 'browser'], { TRELIO_CONFIG_HOME: root, TRELIO_SKILL_ACCOUNT_JSON: binding('{}') },
    'account_reference_invalid');
});
