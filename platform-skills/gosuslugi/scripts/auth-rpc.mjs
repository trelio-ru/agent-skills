import { authOrigin, requireThat, RuntimeError } from './core.mjs';

// Private process protocol, never an agent-facing browser/evaluate tool.
// The authorizer supplies bounded selectors; all evaluation bodies are fixed
// here and never return input values, cookies, storage, endpoints or tokens.
function locator(page, query, depth = 0) {
  requireThat(query && depth < 6 && typeof query === 'object', 'auth_query_invalid');
  let result;
  if (query.css) {
    requireThat(typeof query.css === 'string' && query.css.length <= 512, 'auth_query_invalid');
    result = page.locator(query.css);
  } else if (query.text) {
    const text =
      typeof query.text === 'string' ? query.text : new RegExp(query.text.pattern, query.text.flags || '');
    result = page.getByText(text, { exact: Boolean(query.exact) });
  } else if (query.role) {
    const name =
      typeof query.name === 'string' ? query.name : new RegExp(query.name.pattern, query.name.flags || '');
    result = page.getByRole(query.role, { name, exact: Boolean(query.exact) });
  } else throw new RuntimeError('auth_query_invalid');
  if (query.visible) result = result.filter({ visible: true });
  if (query.nth !== undefined) {
    requireThat(Number.isInteger(query.nth) && query.nth >= 0 && query.nth < 6, 'auth_query_invalid');
    result = result.nth(query.nth);
  }
  return result;
}
export async function authRpc(page, flow, packet, permit) {
  await permit();
  flow.allowSecret();
  requireThat(authOrigin(page.url()), 'secret_origin_rejected');
  const before = page.url(),
    target = packet.query ? locator(page, packet.query) : null;
  const unchanged = () => {
    // The callback request revokes input before navigation commits. Checking
    // the old page URL alone would allow more characters during that interval.
    flow.allowSecret();
    requireThat(page.url() === before && authOrigin(page.url()), 'auth_page_changed');
  };
  if (packet.operation === 'observe') {
    requireThat(packet.queries && Object.keys(packet.queries).length <= 12, 'auth_query_invalid');
    const text = (await page.locator('body').innerText()).slice(0, 16000),
      queries = {};
    for (const [key, query] of Object.entries(packet.queries)) {
      requireThat(/^[a-z]+$/.test(key), 'auth_query_invalid');
      const found = locator(page, query),
        count = await found.count();
      requireThat(count <= 100, 'auth_query_ambiguous');
      queries[key] = { count };
      if (count <= 6 && count > 0)
        queries[key].fields = await found.evaluateAll((nodes) =>
          nodes.map((node) => ({
            tag: node.tagName.toLowerCase(),
            type: node.getAttribute('type') || '',
            inputMode: node.getAttribute('inputmode') || '',
            autocomplete: node.getAttribute('autocomplete') || '',
            maxLength: node.getAttribute('maxlength'),
            readOnly: Boolean(node.readOnly),
            disabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true',
            checked: Boolean(node.checked),
            length: (node.textContent || '').trim().length,
            label: (node.tagName === 'INPUT'
              ? node.type === 'checkbox'
                ? node.labels?.[0]?.textContent || node.parentElement?.textContent || ''
                : ''
              : node.textContent || ''
            )
              .trim()
              .slice(0, 240),
            href: node.hasAttribute('href') ? node.href : null,
          })),
        );
    }
    unchanged();
    return { text, queries };
  }
  requireThat(
    target && (await target.count()) === 1 && (await target.isVisible()) && (await target.isEnabled()),
    'auth_input_ambiguous',
  );
  if (packet.operation === 'type') {
    requireThat(
      typeof packet.text === 'string' &&
        packet.text.length > 0 &&
        packet.text.length <= 256 &&
        !/[\r\n\0]/.test(packet.text),
      'auth_input_invalid',
    );
    // Bind the actual node before entering a secret. A locator would resolve
    // again after navigation and could find an unrelated input on the caller
    // site. Each character retains this node and rechecks native lease/origin.
    const element = await target.elementHandle();
    requireThat(element, 'auth_page_changed');
    try {
      requireThat((await element.evaluate((node) => node.tagName)) === 'INPUT', 'auth_input_invalid');
      unchanged(); await element.fill('');
      for (const character of packet.text) {
        await permit(); unchanged();
        await element.type(character, { delay: 60 });
      }
      return { ok: true };
    } finally { await element.dispose().catch(() => {}); }
  }
  if (packet.operation === 'click') {
    const label = (await target.innerText()).trim();
    requireThat(
      label.length <= 240 &&
        !/соглас|разреш|отправ|подпис|оплат|заказ|удал|восстанов|accept|consent|submit|pay|delete/i.test(
          label,
        ),
      'manual_confirmation_required',
    );
    if (packet.expectedLabel !== undefined) requireThat(label === packet.expectedLabel, 'auth_page_changed');
    // Keep the same document/node through dispatch. A locator retry after a
    // callback could otherwise find a similarly named button on the site.
    const element = await target.elementHandle();
    requireThat(element, 'auth_page_changed');
    try {
      requireThat((await element.innerText()).trim() === label, 'auth_page_changed');
      await permit(); unchanged();
      await element.click();
      return { ok: true };
    } finally { await element.dispose().catch(() => {}); }
  }
  throw new RuntimeError('auth_operation_invalid');
}
