import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as whatsapp from '../whatsapp-web/scripts/core.mjs';
import * as gosuslugi from '../gosuslugi/scripts/core.mjs';
import * as max from '../max-web/scripts/trelio-max.mjs';
import * as telegram from '../telegram-web/scripts/trelio-telegram-web.mjs';

const company = crypto.randomUUID(), member = crypto.randomUUID(), connection = crypto.randomUUID();
const account = { id: crypto.randomUUID(), providerRef: null, companyBinding: 'a'.repeat(64), name: 'Личный', comment: 'Обычные сообщения' };

for (const provider of [whatsapp, gosuslugi]) {
  test(`${provider.SKILL}: registration preserves the old encryption identity; new accounts and company binding are independent`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-provider-account-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const env = { TRELIO_SKILL_ID: provider.SKILL, TRELIO_SKILL_COMPANY_ID: company,
      TRELIO_SKILL_MEMBER_ID: member, ...(provider.SKILL === "whatsapp-web" ? { TRELIO_SKILL_CONNECTION_ID: connection } : {}) };
    const original = provider.identityFromEnv(env);
    const originalPath = provider.storageDirectory(root, original), key = provider.identityKey(original);
    const imported = provider.identityFromEnv({ ...env, TRELIO_SKILL_COMPANY_ID: crypto.randomUUID(),
      TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ ...account, providerRef: JSON.stringify(original) }) });
    assert.equal(provider.storageDirectory(root, imported), originalPath);
    assert.equal(provider.identityKey(imported), key, 'AES AAD and OS credential key stay byte-identical');
    assert.notEqual(imported.company, original.company, 'live ACL identity must not be replaced by the storage owner');
    const fresh = provider.identityFromEnv({ ...env, TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify(account) });
    assert.notEqual(provider.identityKey(fresh), key);
    assert.equal(provider.storageDirectory(root, fresh), path.join(root, 'integrations', provider.SKILL, 'accounts', account.id));
    const otherCompany = provider.identityFromEnv({ ...env, TRELIO_SKILL_COMPANY_ID: crypto.randomUUID(),
      TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ ...account, name: 'Переименован', companyBinding: 'b'.repeat(64) }) });
    assert.equal(provider.identityKey(otherCompany), provider.identityKey(fresh));
    assert.throws(() => provider.identityFromEnv({ ...env, TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ ...account, id: '../escape' }) }));
  });
}

for (const [skill, provider] of [['max-web', max], ['telegram-web', telegram]]) {
  test(`${skill}: imported browser profile survives reuse; approval hashes cannot cross account/company`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-browser-account-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const originalEnv = { ...process.env };
    t.after(() => { for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv); });
    Object.assign(process.env, { TRELIO_CONFIG_HOME: root, XDG_CONFIG_HOME: root, TRELIO_SKILL_ID: skill, TRELIO_SKILL_RUNTIME_VERSION: "9.0.0",
      TRELIO_SKILL_COMPANY_ID: company, TRELIO_SKILL_MEMBER_ID: member, TRELIO_SKILL_CONNECTION_ID: connection });
    delete process.env.TRELIO_SKILL_ACCOUNT_JSON;
    const old = provider.parseArguments(['delete', '--chat', 'Тест', '--message-id', '1', '--dry-run']);
    const selected = { ...old, account: { ...account, providerRef: JSON.stringify({ companyId: company, memberId: member, connectionId: connection }) } };
    assert.equal(provider.connectionRoot(selected), provider.connectionRoot(old));
    assert.equal(provider.connectionRoot({ ...selected, companyId: crypto.randomUUID() }), provider.connectionRoot(old));
    assert.notEqual(provider.connectionRoot({ ...selected, account }), provider.connectionRoot(old));
    const hash = provider.buildMutationPreview(selected).approvalHash;
    assert.notEqual(provider.buildMutationPreview({ ...selected, account: { ...selected.account, id: crypto.randomUUID() } }).approvalHash, hash);
    assert.notEqual(provider.buildMutationPreview({ ...selected, account: { ...selected.account, companyBinding: 'b'.repeat(64) } }).approvalHash, hash);
    // Exercise the actual persisted session reader, not only the hash builder.
    // A bound account shares login state, never a live worker's control token.
    const state = path.join(provider.connectionRoot(selected), 'state');
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    const sessionFile = path.join(state, 'assist-session.json');
    const record = { schemaVersion: 1, sessionId: crypto.randomUUID(), pid: process.pid,
      companyBinding: selected.account.companyBinding, token: 'synthetic-private-control' };
    await fs.writeFile(sessionFile, JSON.stringify(record), { mode: 0o600 });
    assert.equal(provider.readAssistSession(selected).sessionId, record.sessionId);
    const elsewhere = { ...selected, companyId: crypto.randomUUID(),
      account: { ...selected.account, companyBinding: 'b'.repeat(64) } };
    assert.throws(() => provider.readAssistSession(elsewhere), { code: 'ACCOUNT_SESSION_SCOPE_CONFLICT' });
    await fs.writeFile(sessionFile, JSON.stringify({ ...record, pid: 2147483647 }));
    assert.equal(provider.readAssistSession(elsewhere), null, 'finished records from another company are not returned');
    await fs.writeFile(sessionFile, JSON.stringify({ ...record, companyBinding: null }));
    assert.equal(provider.readAssistSession(selected).sessionId, record.sessionId, 'legacy owner keeps its existing session');
    assert.throws(() => provider.readAssistSession(elsewhere), { code: 'ACCOUNT_SESSION_SCOPE_CONFLICT' });
  });
}
