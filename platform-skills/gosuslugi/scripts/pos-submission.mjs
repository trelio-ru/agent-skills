import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RuntimeError, requireThat } from './core.mjs';

const ORIGIN = 'https://pos.gosuslugi.ru';
const AGREEMENT_CAPTION = 'Я соглашаюсь с правилами подачи сообщений и обращений';
const STEPS = new Map([
  ['/user-service/esia/esia-token', ['GET', 'token_exchange']],
  ['/user-service/esia/get-user-info', ['GET', 'user_info']],
  ['/inbox-service/filestorage', ['POST', 'attachment_upload']],
  ['/inbox-service/appeals', ['POST', 'appeal_create']],
]);
const OPERATIONS = new Set(['review', 'select', 'set_federal_law', 'start', 'advance', 'inspect', 'close']);

// Never project a browser's message/stack/selector: those may contain the
// statement, personal data or an OAuth URL. The actual operation and the
// observed HTTP status explain more than a generic caller_action_failed.
export function safePosFailure(error, operation) {
  requireThat(OPERATIONS.has(operation), 'pos_operation_invalid');
  const code = error instanceof RuntimeError && /^pos_[a-z_]{1,80}$/.test(error.code)
    ? error.code : error?.name === 'TimeoutError' ? 'pos_action_timeout' : 'pos_action_failed';
  return { code, operation };
}

function formUrl(page) {
  let url;
  try { url = new URL(page.url()); } catch { /* Fixed error below; never return the URL. */ }
  requireThat(url?.origin === ORIGIN && !url.username && !url.password && !url.port && url.pathname === '/form/' &&
    /^\d{1,12}$/.test(url.searchParams.get('opaId') ?? '') &&
    url.searchParams.getAll('opaId').length === 1, 'pos_form_required');
  return url.searchParams.get('opaId');
}

/**
 * Observe the real widget's three independent stages: ESIA return, token/user
 * exchange and appeal creation. The widget catches a failed create request and
 * may silently render the initial form again. That is never a new login step.
 *
 * This object owns neither the Page nor the browser. It never reads network
 * bodies, headers, auth DOM or storage, and never calls the POS API itself.
 * Only the source Page's own requests are evidence; its popup/subframes cannot
 * manufacture an appeal receipt. A new object cannot reset a live Page's latch.
 */
const pageAttempts = new WeakMap();
export function createPosSubmissionFlow(page, options, { createAuthorization, observeAuthorization }) {
  requireThat(options?.confirm === true, 'pos_submission_permission_required');
  const opaId = formUrl(page);
  requireThat(!pageAttempts.has(page), 'pos_page_already_observed');
  const startedClock = performance.now();
  const leaseMs = 1_800_000;
  let closed = false, busy = false, login, observer, reviewId, reviewDigest;
  let started = false, entrySent = false, modalSent = false, roleSent = false;
  let failure, receipt, deadlineReached = false;
  let activeDone = Promise.resolve(), finishActive, closing;
  let uploadQueue = Promise.resolve(), uploadRouting = false;
  const requests = new Map(), uploadWaiters = new Map();
  const evidence = { token_exchange: {}, user_info: {}, attachment_upload: {}, appeal_create: {} };
  pageAttempts.set(page, true);

  function permit() {
    requireThat(!closed, 'pos_closed');
    requireThat(performance.now() - startedClock < leaseMs, 'pos_session_expired');
    requireThat(formUrl(page) === opaId, 'pos_form_changed');
  }
  function stageFor(request) {
    try {
      if (request.frame() !== page.mainFrame() || request.isNavigationRequest()) return null;
      const url = new URL(request.url()), step = STEPS.get(url.pathname);
      return url.origin === ORIGIN && step?.[0] === request.method() ? step[1] : null;
    } catch { return null; }
  }
  function onRequest(request) {
    const stage = stageFor(request);
    if (!stage || !entrySent) return;
    if (requests.size >= 64) {
      failure ??= { code: 'pos_observation_overflow', operation: 'inspect' };
      return;
    }
    requests.set(request, stage);
    const current = evidence[stage];
    current.dispatched = (current.dispatched ?? 0) + 1;
    if (stage === 'appeal_create' && current.dispatched > 1) {
      failure = { code: 'pos_multiple_create_requests', operation: 'advance' };
    }
  }
  function onResponse(response) {
    const stage = requests.get(response.request());
    if (!stage) return;
    const status = response.status();
    // Keep the first failure, rather than replacing it with a later success
    // or an analytics response. No URL/query or provider body is retained.
    if (Number.isInteger(status) && status >= 100 && status <= 599 &&
      !(evidence[stage].httpStatus >= 400)) evidence[stage].httpStatus = status;
    uploadWaiters.get(response.request())?.();
  }
  function onRequestFailed(request) {
    const stage = requests.get(request);
    if (stage) evidence[stage].transportFailed = true;
    uploadWaiters.get(request)?.();
  }
  const uploadPattern = ORIGIN + '/inbox-service/filestorage';
  const uploadRoute = async route => {
    const request = route.request();
    if (stageFor(request) !== 'attachment_upload' || !entrySent) return route.fallback();
    // The widget uses Promise.all for every selected File. Pace the SAME
    // original requests instead: no new fetch, body/header copy or retry, and
    // no credential or document bytes cross this observer. A failed upload
    // cancels still-queued uploads and can never trigger another login.
    const previous = uploadQueue;
    let release, timer;
    const settled = new Promise(resolve => { release = () => {
      clearTimeout(timer); uploadWaiters.delete(request); resolve();
    }; });
    uploadQueue = previous.then(() => settled).then(() => closed || evidence.attachment_upload.httpStatus >= 400 ||
      evidence.attachment_upload.transportFailed ? undefined : new Promise(resolve => setTimeout(resolve, 1000)));
    try {
      await previous;
      if (closed || evidence.attachment_upload.httpStatus >= 400 || evidence.attachment_upload.transportFailed) {
        await route.abort('blockedbyclient'); release(); return;
      }
      permit(); uploadWaiters.set(request, release);
      timer = setTimeout(() => {
        evidence.attachment_upload.transportFailed = true;
        failure ??= { code: 'pos_upload_result_unknown', operation: 'advance' }; release();
      }, 10000);
      // Return from this route after forwarding. Waiting for response.finished
      // inside the route can prevent Chromium from finishing that same request.
      // The next request waits for the prior headers/failure event instead.
      await route.fallback();
    } catch (error) {
      evidence.attachment_upload.transportFailed = true;
      failure ??= error instanceof RuntimeError ? safePosFailure(error, 'advance') :
        { code: 'pos_upload_result_unknown', operation: 'advance' };
      // A rejected permit leaves this intercepted request paused. Always try
      // to finish it; an already-forwarded route rejects abort harmlessly and
      // remains an unknown outcome, never a retry opportunity.
      try { await route.abort('blockedbyclient'); } catch { /* Already handled. */ }
      release();
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  async function readPage() {
    permit();
    return page.evaluate(agreementCaption => {
      const visible = node => Boolean(node && node.getClientRects().length &&
        getComputedStyle(node).visibility !== 'hidden');
      // Read a small set of form-owned nodes, never body.innerText. That also
      // avoids returning org names from the post-callback role chooser.
      const status = [...document.querySelectorAll('.feedback-status')].find(visible);
      let registrationNumber = null;
      if (status?.textContent.trim() === 'Отправлено') {
        const rows = [...document.querySelectorAll('.feedback-text')].filter(visible);
        const row = rows.find(node => /^Регистрационный номер\s*:/u.test(node.textContent.trim()));
        const value = row?.textContent.trim().match(/^Регистрационный номер\s*:\s*(\d{1,24})\s*$/u);
        registrationNumber = value?.[1] ?? null;
      }
      const footer = [...document.querySelectorAll('button.esia-auth-button')].filter(visible);
      const agreement = document.querySelector('#check-agree');
      const agreementLabels = [...document.querySelectorAll('label[for="check-agree"]')];
      const agreementLabel = agreementLabels.length === 1 ? agreementLabels[0] : null;
      // Even an already checked control must still be the known POS rule.
      // Keep caption/link targets in the private review fingerprint: native
      // helper setup is asynchronous and cannot authorize changed conditions.
      // None of these terms or URLs are projected in the public snapshot.
      const agreementTerms = agreementLabel ? {
        caption: agreementLabel.textContent.replace(/\s+/gu, ' ').trim(),
        links: [...agreementLabel.querySelectorAll('a')].map(node => node.href),
      } : null;
      if (agreementTerms && (agreementTerms.caption.length > 1000 || agreementTerms.links.length > 4 ||
        agreementTerms.links.some(link => link.length > 2048))) return { overflow: true };
      const agreementKnown = document.querySelectorAll('#check-agree').length === 1 &&
        agreement?.tagName === 'INPUT' && agreement.type === 'checkbox' && !agreement.disabled &&
        agreementLabel?.control === agreement && agreementTerms?.caption === agreementCaption;
      const fields = [...document.querySelectorAll('input,textarea,select')]
        .filter(node => node.id !== 'check-agree' && !node.closest('.form-auth-overlay') &&
          ['text', 'email', 'tel', 'number', 'textarea', 'select-one', 'select-multiple', 'file', 'checkbox']
            .includes(node.type) && !/password|one-time-code/u.test(node.autocomplete ?? ''));
      if (fields.length > 120 || fields.some(node => String(node.value).length > 20000 ||
        node.type === 'file' && node.files.length > 20)) return { overflow: true };
      // The canonical material is hashed privately in Node and never included
      // in snapshots/events. A changed statement, selector or file invalidates
      // the review; the user's agreement can change without losing that review.
      const material = fields.map(node => ({ id: node.id, type: node.type,
        value: node.type === 'file' ? null : node.value,
        checked: node.type === 'checkbox' ? node.checked : null,
        files: node.type === 'file' ? [...(node.files ?? [])].map(file =>
          ({ name: file.name, size: file.size, lastModified: file.lastModified })) : null,
      }));
      const choices = [...document.querySelectorAll('.select__single-value,.select__multi-value__label')]
        .filter(visible).map(node => node.textContent);
      const attachments = [...document.querySelectorAll('.images-wrapper > *')]
        .filter(visible).map(node => node.textContent);
      if (choices.length > 40 || attachments.length > 20 ||
        [...choices, ...attachments].some(text => text.length > 1000)) return { overflow: true };
      const overlay = document.querySelector('.form-auth-overlay');
      const personal = overlay ? [...overlay.querySelectorAll('button')].filter(node => visible(node) &&
        /(?:^|[,\s])(?:Частное лицо|Физическое лицо)(?:\s|$)/iu.test(node.textContent.trim())) : [];
      return { registrationNumber, material, choices, attachments, agreementTerms, agreementKnown,
        agreement: agreement?.checked === true,
        footerReady: footer.length === 1 && !footer[0].disabled,
        roleCount: personal.length, roleReady: personal.length === 1 && !personal[0].disabled,
        overlay: visible(overlay),
      };
    }, AGREEMENT_CAPTION).then(result => {
      requireThat(!result.overflow, 'pos_form_too_large');
      return result;
    });
  }
  async function setKnownChoice(id, caption, enabled, accordion = false) {
    const input = page.locator(`#${id}`), label = page.locator(`label[for="${id}"]`);
    requireThat(await input.count() === 1 && await label.count() === 1, 'pos_choice_unsupported');
    const valid = await label.evaluate((node, expected) => {
      const control = document.getElementById(expected.id);
      return node.tagName === 'LABEL' && node.control === control && control?.tagName === 'INPUT' &&
        control.type === 'checkbox' && !control.disabled &&
        node.textContent.replace(/\s+/gu, ' ').trim() === expected.caption;
    }, { id, caption });
    requireThat(valid, 'pos_choice_unsupported');
    if (await input.isChecked() === enabled) return;
    // POS renders a readOnly controlled input. Its visible LABEL owns the
    // state transition; input.click() can do nothing. The law selector may
    // additionally be inside a collapsed accordion. Never force hidden input
    // events or write checked/React state directly.
    if (!await label.isVisible() && accordion) {
      const summary = page.locator('.fz-accordion').filter({ has: input }).locator('.accordion__summary');
      requireThat(await summary.count() === 1, 'pos_choice_unsupported');
      permit(); await summary.click({ timeout: 10000 });
    }
    permit();
    // Use the label's checkbox edge, not the text/link in the rules caption.
    // This performs one ordinary trusted browser click without opening terms
    // or accidentally clicking a nested navigation link.
    await label.click({ position: { x: 1, y: 1 }, timeout: 10000 });
    await page.waitForFunction(({ id, enabled }) => document.getElementById(id)?.checked === enabled,
      { id, enabled }, { timeout: 5000 });
  }
  const digest = value => crypto.createHash('sha256')
    .update(JSON.stringify({ opaId, material: value.material, choices: value.choices,
      attachments: value.attachments, agreementTerms: value.agreementTerms })).digest('hex');

  function snapshot(current = {}) {
    const authorization = observer?.snapshot();
    const failedStage = Object.keys(evidence).find(stage =>
      evidence[stage].httpStatus >= 400 || evidence[stage].transportFailed);
    const dispatched = Boolean(evidence.appeal_create.dispatched);
    const succeeded = Boolean(receipt && evidence.appeal_create.dispatched === 1 &&
      failure?.code !== 'pos_observation_overflow');
    let code = failure?.code ?? (authorization?.phase === 'authorization_failed' ? 'pos_authorization_failed' : failedStage ? 'pos_http_failure' :
      deadlineReached ? dispatched ? 'pos_submission_unverified' : 'pos_create_not_observed' : null);
    // A late receipt reconciles a lost response, but never hides a duplicate
    // dispatch or failed cleanup. A pre-existing receipt is only a lead: it
    // has not been correlated to this reviewed submission.
    if (succeeded && !['pos_cleanup_failed', 'pos_observation_overflow'].includes(failure?.code)) code = null;
    return { phase: code ? 'blocked' : succeeded ? 'submitted' : current.registrationNumber && !started ? 'existing_receipt' :
      !started ? 'prepared' :
      dispatched ? 'submitting' : current.roleCount ? 'role_selection' : 'authorizing',
    outcome: succeeded ? 'confirmed_succeeded' : dispatched || entrySent ? 'unknown' : 'not_dispatched',
    ...(code ? { code, operation: failure?.operation ?? 'inspect', stage: failedStage ?? 'verification' } : {}),
    ...(receipt ? { receipt: { ...receipt } } : current.registrationNumber && !started ?
      { existingReceipt: { registrationNumber: current.registrationNumber, source: 'pos_form' } } : {}),
    authorization,
    evidence: structuredClone(evidence),
    recovery: { retry: 'forbidden', nextAction: code === 'pos_multiple_create_requests' ? 'verify_possible_duplicate' : succeeded ? 'save_receipt' : code ?
      'inspect_same_form_and_http_evidence' : 'continue_same_form' },
    };
  }
  async function inspect() {
    const current = await readPage();
    if (current.registrationNumber && entrySent && evidence.appeal_create.dispatched) {
      receipt = { registrationNumber: current.registrationNumber, source: 'pos_form' };
    }
    return snapshot(current);
  }
  async function guarded(operation, action) {
    requireThat(!busy, 'pos_busy');
    busy = true;
    activeDone = new Promise(resolve => { finishActive = resolve; });
    try { permit(); return await action(); }
    catch (error) {
      const safe = safePosFailure(error, operation);
      if (started) { failure ??= safe; return snapshot(); }
      // A missing agreement or a changed review has dispatched nothing. Fix
      // the SAME form and review it again; a new Page/helper is unnecessary.
      return { ...snapshot(), phase: 'blocked', ...safe, stage: 'preflight',
        recovery: { retry: 'forbidden', nextAction: 'correct_and_review_same_form' } };
    }
    finally { busy = false; finishActive(); }
  }
  return {
    select: ({ inputId, label } = {}) => guarded('select', async () => {
      requireThat(!started && /^react-select-\d+-input$/u.test(inputId ?? '') &&
        typeof label === 'string' && label.trim() === label && label.length > 0 && label.length <= 200,
      'pos_option_invalid');
      const input = page.locator(`input[id="${inputId}"]`);
      const root = page.locator('.basic-multi-select').filter({ has: input });
      requireThat(await root.count() === 1, 'pos_option_owner_ambiguous');
      const exact = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'u');
      await input.fill(label);
      // React Select's generated option-N index changes when its asynchronous
      // list refreshes. Select by the requested label inside this exact owner,
      // then verify the selected value instead of trusting the index/click.
      const option = root.locator('.select__option').filter({ hasText: exact });
      await option.waitFor({ state: 'visible', timeout: 10000 });
      requireThat(await option.count() === 1 && await option.getAttribute('aria-disabled') !== 'true' &&
        !(await option.getAttribute('class') ?? '').includes('select__option--is-disabled'), 'pos_option_ambiguous');
      permit(); await option.click({ timeout: 10000 });
      await root.locator('.select__single-value,.select__multi-value__label').filter({ hasText: exact })
        .waitFor({ state: 'visible', timeout: 10000 });
      reviewId = null; reviewDigest = null;
      return inspect();
    }),
    setFederalLaw: ({ enabled } = {}) => guarded('set_federal_law', async () => {
      requireThat(!started && typeof enabled === 'boolean', 'pos_federal_law_invalid');
      await setKnownChoice('check-requestedFederalLawType', 'Подать обращение по 59-ФЗ', enabled, true);
      reviewId = null; reviewDigest = null;
      return inspect();
    }),
    review: () => guarded('review', async () => {
      requireThat(!started, 'pos_attempt_already_started');
      const current = await readPage();
      requireThat(!current.registrationNumber && !current.overlay, 'pos_existing_result_or_login');
      reviewDigest = digest(current); reviewId = crypto.randomUUID();
      return { ...snapshot(current), reviewId };
    }),
    start: ({ reviewed, confirmSubmission } = {}) => guarded('start', async () => {
      requireThat(confirmSubmission === true, 'pos_submission_permission_required');
      requireThat(!started && !failure, 'pos_attempt_already_started');
      const current = await readPage();
      requireThat(reviewId && reviewed === reviewId && digest(current) === reviewDigest, 'pos_review_changed');
      requireThat(current.agreementKnown, 'pos_choice_unsupported');
      requireThat(!current.overlay, 'pos_form_not_ready');
      // The user's permission is for this exact reviewed submission. It also
      // authorizes its standard POS rules checkbox; no second human click is
      // needed. Unknown captions/additional consents are never accepted by
      // this fixed helper. No permission or changed text/files => no checkbox.
      if (!current.agreement) await setKnownChoice('check-agree', AGREEMENT_CAPTION, true);
      const accepted = await readPage();
      requireThat(digest(accepted) === reviewDigest, 'pos_review_changed');
      requireThat(accepted.agreementKnown && accepted.agreement && accepted.footerReady && !accepted.overlay, 'pos_form_not_ready');
      // Consume before any browser action. A timeout may happen after dispatch;
      // neither another start nor a new helper on this Page may replay it.
      started = true;
      // A corrected preflight can reuse this object. Register once: duplicate
      // handlers would fallback into the same queue and wait on themselves.
      if (!uploadRouting) { await page.route(uploadPattern, uploadRoute); uploadRouting = true; }
      login = await createAuthorization(page, { ...options, origin: ORIGIN, confirm: true });
      // close/expiry can race native setup. Revoke the returned helper before
      // any click if this flow was cancelled while creation was pending.
      try { permit(); } catch (error) { await login.close(); login = null; throw error; }
      observer = observeAuthorization(login);
      // Native preparation can take seconds. A review performed before it
      // cannot authorize text/files changed in the meantime. No site click has
      // run yet, so this specific correction can retain the same Page.
      const fresh = await readPage();
      if (digest(fresh) !== reviewDigest || !fresh.agreementKnown || !fresh.agreement || !fresh.footerReady || fresh.overlay) {
        const unused = login; login = null;
        await unused.close(); observer = null; started = false;
        throw new RuntimeError('pos_review_changed');
      }
      permit();
      entrySent = true;
      await page.locator('button.esia-auth-button').click({ timeout: 10000 });
      return inspect();
    }),
    advance: () => guarded('advance', async () => {
      requireThat(started && !failure && !deadlineReached && !Object.values(evidence).some(value =>
        value.httpStatus >= 400 || value.transportFailed), 'pos_attempt_not_resumable');
      const current = await readPage(), auth = observer.snapshot();
      if (current.registrationNumber) return inspect();
      // The public widget's own overlay may require the second login button.
      // Never inspect or click the ESIA popup from this provider-owned helper.
      if (['esia_request_pending', 'esia_request_not_observed'].includes(auth.phase) && current.overlay && !modalSent) {
        const button = page.locator('.form-auth-overlay button').filter({ hasText: /^Войти через\s*$/u });
        if (await button.count() === 1 && await button.isEnabled()) {
          permit();
          modalSent = true;
          await button.click({ timeout: 10000 });
        }
      } else if (auth.phase === 'esia_callback_verified' && current.roleCount && !roleSent &&
        !evidence.appeal_create.dispatched) {
        requireThat(current.roleCount === 1 && current.roleReady, 'pos_personal_role_ambiguous');
        // POS chooses its own business role AFTER ESIA has returned. Only the
        // unique explicit personal card is automatic; names/order are ignored.
        permit(); roleSent = true;
        await page.locator('.form-auth-overlay button')
          .filter({ hasText: /(?:^|[,\s])(?:Частное лицо|Физическое лицо)(?:\s|$)/iu })
          .click({ timeout: 10000 });
      }
      return inspect();
    }),
    inspect: () => guarded('inspect', inspect),
    wait: async ({ timeoutMs = 30000 } = {}) => {
      requireThat(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000, 'pos_wait_invalid');
      const until = performance.now() + timeoutMs;
      let result;
      do {
        result = await guarded('inspect', inspect);
        if (['submitted', 'blocked'].includes(result.phase)) return result;
        await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, until - performance.now()))));
      } while (performance.now() < until);
      // Waiting for a human/ESIA is not a failed business verification and
      // does not justify a new login. Only a returned, dispatched business
      // procedure can exhaust this bounded receipt wait.
      deadlineReached = Boolean(evidence.appeal_create.dispatched ||
        observer?.snapshot().phase === 'esia_callback_verified' && roleSent);
      return snapshot();
    },
    close: async () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        // An in-flight Playwright click cannot be recalled. Keep observing it
        // until the bounded command settles, and never report closed while it
        // could still dispatch after our listeners were detached.
        await activeDone;
        await uploadQueue;
        let cleanupFailed = false;
        if (uploadRouting) try { await page.unroute(uploadPattern, uploadRoute); } catch { cleanupFailed = true; }
        page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onRequestFailed);
        requests.clear(); reviewDigest = null; reviewId = null;
        try { await login?.close(); } catch { cleanupFailed = true; }
        if (cleanupFailed) failure ??= { code: 'pos_cleanup_failed', operation: 'close' };
        return { ...snapshot(), closed: !cleanupFailed, cleanupFailed };
      })();
      return closing;
    },
  };
}
