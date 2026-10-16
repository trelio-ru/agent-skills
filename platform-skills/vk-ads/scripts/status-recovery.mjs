import { check, data, date, hash, id, stable } from './core.mjs';

// This is a new, explicitly authorized desired-state command, never an HTTP
// retry loop. Only the documented status setter of an existing ad_plan is
// eligible. Creation, deletion, budgets and every other setter stay fenced.
const OPERATION = /^[a-zA-Z0-9_-]{8,100}$/;
const PARENT_FIELDS = ['id', 'name', 'status', 'updated', 'objective', 'autobidding_mode', 'budget_limit', 'budget_limit_day', 'date_start', 'date_end', 'priced_goal'];
const GROUP_FIELDS = ['id', 'name', 'status', 'updated', 'ad_plan_id', 'package_id', 'autobidding_mode', 'budget_limit', 'budget_limit_day', 'date_start', 'date_end', 'targetings', 'price', 'age_restrictions', 'mixing', 'uniq_shows_limit', 'uniq_shows_period', 'banner_uniq_shows_limit', 'enable_utm', 'utm', 'priced_goal'];
const BANNER_FIELDS = ['id', 'name', 'status', 'updated', 'ad_group_id', 'content', 'urls', 'textblocks', 'moderation_status', 'ord_marker'];
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const unresolved = value => ['unknown', 'written_unverified'].includes(value?.phase);
const project = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
function creativeSection(value, fields) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 100, 'status_recovery_tree_incomplete');
  // Read objects contain generated variants, CDN URLs and analysis metadata.
  // A status setter must retain exact asset/landing IDs and approved text,
  // not mistake a changing derivative URL for an edit or export raw objects.
  return Object.fromEntries(Object.entries(value).map(([role, item]) => {
    check(item && typeof item === 'object' && !Array.isArray(item), 'status_recovery_tree_incomplete');
    const selected = project(item, fields);
    if (fields.includes('id')) id(selected.id);
    else check(typeof selected.text === 'string', 'status_recovery_tree_incomplete');
    if (fields.includes('url')) check(typeof selected.url === 'string' && selected.url.length > 0, 'status_recovery_tree_incomplete');
    return [role, selected];
  }));
}
function cents(value) {
  check(['string', 'number'].includes(typeof value) && /^\d+(?:\.\d{1,2})?$/.test(String(value)), 'status_recovery_budget_invalid');
  const amount = Math.round(Number(value) * 100);
  check(Number.isSafeInteger(amount) && amount > 0 && amount <= 10000000000, 'status_recovery_budget_invalid');
  return amount;
}
function guardOf(value, now) {
  check(exactKeys(value, ['endDate', 'maximumTotalBudget', 'maximumDailyBudget', 'groups']), 'status_recovery_guard_invalid');
  date(value.endDate);
  // A date-only end on the current day has account-timezone ambiguity. This
  // recovery path is deliberately narrower than the ordinary status setter.
  check(value.endDate > new Date(now).toISOString().slice(0, 10), 'status_recovery_period_invalid');
  cents(value.maximumTotalBudget); cents(value.maximumDailyBudget);
  check(Array.isArray(value.groups) && value.groups.length > 0 && value.groups.length <= 20, 'status_recovery_guard_invalid');
  const seenGroups = new Set(), seenBanners = new Set();
  for (const group of value.groups) {
    check(exactKeys(group, ['id', 'status', 'budgetLimit', 'budgetLimitDay', 'banners']), 'status_recovery_guard_invalid');
    const groupId = id(group.id); check(!seenGroups.has(groupId), 'status_recovery_guard_invalid'); seenGroups.add(groupId);
    check(['active', 'blocked'].includes(group.status), 'status_recovery_guard_invalid');
    cents(group.budgetLimit); cents(group.budgetLimitDay);
    check(Array.isArray(group.banners) && group.banners.length > 0 && group.banners.length <= 20, 'status_recovery_guard_invalid');
    for (const banner of group.banners) {
      check(exactKeys(banner, ['id', 'status']), 'status_recovery_guard_invalid');
      const bannerId = id(banner.id); check(!seenBanners.has(bannerId), 'status_recovery_guard_invalid'); seenBanners.add(bannerId);
      check(['active', 'blocked'].includes(banner.status), 'status_recovery_guard_invalid');
    }
  }
  check(value.groups.some(g => g.status === 'active' && g.banners.some(b => b.status === 'active')), 'status_recovery_no_active_path');
  return structuredClone(value);
}

export function recoverySource(state, op, scope, { executingOperation } = {}) {
  const receipt = state.operations[op.originalOperationId], plan = state.plans[receipt?.planId], old = plan?.op;
  check(receipt && plan && receipt.operationId === op.originalOperationId && receipt.scope === scope && plan.scope === scope && receipt.hash === plan.hash &&
    typeof receipt.dispatchedAt === 'string' && Number.isFinite(Date.parse(receipt.dispatchedAt)), 'status_recovery_source_invalid');
  if (Object.hasOwn(receipt, 'objectId')) check(id(receipt.objectId) === id(op.id), 'status_recovery_source_invalid');
  check(old?.kind === 'update' && old.entity === 'plans' && exactKeys(old.payload, ['status']) && old.payload.status === 'active' &&
    id(old.id) === id(op.id) && old.before?.status === 'blocked' && id(old.before?.id) === id(op.id), 'status_recovery_source_invalid');
  const resolvedSameAttempt = executingOperation && receipt.phase === 'resolved_by_status_recovery' &&
    receipt.resolution?.operationId === executingOperation && receipt.resolution.currentStateVerified === true;
  check(receipt.phase === 'unknown' || executingOperation && receipt.phase === 'verified' || resolvedSameAttempt, 'status_recovery_source_not_unknown');
  check(!receipt.statusRecoveryOperation || receipt.statusRecoveryOperation === executingOperation, 'status_recovery_attempt_used');
  // One unresolved source is the entire exception. Neither a second pending
  // write nor another recovery chain can borrow this command's admission.
  check(!Object.values(state.operations).some(r => unresolved(r) && r.operationId !== receipt.operationId && r.operationId !== executingOperation), 'unresolved_write_blocks_new_mutation');
  return receipt;
}

async function completeList(api, entity, parentKey, parentId, expected, fields) {
  const page = await api.list(entity, { [`_${parentKey}`]: parentId, fields: fields.join(',') }, expected.length + 1);
  check(Array.isArray(page.items) && !page.truncated && Number.isSafeInteger(page.count) && page.count === page.items.length &&
    page.items.length === expected.length, 'status_recovery_tree_incomplete');
  const wanted = new Set(expected.map(item => id(item.id))), seen = new Set();
  for (const item of page.items) {
    const itemId = id(item.id);
    check(wanted.has(itemId) && !seen.has(itemId) && id(item[parentKey]) === parentId, 'status_recovery_tree_identity_mismatch'); seen.add(itemId);
  }
  return page.items.map(item => project(item, fields)).sort((a, b) => id(a.id) - id(b.id));
}

// The digest covers the full returned configuration of the bounded tree, not
// just a name or a subset of budgets. Only the parent's status and updated time
// may differ after our one status setter. It is an optimistic guard: VK does
// not document atomic If-Match/CAS for this endpoint.
export async function recoveryTree(api, op, parentStatus) {
  check(api.auth.groups === 'ad_groups', 'status_recovery_resource_not_supported');
  const parent = project(await api.get('plans', op.id, PARENT_FIELDS), PARENT_FIELDS);
  check(id(parent.id) === op.id && parent.status === parentStatus, 'status_recovery_parent_changed');
  check(typeof parent.updated === 'string' && parent.updated.length > 0, 'status_recovery_tree_incomplete');
  const groups = await completeList(api, 'groups', 'ad_plan_id', op.id, op.guard.groups, GROUP_FIELDS);
  let total = 0, daily = 0; const tree = [];
  for (const group of groups) {
    const expected = op.guard.groups.find(g => id(g.id) === id(group.id));
    check(group.status === expected.status && cents(group.budget_limit) === cents(expected.budgetLimit) &&
      cents(group.budget_limit_day) === cents(expected.budgetLimitDay), 'status_recovery_group_changed');
    const end = group.date_end || parent.date_end;
    check(typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end) && end <= op.guard.endDate, 'status_recovery_period_invalid'); date(end);
    check(end > new Date(op.reviewedAt).toISOString().slice(0, 10), 'status_recovery_period_invalid');
    check(group.targetings && typeof group.targetings === 'object' && !Array.isArray(group.targetings), 'status_recovery_tree_incomplete');
    const banners = await completeList(api, 'banners', 'ad_group_id', id(group.id), expected.banners, BANNER_FIELDS);
    for (const banner of banners) {
      const expectedBanner = expected.banners.find(b => id(b.id) === id(banner.id));
      check(banner.status === expectedBanner.status, 'status_recovery_banner_changed');
      banner.content = creativeSection(banner.content, ['id', 'type']);
      banner.urls = creativeSection(banner.urls, ['id', 'url']);
      banner.textblocks = creativeSection(banner.textblocks, ['text', 'title']);
      if (group.status === 'active' && banner.status === 'active') check(banner.moderation_status === 'allowed', 'status_recovery_moderation_not_allowed');
    }
    total += cents(group.budget_limit); daily += cents(group.budget_limit_day);
    tree.push({ group, banners });
  }
  check(total <= cents(op.guard.maximumTotalBudget) && daily <= cents(op.guard.maximumDailyBudget), 'status_recovery_budget_exceeded');
  const normalizedParent = { ...parent }; delete normalizedParent.status; delete normalizedParent.updated;
  const review = { parent, groups: tree }; data(review);
  check(Buffer.byteLength(JSON.stringify(review)) <= 160000, 'status_recovery_tree_too_large');
  return { digest: hash(stable({ parent: normalizedParent, tree })), parentUpdated: parent.updated, review,
    observed: { id: op.id, status: parent.status, groupIds: groups.map(g => id(g.id)), totalBudget: total / 100, dailyBudget: daily / 100, endDate: op.guard.endDate } };
}

export async function prepareStatusRecovery(api, specification, state, scope, now) {
  check(exactKeys(specification, ['kind', 'entity', 'id', 'originalOperationId', 'guard']) && specification.kind === 'status-recovery' &&
    specification.entity === 'plans' && OPERATION.test(specification.originalOperationId), 'status_recovery_spec_invalid');
  const op = { ...structuredClone(specification), id: id(specification.id), guard: guardOf(specification.guard, now), reviewedAt: now };
  const source = recoverySource(state, op, scope);
  op.originalHash = source.hash; op.originalDispatchedAt = source.dispatchedAt;
  const current = await recoveryTree(api, op, 'blocked');
  op.treeDigest = current.digest; op.parentUpdated = current.parentUpdated;
  op.review = current.review;
  op.effect = { entity: 'plans', id: op.id, payload: { status: 'active' }, additionalDispatchesMaximum: 1 };
  return op;
}

export async function preflightStatusRecovery(api, op, state, scope, now) {
  const source = recoverySource(state, op, scope);
  check(source.hash === op.originalHash && source.dispatchedAt === op.originalDispatchedAt, 'status_recovery_source_invalid');
  guardOf(op.guard, now);
  const current = await recoveryTree(api, { ...op, reviewedAt: now }, 'blocked');
  check(current.digest === op.treeDigest && current.parentUpdated === op.parentUpdated, 'object_changed_replan_required');
  return source;
}

export async function verifyStatusRecovery(api, op) {
  const current = await recoveryTree(api, op, 'active');
  check(current.digest === op.treeDigest, 'status_recovery_tree_changed');
  return current.observed;
}

export function finishStatusRecovery(state, op, receipt, scope) {
  const source = recoverySource(state, op, scope, { executingOperation: receipt.operationId });
  // Resolve the pending desired state only with the completed full read-back.
  // Do not claim that the original timed-out HTTP request itself succeeded.
  check(receipt.phase === 'verified', 'status_recovery_not_verified');
  source.phase = 'resolved_by_status_recovery';
  source.resolution = { operationId: receipt.operationId, originalRequestOutcome: 'unknown', currentStateVerified: true };
  source.observed = { id: op.id, status: 'active' };
}
