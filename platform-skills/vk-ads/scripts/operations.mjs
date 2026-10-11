import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, data, hash, stable, scope, id, Fault } from './core.mjs';
import { safeApiErrorDetails } from './api.mjs';

const COMMON = ['name', 'status', 'date_start', 'date_end', 'budget_limit', 'budget_limit_day', 'autobidding_mode'];
const FIELDS = { plans: [...COMMON, 'objective', 'enable_utm', 'enable_offline_goals'],
  groups: [...COMMON, 'package_id', 'ad_plan_id', 'targetings', 'price', 'mixing', 'age_restrictions', 'uniq_shows_limit', 'uniq_shows_period', 'banner_uniq_shows_limit', 'enable_utm', 'objective'],
  banners: ['name', 'status', 'content', 'urls', 'textblocks'] };
function decimal(value) { return /^\d+(?:\.\d{1,2})?$/.test(String(value)) && Number(value) > 0 && Number(value) <= 100000000; }
function fields(entity, payload, create, dialect) {
  check(FIELDS[entity] && payload && !Array.isArray(payload), 'payload_invalid'); data(payload);
  const nested = entity === 'plans' ? dialect : entity === 'groups' ? 'banners' : null;
  const allowed = [...FIELDS[entity], ...(create && nested ? [nested] : [])];
  check(Object.keys(payload).length && Object.keys(payload).every(k => allowed.includes(k)), 'payload_field_forbidden');
  if (payload.name !== undefined) check(typeof payload.name === 'string' && payload.name.trim().length > 0 && payload.name.length <= 255, 'name_invalid');
  for (const key of ['budget_limit', 'budget_limit_day', 'price']) if (payload[key] !== undefined) check(decimal(payload[key]), 'budget_invalid');
  if (payload.status !== undefined) check(['active', 'blocked', 'deleted'].includes(payload.status), 'status_invalid');
  for (const key of ['date_start', 'date_end']) if (payload[key] !== undefined) check(/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(payload[key]) && !Number.isNaN(Date.parse(payload[key].replace(' ', 'T'))), 'date_invalid');
  if (payload.date_start && payload.date_end) check(payload.date_start <= payload.date_end, 'date_invalid');
  for (const key of ['package_id', 'ad_plan_id']) if (payload[key] !== undefined) id(payload[key]);
  if (create) {
    check(payload.status === undefined || payload.status === 'blocked', 'create_must_be_paused'); payload.status = 'blocked';
    if (entity !== 'banners') check(payload.name, 'name_required');
    if (entity === 'groups') { check(payload.package_id && payload.banners?.length, 'group_package_and_banners_required'); }
    if (payload[nested]) {
      check(Array.isArray(payload[nested]) && payload[nested].length > 0 && payload[nested].length <= 20, 'children_invalid');
      for (const child of payload[nested]) fields(entity === 'plans' ? 'groups' : 'banners', child, true, dialect);
    }
  }
  return payload;
}
export async function media(file, width, height) {
  check(path.isAbsolute(file) && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 20000 && height <= 20000, 'media_invalid');
  const stat = await fs.lstat(file); check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 100 * 1024 * 1024, 'media_invalid');
  const bytes = await fs.readFile(file); check(bytes.length === stat.size, 'media_changed');
  let type;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) type = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = 'image/jpeg';
  else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) type = 'image/gif';
  else if (bytes.subarray(4, 8).toString() === 'ftyp') type = 'video/mp4';
  check(type, 'media_format_unsupported');
  return { file, width, height, sha256: hash(bytes), size: bytes.length, type, bytes };
}
export async function prepare(api, specification) {
  check(specification && ['create', 'update', 'url', 'upload'].includes(specification.kind), 'operation_invalid');
  const op = structuredClone(specification);
  if (op.kind === 'url') {
    check(Object.keys(op).sort().join() === 'kind,url', 'payload_invalid');
    const url = new URL(op.url); check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && op.url.length <= 4096, 'advertised_url_invalid');
  } else if (op.kind === 'upload') {
    check(Object.keys(op).sort().join() === 'file,height,kind,width', 'payload_invalid');
    const checked = await media(op.file, op.width, op.height); delete checked.bytes; op.media = checked;
  } else {
    check(Object.keys(op).sort().join() === (op.kind === 'create' ? 'entity,kind,payload' : 'entity,id,kind,payload'), 'payload_invalid');
    check(op.kind !== 'create' || op.entity !== 'banners', 'banner_create_requires_new_group');
    fields(op.entity, op.payload, op.kind === 'create', api.auth.groups);
    if (op.kind === 'create' && op.entity === 'groups') check(op.payload.ad_plan_id, 'parent_plan_required');
    if (op.kind === 'update') { op.id = id(op.id); op.before = await api.get(op.entity, op.id, ['id', ...Object.keys(op.payload)]); }
  }
  return op;
}
// VK returns the same sex selection in either order. Limit normalization to
// this known enum set: duplicates, unknown values and all other arrays keep
// their exact representation, so this cannot hide a changed audience/creative.
function sexSet(value) {
  return Array.isArray(value) && value.length <= 2 && new Set(value).size === value.length && value.every(v => ['male', 'female'].includes(v));
}
function snapshot(value) {
  const copy = structuredClone(value);
  if (sexSet(copy?.targetings?.sex)) copy.targetings.sex = [...copy.targetings.sex].sort();
  // Compare the entire snapshot, including extra/missing keys and types. The
  // subset readback matcher is intentionally unsuitable for stale-state CAS.
  return stable(copy);
}
// Readback compares the requested semantic values. VK decimal budgets can be
// strings with trailing zeros; representation differences are not a mismatch.
export function matches(actual, expected, field = '', fieldPath = field) {
  if (expected && !Array.isArray(expected) && typeof expected === 'object') return actual && Object.entries(expected).every(([k, v]) => matches(actual[k], v, k, fieldPath ? `${fieldPath}.${k}` : k));
  if (Array.isArray(expected)) {
    if (fieldPath === 'targetings.sex' && sexSet(actual) && sexSet(expected)) return actual.length === expected.length && expected.every(v => actual.includes(v));
    return Array.isArray(actual) && stable(actual) === stable(expected);
  }
  if (typeof expected === 'number' || ['budget_limit', 'budget_limit_day', 'price', 'id', 'package_id', 'ad_plan_id'].includes(field)) {
    return ['number', 'string'].includes(typeof actual) && /^\d+(?:\.\d+)?$/.test(String(actual)) && Number(actual) === Number(expected);
  }
  return actual === expected;
}
function visible(plan) { return { planId: plan.id, planHash: plan.hash, expiresAt: new Date(plan.expires).toISOString(),
  account: plan.account, scope: plan.scope, operation: plan.op, approvalRequired: true }; }
export class Operations {
  constructor(store, api, now = Date.now) { this.store = store; this.api = api; this.now = now; }
  async plan(specification) {
    return this.store.lock(async () => {
      const state = await this.store.read(); check(state.credentials, 'setup_required');
      const retained = new Set(Object.values(state.operations).map(r => r.planId));
      state.plans = Object.fromEntries(Object.entries(state.plans).filter(([key, p]) => p.expires > this.now() || retained.has(key)));
      check(Object.keys(state.plans).filter(key => !retained.has(key)).length < 100, 'plan_store_full');
      const op = await prepare(this.api, specification), record = { id: crypto.randomUUID(), account: this.store.owner.account,
        scope: scope(this.store.owner), op, expires: this.now() + 30 * 60 * 1000 };
      record.hash = hash(stable(record)); state.plans[record.id] = record; await this.store.write(state); return visible(record);
    });
  }
  async apply(planId, planHash, operationId) {
    check(/^[a-zA-Z0-9_-]{8,100}$/.test(operationId), 'operation_id_invalid');
    return this.store.lock(async () => {
      const state = await this.store.read(), plan = state.plans[planId];
      check(plan && plan.hash === planHash && plan.scope === scope(this.store.owner), 'plan_scope_or_hash_invalid');
      const existing = state.operations[operationId];
      if (existing) { check(existing.hash === planHash, 'operation_id_conflict'); return existing; }
      check(plan.expires > this.now(), 'plan_expired');
      // A second id for the same plan cannot bypass an uncertain first request.
      const prior = Object.values(state.operations).find(r => r.hash === planHash);
      if (prior) return prior;
      check(!Object.values(state.operations).some(r => ['unknown', 'written_unverified'].includes(r.phase)), 'unresolved_write_blocks_new_mutation');
      check(Object.keys(state.operations).length < 1000, 'receipt_store_full');
      const { op } = plan;
      if (op.kind === 'update') {
        const current = await this.api.get(op.entity, op.id, ['id', ...Object.keys(op.payload)]);
        check(snapshot(current) === snapshot(op.before), 'object_changed_replan_required');
      }
      let upload;
      if (op.kind === 'upload') { upload = await media(op.file, op.width, op.height); check(upload.sha256 === op.media.sha256, 'media_changed'); }
      // Authentication is completed before the durable dispatch claim, so an
      // OAuth outage cannot be confused with an attempted advertising mutation.
      if (!this.api.access) await this.api.login();
      const receipt = { operationId, hash: planHash, scope: plan.scope, phase: 'unknown', dispatchedAt: new Date(this.now()).toISOString(), planId };
      state.operations[operationId] = receipt; await this.store.write(state);
      try {
        let response;
        if (op.kind === 'url') response = await this.api.request('POST', '/api/v2/urls.json', { body: { url: op.url } });
        else if (op.kind === 'upload') {
          const body = new FormData(); body.set('file', new Blob([upload.bytes], { type: upload.type }), `creative.${upload.type === 'video/mp4' ? 'mp4' : upload.type.split('/')[1]}`);
          body.set('data', JSON.stringify({ width: upload.width, height: upload.height }));
          response = await this.api.request('POST', `/api/v2/content/${upload.type === 'video/mp4' ? 'video' : 'static'}.json`, { body });
        } else response = await this.api.request('POST', this.api.endpoint(op.entity, op.kind === 'update' ? op.id : null), { body: op.payload });
        receipt.objectId = op.kind === 'update' ? op.id : id(response.id);
        receipt.response = response; receipt.phase = 'written_unverified'; await this.store.write(state);
        await this.verify(plan, receipt); await this.store.write(state); return receipt;
      } catch (error) {
        // Once dispatched, even a crash before response persistence leaves an
        // unknown receipt. A rejection can be terminal, but is never auto-retried.
        receipt.error = error instanceof Fault ? error.code : 'write_result_unknown';
        // Preserve the provider's safe reason alongside the replay fence. A
        // terminal 400 otherwise loses the fields needed to prepare a reviewed
        // correction; retaining it never authorizes another POST or fallback.
        const details = safeApiErrorDetails(error instanceof Fault ? error.details : {}, [this.api.auth.client_secret, this.api.access]);
        if (Object.keys(details).length) receipt.errorDetails = details;
        if (receipt.phase === 'unknown' && error instanceof Fault && ['api_rejected', 'api_method_unsupported', 'authorization_required', 'permission_denied'].includes(error.code)) receipt.phase = 'rejected';
        await this.store.write(state); return receipt;
      }
    });
  }
  async verify(plan, receipt) {
    const { op } = plan;
    if (op.kind === 'upload') { receipt.phase = 'uploaded_unverified'; receipt.nextAction = 'Verify this content ID through the created banner before activation'; return; }
    if (op.kind === 'url') {
      const current = await this.api.request('GET', `/api/v2/urls/${receipt.objectId}.json`);
      check(current.url === op.url, 'readback_mismatch'); receipt.phase = 'verified'; receipt.urlTypes = current.url_types || []; return;
    }
    const children = op.entity === 'plans' ? this.api.auth.groups : 'banners';
    const scalar = Object.fromEntries(Object.entries(op.payload).filter(([k]) => k !== children));
    const current = await this.api.get(op.entity, receipt.objectId, ['id', ...Object.keys(scalar)]);
    if (!matches(current, scalar)) {
      // Report only static field identities, never either compared value or a
      // nested advertising payload. This lets a retained receipt distinguish
      // an actual provider normalization from a missing field without exposing
      // credentials/content or weakening the unresolved-write fence.
      const allowed = new Set([...FIELDS[op.entity], 'ad_group_id', 'campaign_id']);
      const failed = Object.keys(scalar).filter(key => allowed.has(key) && !matches(current?.[key], scalar[key], key));
      throw new Fault('readback_mismatch', { fields: Object.fromEntries(failed.map(key => [`${op.entity}_${key}`, 'readback_mismatch'])) });
    }
    // Nested creation is not called fully verified merely because the parent
    // exists. Resolve and read every child only under its known created parent.
    if (op.kind === 'create' && op.payload[children]) {
      const childEntity = op.entity === 'plans' ? 'groups' : 'banners';
      const parentField = childEntity === 'groups' ? 'ad_plan_id' : this.api.auth.groups === 'ad_groups' ? 'ad_group_id' : 'campaign_id';
      let ids = receipt.response[children];
      // VK can label an ad_groups creation response as campaigns. This is a
      // response alias only: it must never switch the configured request API,
      // issue another POST, or override an explicit conflicting child list.
      if (op.entity === 'plans') {
        const alias = receipt.response[children === 'ad_groups' ? 'campaigns' : 'ad_groups'];
        check(ids === undefined || alias === undefined || stable(ids) === stable(alias), 'created_children_unverified');
        if (ids === undefined) ids = alias;
      }
      let listed = false;
      if (ids === undefined) {
        // The parent ID is known from the persisted write response. Discover
        // children only inside that exact new parent, never by a similar name
        // across the account. One extra row detects concurrent additions, and
        // truncated/incomplete lists cannot unlock the mutation fence.
        const page = await this.api.list(childEntity, { [`_${parentField}`]: receipt.objectId, fields: `id,${parentField}` }, op.payload[children].length + 1);
        check(!page.truncated && (page.count === null || page.count === page.items.length), 'created_children_unverified');
        ids = page.items; listed = true;
      }
      check(Array.isArray(ids) && ids.length === op.payload[children].length, 'created_children_unverified');
      check(new Set(ids.map(child => id(child.id))).size === ids.length, 'created_children_unverified');
      const available = [...ids];
      receipt.children = [];
      for (let i = 0; i < ids.length; i++) {
        const childOp = { kind: 'create', entity: childEntity, payload: { ...op.payload[children][i], [parentField]: receipt.objectId } };
        let child = ids[i];
        if (listed) {
          // Lists have no creation-order guarantee. Match the complete scalar
          // specification and parent relationship, not merely the name. An
          // ambiguous match stays unverified rather than guessing an ID.
          const nested = childEntity === 'groups' ? 'banners' : null;
          const expected = Object.fromEntries(Object.entries(childOp.payload).filter(([key]) => key !== nested));
          const candidates = [];
          for (const candidate of available) {
            check(matches(candidate[parentField], receipt.objectId, parentField), 'created_child_parent_mismatch');
            const observed = await this.api.get(childEntity, id(candidate.id), ['id', ...Object.keys(expected)]);
            if (matches(observed, expected)) candidates.push(candidate);
          }
          check(candidates.length === 1, 'created_children_unverified');
          child = candidates[0]; available.splice(available.indexOf(child), 1);
        }
        const childReceipt = { objectId: id(child.id), response: child };
        await this.verify({ op: childOp }, childReceipt);
        receipt.children.push({ entity: childEntity, objectId: childReceipt.objectId, ...(childReceipt.children ? { children: childReceipt.children } : {}) });
      }
    }
    receipt.phase = 'verified'; receipt.observed = current;
  }
  async reconcile(operationId) {
    return this.store.lock(async () => {
      const state = await this.store.read(), receipt = state.operations[operationId];
      check(receipt && receipt.scope === scope(this.store.owner), 'operation_not_found');
      if (['unknown', 'written_unverified'].includes(receipt.phase)) {
        const plan = state.plans[receipt.planId];
        // A lost create response has no trustworthy object ID. Do not guess a
        // similarly named object or turn absence in a list into permission to retry.
        if (!receipt.objectId && plan.op.kind !== 'update') return { ...receipt, nextAction: 'Find the result in VK manually; do not repeat this creation' };
        receipt.objectId ||= plan.op.id;
        try { await this.verify(plan, receipt); delete receipt.error; delete receipt.errorDetails; } catch (error) {
          receipt.error = error instanceof Fault ? error.code : 'readback_failed';
          const details = safeApiErrorDetails(error instanceof Fault ? error.details : {}, [this.api.auth.client_secret, this.api.access]);
          // A later readback failure supersedes the earlier diagnostic; do not
          // display a stale HTTP status when the latest error has no projection.
          delete receipt.errorDetails;
          if (Object.keys(details).length) receipt.errorDetails = details;
        }
        await this.store.write(state);
      }
      return receipt;
    });
  }
}
