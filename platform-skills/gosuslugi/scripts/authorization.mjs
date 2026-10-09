import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { UUID, authOrigin, officialUrl, requireThat, RuntimeError, digest } from './core.mjs';
import { atomicWrite } from './native.mjs';
import { authRpc } from './auth-rpc.mjs';

const ROLE_ORIGIN = 'https://roles.gosuslugi.ru';

// ESIA can send an already accepted OAuth callback through its own identity
// chooser before the relying party document commits. Password access is closed
// at that point; only this fixed personal-card action may remain available.
function pendingPersonalRole(portal, hasReturned) {
  try {
    return portal.serviceFlow.callbackAccepted === true &&
      portal.serviceFlow.callbackSeen === true &&
      !portal.serviceFlow.error && !hasReturned() &&
      new URL(portal.page.url()).origin === ROLE_ORIGIN;
  } catch { return false; }
}

async function choosePendingPersonalRole(page, permit, beforeClick) {
  const url = page.url();
  const heading = page.getByRole('heading', { name: 'Войти как', exact: true }).filter({ visible: true });
  const target = page.getByText(/(?:Физическое|Частное)\s+лицо/i).filter({ visible: true });
  const fields = page.locator('input,textarea,select').filter({ visible: true });
  // The callback response can be accepted while the redirected chooser is
  // still painting. Wait only for these two fixed, visible signals; a missing
  // or ambiguous card stays a human decision and never starts another action.
  try {
    await heading.waitFor({ state: 'visible', timeout: 8000 });
    await target.waitFor({ state: 'visible', timeout: 8000 });
  } catch { return { selected: false }; }
  if (new URL(url).origin !== ROLE_ORIGIN || await heading.count() !== 1 ||
    await target.count() !== 1 || await fields.count() !== 0 || !await target.isEnabled())
    return { selected: false };
  const text = (await page.locator('body').innerText()).slice(0, 16000);
  // A type label is not permission to pass a mixed CAPTCHA, consent, recovery,
  // code, payment or signature screen. The chooser has no editable fields.
  if (/captcha|капч|робот|восстановлен|смен[аи] пароля|заблокирован|push|подтвердите.*(телефон|приложени)|биометри|смс|sms|одноразов|соглас.{0,80}(передач|обработ)|оплат|плат[её]ж|подпис[аы]/i.test(text))
    return { selected: false };
  const meta = await target.evaluate(node => ({
    tag: node.tagName.toLowerCase(), length: (node.textContent || '').trim().length,
    href: node.hasAttribute('href') ? node.href : null,
  }));
  if (['html', 'body', 'main', 'section', 'h1', 'h2', 'h3'].includes(meta.tag) ||
    meta.length > 240 || meta.href && !officialUrl(meta.href)) return { selected: false };
  const element = await target.elementHandle();
  if (!element) return { selected: false };
  try {
    await permit();
    if (page.url() !== url || await heading.count() !== 1 ||
      await target.count() !== 1 || await fields.count() !== 0 ||
      !await element.isVisible() || !await element.isEnabled()) return { selected: false };
    const stillSame = await element.evaluate(node => ({
      connected: node.isConnected, tag: node.tagName.toLowerCase(),
      label: (node.textContent || '').trim(),
      href: node.hasAttribute('href') ? node.href : null,
    }));
    if (!stillSame.connected || stillSame.tag !== meta.tag ||
      !/(?:Физическое|Частное)\s+лицо/i.test(stillSame.label) ||
      stillSame.label.length > 240 || stillSame.href !== meta.href) return { selected: false };
    // Consume the one-shot choice before dispatch. A navigation timeout cannot
    // trigger another click on a different identity card at the same locator.
    beforeClick();
    await element.click();
    return { selected: true };
  } finally { await element.dispose().catch(() => {}); }
}

// A capability for one observed ESIA transaction. Site workflows use only the
// ordinary browser API; this private API has no caller-defined business code.
export function createAuthorizationBroker({
  config,
  portal,
  permit,
  port,
  onCancel,
  show,
  getPostCount = () => 0,
  onPersonalRoleChoice = () => {},
  // A popup may close its own verified callback document. The browser client
  // retains that proof independently of its cached URL; older portal callers
  // retain their same-page check through this default.
  hasReturned = () => portal.serviceFlow.hasAuthenticatedReturn && !authOrigin(portal.page.url()),
}) {
  const authToken = crypto.randomBytes(32).toString('hex'),
    secretFingerprints = [];
  let authorization = null,
    claim = null, finished = false;
  function redact(text) {
    // Keep only hashes after private typing. Even a later page that echoes an
    // input cannot expose its plaintext through the public snapshot channel.
    let result = String(text);
    for (const item of secretFingerprints) {
      let next = '',
        index = 0;
      while (index < result.length) {
        if (
          index + item.length <= result.length &&
          digest(result.slice(index, index + item.length)) === item.hash
        ) {
          next += '[redacted]';
          index += item.length;
        } else next += result[index++];
      }
      result = next;
    }
    return result;
  }
  async function refreshAuthorization() {
    if (
      !portal || finished ||
      authorization ||
      !portal.serviceFlow.binding ||
      portal.serviceFlow.error
    )
      return;
    authorization = {
      schema: 1,
      sessionId: config.leaseId,
      requestId: crypto.randomUUID(),
      origin: portal.service.origin,
      company: config.identity.company,
      member: config.identity.member,
      accountId: config.identity.accountId ?? null,
      startedAt: config.startedAt,
      expiresAt: config.expiresAt,
      brokerPid: process.pid,
      port: port,
      token: authToken,
    };
    await atomicWrite(
      path.join(config.directory, 'authorization.json'),
      JSON.stringify(authorization),
      config.helper,
    );
  }
  async function privateCommand(packet) {
    await permit();
    requireThat(Date.now() < config.expiresAt, 'session_expired');
    requireThat(
      authorization && packet.requestId === authorization.requestId && packet.sessionId === config.leaseId,
      'authorization_request_mismatch',
    );
    if (packet.command === 'claim') {
      // Runtime confirmation represents the agent's check of current user consent
      // for this exact origin. A login button or web page can never set this bit.
      requireThat(
        packet.confirmed === true &&
          packet.origin === authorization.origin &&
          packet.company === config.identity.company &&
          packet.member === config.identity.member &&
          (packet.accountId ?? null) === (config.identity.accountId ?? null) &&
          UUID.test(packet.authorizationLease || '') &&
          Number.isInteger(packet.guardPid) &&
          packet.guardPid > 1,
        'authorization_permission_required',
      );
      requireThat(!claim || claim.lease === packet.authorizationLease, 'authorization_already_claimed');
      try {
        process.kill(packet.guardPid, 0);
      } catch {
        throw new RuntimeError('authorizer_unavailable');
      }
      // Request, response and document commit are separate Playwright events.
      // Even a verified callback response can arrive while page.url() still
      // points to ESIA. Fast SSO needs no input: wait for both its HTTP proof
      // and the actual document return before considering credential access.
      // A direct popup may also start at about:blank while its first ESIA
      // response is loading. The already-bound request must reach that auth
      // document before claim; waiting here still precedes the vault/key read.
      const returnDeadline = Date.now() + 5000;
      while ((portal.serviceFlow.callbackSeen || !authOrigin(portal.page.url())) &&
        !hasReturned() &&
        !portal.serviceFlow.error && Date.now() < returnDeadline) {
        await permit(); await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Existing ESIA cookies can complete SSO before the agent starts the
      // authorizer. Consume that verified return before any vault/key read.
      if (hasReturned()) {
        finished = true;
        await fs.rm(path.join(config.directory, 'authorization.json'), { force: true });
        authorization = null;
        return { claimed: false, returned: true };
      }
      portal.serviceFlow.allowSecret();
      requireThat(authOrigin(portal.page.url()), 'authorization_not_ready');
      claim = { lease: packet.authorizationLease, guardPid: packet.guardPid };
      portal.authLocked = true;
      return { claimed: true, expiresAt: config.expiresAt };
    }
    requireThat(claim && packet.authorizationLease === claim.lease, 'authorization_claim_required');
    try {
      process.kill(claim.guardPid, 0);
    } catch {
      throw new RuntimeError('authorizer_unavailable');
    }
    if (packet.command === 'auth-state')
      return {
        // A callback request revokes further credential input immediately, but
        // its HTTP response does not prove that Playwright committed the new
        // document. The authorizer waits through this interval without another
        // observe/type/submit or a premature completion request.
        atAuth: !portal.serviceFlow.callbackSeen && authOrigin(portal.page.url()),
        returning: portal.serviceFlow.callbackSeen,
        returned: hasReturned(),
        personalRolePending: pendingPersonalRole(portal, hasReturned),
        failed: portal.serviceFlow.error,
        ...(portal.serviceFlow.httpFailure ?? {}),
        postCount: getPostCount(),
        expiresAt: config.expiresAt,
      };
    if (packet.command === 'choose-personal-role') {
      requireThat(pendingPersonalRole(portal, hasReturned), 'role_chooser_required');
      return choosePendingPersonalRole(portal.page, permit, onPersonalRoleChoice);
    }
    if (packet.command === 'complete') {
      requireThat(
        hasReturned(),
        'authorization_return_required',
      );
      claim = null;
      finished = true;
      portal.authLocked = false;
      await fs.rm(path.join(config.directory, 'authorization.json'), { force: true });
      authorization = null;
      return { returned: true };
    }
    if (packet.command === 'cancel') {
      await onCancel();
      return { closed: true };
    }
    if (packet.command === 'show') {
      await show();
      return { shown: true };
    }
    if (packet.command === 'protect-input') {
      portal.serviceFlow.allowSecret();
      requireThat(authOrigin(portal.page.url()), 'secret_origin_rejected');
      requireThat(
        typeof packet.text === 'string' &&
          packet.text.length >= 4 &&
          packet.text.length <= 256 &&
          secretFingerprints.length < 16,
        'auth_input_invalid',
      );
      secretFingerprints.push({ length: packet.text.length, hash: digest(packet.text) });
      return { protected: true };
    }
    requireThat(packet.command === 'auth-operation', 'auth_operation_invalid');
    if (
      packet.operation === 'type' &&
      typeof packet.text === 'string' &&
      packet.text.length >= 4 &&
      secretFingerprints.length < 16
    )
      secretFingerprints.push({ length: packet.text.length, hash: digest(packet.text) });
    try {
      return await authRpc(portal.page, portal.serviceFlow, packet, permit);
    } catch (error) {
      // A final TOTP character can submit the form, commit the callback and
      // close its popup before Playwright acknowledges typing. Do not repeat
      // the operation or report an unproved success: hand the authorizer back
      // to its read-only return wait, which still requires HTTP + commit proof.
      if (portal.serviceFlow.callbackSeen && !portal.serviceFlow.error)
        throw new RuntimeError('authorization_return_in_progress');
      throw error;
    }
  }

  return {
    token: authToken,
    refresh: refreshAuthorization,
    handle: privateCommand,
    redact,
    get authorization() {
      return authorization;
    },
    get claim() {
      return claim;
    },
  };
}
