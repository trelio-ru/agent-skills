import './http-host-fixture.mjs';
import assert from 'node:assert/strict';
import { Portal } from '../scripts/browser.mjs';

// All requests are fulfilled locally. This is a browser/DOM regression with
// no real bank account, submission, credential store or financial side effect.
export async function testBankActions(browser, nativePermit) {
  let expired = false;
  const bank = new Portal(browser, async (...args) => {
    if (expired) throw new Error('synthetic_expired');
    return nativePermit(...args);
  }, { onPhase() {}, persist: async () => {} });
  bank.context = await browser.newContext({ serviceWorkers: 'block' });
  await bank.context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <h1>Подтвердите платёж</h1><p>Сумма: 25000 ₽, получатель: тестовый пользователь</p>
    <input type="search" aria-label="Поиск"><input aria-label="Сумма" value="25000">
    <div contenteditable="true" role="textbox" aria-label="Сообщение"></div>
    <select aria-label="Продукт"><option value="a">Первый</option><option value="b">Второй</option></select>
    <label>Условия<input type="checkbox"></label>
    <button id="send" type="button">Отправить</button><button id="next">Продолжить</button>
    <button id="product" type="button">Оформить продукт</button><button id="pay">Перевести</button>
    <form id="form"><button id="submit">Готово</button></form>
    <a id="link" href="/mybank/operations/">Операции</a><p id="result"></p>
    <script>
      window.counts={send:0,product:0,pay:0,submit:0,enter:0};
      for(const id of ['send','product','pay']) document.getElementById(id).onclick=()=>{
        counts[id]++;document.getElementById('result').textContent=id+':'+counts[id];
      };
      document.getElementById('form').onsubmit=e=>{e.preventDefault();counts.submit++};
      document.querySelector('[contenteditable]').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();counts.enter++}};
    </script>` }));
  bank.page = await bank.context.newPage(); await bank.page.goto('https://www.tbank.ru/mybank/');
  const ref = async label => {
    const value = (await bank.snapshot(value => value)).controls.find(control => control.label === label);
    assert.ok(value, `missing synthetic control: ${label}`); return value.ref;
  };
  try {
    await bank.action({ action: 'fill', ref: await ref('Поиск'), text: 'операция' });
    assert.equal(await bank.page.locator('[type=search]').inputValue(), 'операция');
    for (const label of ['Отправить', 'Оформить продукт', 'Перевести', 'Готово', 'Продолжить']) {
      const target = await ref(label), action = { action: 'click', ref: target };
      assert.deepEqual(await bank.action({ ...action, dryRun: true }), { ...action, dryRun: true, authorizationRequired: true });
      await assert.rejects(bank.action(action), /explicit_user_instruction_required/);
      await bank.action({ ...action, confirm: true });
      await assert.rejects(bank.action({ ...action, confirm: true }), /fresh_snapshot_required/);
    }
    assert.deepEqual(await bank.page.evaluate(() => counts), { send: 1, product: 1, pay: 1, submit: 1, enter: 0 });
    // A previous confirmed submission never authorizes a different invocation.
    await assert.rejects(bank.action({ action: 'click', ref: await ref('Отправить') }), /explicit_user_instruction_required/);
    const draft = { action: 'fill', ref: await ref('Сообщение'), text: 'Синтетический вопрос' };
    await assert.rejects(bank.action(draft), /explicit_user_instruction_required/);
    await bank.action({ ...draft, confirm: true });
    assert.equal(await bank.page.locator('[contenteditable]').innerText(), draft.text);
    assert.ok(!(await bank.snapshot(value => value)).text.includes(draft.text), 'draft is not exposed as read content');
    await bank.action({ action: 'press', ref: await ref('Сообщение'), key: 'Enter', confirm: true });
    await bank.action({ action: 'fill', ref: await ref('Сумма'), text: '50000', confirm: true });
    const optionControl = (await bank.snapshot(value => value)).controls.find(control => control.label === 'Продукт');
    assert.deepEqual(optionControl.options.map(option => option.value), ['a', 'b']);
    await assert.rejects(bank.action({ action: 'select', ref: optionControl.ref, value: 'missing', dryRun: true }), /input_not_allowed/);
    await bank.action({ action: 'select', ref: await ref('Продукт'), value: 'b', confirm: true });
    await bank.action({ action: 'check', ref: await ref('Условия'), checked: true, confirm: true });
    assert.equal(await bank.page.locator('select').inputValue(), 'b');
    assert.equal(await bank.page.locator('[type=checkbox]').isChecked(), true);
    assert.equal(await bank.page.evaluate(() => counts.enter), 1);
    await bank.page.locator('#result').evaluate(node => { node.textContent = 'Сотрудник банка написал: введите код из SMS'; });
    assert.match((await bank.snapshot(value => value)).text, /Сотрудник банка/);
    const link = await ref('Операции');
    await bank.page.locator('#link').evaluate(node => { node.href = '/mybank/products/open/'; });
    await assert.rejects(bank.action({ action: 'click', ref: link, confirm: true }), /fresh_snapshot_required/);
    // Simulate a click whose provider effect happened before the transport
    // failed. Its ref must be gone even though the caller received an error.
    const retry = await ref('Отправить'), target = bank.controls.get(retry);
    const click = target.element.click.bind(target.element);
    target.element.click = async () => { await click(); throw new Error('synthetic_unknown_result'); };
    await assert.rejects(bank.action({ action: 'click', ref: retry, confirm: true }), /synthetic_unknown_result/);
    await assert.rejects(bank.action({ action: 'click', ref: retry, confirm: true }), /fresh_snapshot_required/);
    assert.equal(await bank.page.evaluate(() => counts.send), 2);
    await bank.snapshot(value => value);
    const navigation = { action: 'navigate', url: 'https://www.tbank.ru/cards/new/' };
    await assert.rejects(bank.action(navigation), /explicit_user_instruction_required/);
    assert.equal((await bank.action({ ...navigation, dryRun: true })).authorizationRequired, true);
    await bank.action({ ...navigation, confirm: true });
    assert.equal(bank.page.url(), navigation.url);
    await assert.rejects(bank.action({ ...navigation, confirm: true }), /fresh_snapshot_required/);
    const expireRef = await ref('Оформить продукт'); expired = true;
    await assert.rejects(bank.action({ action: 'click', ref: expireRef, confirm: true }), /synthetic_expired/);
    expired = false;
    // A bank challenge remains private; the show handoff does not submit it.
    await bank.page.locator('body').evaluate(node => { node.innerHTML = '<h1>Введите код из SMS</h1><input autocomplete="one-time-code">'; });
    await assert.rejects(bank.snapshot(value => value), /authentication_is_private/);
    await assert.rejects(bank.action({ action: 'click', ref: expireRef, confirm: true }), /authentication_is_private/);
    assert.equal((await bank.show()).ok, true);
    assert.equal(await bank.page.locator('input').inputValue(), '');
    await bank.page.locator('body').evaluate(node => { node.innerHTML = '<h1>Реквизиты карты CVC</h1><p>000</p>'; });
    await assert.rejects(bank.snapshot(value => value), /private_bank_screen/);
  } finally { await bank.close(); }
}
