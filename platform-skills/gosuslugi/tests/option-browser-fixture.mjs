import assert from 'node:assert/strict';

// Match the observed POS React Select structure rather than assuming its live
// announcement means role=combobox/option is present. All requests are synthetic.
const markup = `<!doctype html><html lang="ru"><body>
<form id="appeal"><label for="react-select-2-input">Ваш регион</label>
<div class="basic-multi-select form-control appeal-region">
  <div class="select__control"><div class="select__value-container"><div class="select__input">
    <input id="react-select-2-input" autocomplete="off">
  </div><div class="select__single-value"></div></div></div>
  <div class="select__menu" hidden><div class="select__menu-list"><div class="scrollbar-container ui-cr-custom-scrollBar"><div class="ui-cr-custom-scrollBar__inner">
    <div id="react-select-2-option-28" class="select__option select__option--is-focused">Ленинградская область</div>
    <div id="react-select-2-option-29" class="select__option select__option--is-disabled">Недоступный регион</div>
  </div></div></div></div>
</div>
<div id="react-select-8-option-0" class="select__option">Посторонний вариант</div>
<label for="category">Категория</label><input id="category" role="combobox" aria-expanded="true" aria-controls="categories">
<div id="categories" role="listbox"><div role="option" id="road">Автомобильные дороги</div>
<div role="option" aria-disabled="true">Недоступная категория</div>
<div role="option" id="danger">Подтвердить отправку</div></div>
<div role="option">Вне списка</div><p id="selected-category"></p>
<button type="button" id="outside">Продолжить заполнение</button><button type="submit">Войти через Госуслуги</button>
</form><script>
window.submissions=0;
document.querySelector('#appeal').onsubmit=e=>{e.preventDefault();window.submissions++};
const input=document.querySelector('#react-select-2-input'), control=document.querySelector('.select__control'), menu=document.querySelector('.select__menu');
input.oninput=()=>{menu.hidden=false;control.classList.add('select__control--menu-is-open')};
input.onblur=()=>{input.value=''};
menu.onmousedown=e=>e.preventDefault();
document.querySelector('#react-select-2-option-28').onclick=e=>{
  document.querySelector('.select__single-value').textContent=e.currentTarget.textContent;
  input.value='';menu.hidden=true;control.classList.remove('select__control--menu-is-open');
};
document.querySelector('#road').onclick=e=>document.querySelector('#selected-category').textContent=e.currentTarget.textContent;
document.querySelector('#danger').onclick=()=>window.submissions++;
</script></body></html>`;

// The portal constructor owns the semantics through roles even when its
// listbox has no ID or explicit ARIA linkage. Use unrelated wrappers and
// arbitrary labels to verify that the implementation does not depend on the
// particular category, form number or a generated CSS class.
const portalLookupMarkup = `<!doctype html><html lang="ru"><body><main>
<form id="service">
  <section id="lookup"><label for="filter">Категория</label>
    <div><input id="filter" role="combobox" aria-expanded="false"></div>
    <aside><div role="listbox" hidden>
      <div role="option" id="choice"><span>Обращение</span></div>
      <div role="option" aria-disabled="true">Недоступный вариант</div>
      <div role="option" id="danger">Подтвердить отправку</div>
    </div></aside>
  </section>
  <div role="listbox"><div role="option">Посторонний список</div></div>
  <button id="continue" type="button">Продолжить</button>
  <button type="submit">Отправить заявление</button>
  <output></output>
</form>
</main><script>
window.submissions=0;
const form=document.querySelector('#service'), input=document.querySelector('#filter');
const list=document.querySelector('#lookup [role=listbox]');
form.onsubmit=e=>{e.preventDefault();window.submissions++};
input.onclick=()=>{list.hidden=false;input.setAttribute('aria-expanded','true')};
document.querySelector('#choice').onclick=e=>{
  input.value=e.currentTarget.textContent;
  list.hidden=true;input.setAttribute('aria-expanded','false');
};
document.querySelector('#continue').onclick=()=>document.querySelector('output').textContent=input.value;
document.querySelector('#danger').onclick=()=>window.submissions++;
</script></body></html>`;

async function portalLookupSmoke(portal, snapshot, find) {
  const route = 'https://www.gosuslugi.ru/**';
  await portal.page.route(route, request => request.fulfill({ contentType: 'text/html; charset=utf-8', body: portalLookupMarkup }));
  const open = (path = '/712345/2/form') => portal.page.goto(`https://www.gosuslugi.ru${path}`);
  const startLookup = async () => portal.action({ action: 'click', ref: find(await snapshot(), 'Категория').ref });
  const isOption = (state, label) => state.controls.some(control => control.label === label && control.role === 'option');
  try {
    await open();
    assert.equal(isOption(await snapshot(), 'Обращение'), false, 'the closed constructor list exposes no options');
    await startLookup();
    let state = await snapshot();
    for (const label of ['Посторонний список', 'Недоступный вариант']) assert.equal(isOption(state, label), false, label);
    await assert.rejects(portal.action({ action: 'click', ref: find(state, 'Подтвердить отправку').ref }), /manual_confirmation_required/);
    const choice = find(state, 'Обращение');
    assert.equal(choice.role, 'option');
    await portal.action({ action: 'click', ref: choice.ref });
    await assert.rejects(portal.action({ action: 'click', ref: choice.ref }), /fresh_snapshot_required/);
    state = await snapshot();
    await portal.action({ action: 'click', ref: find(state, 'Продолжить').ref });
    assert.equal(await portal.page.locator('output').textContent(), 'Обращение');
    assert.equal(await portal.page.evaluate(() => window.submissions), 0);

    for (const variant of ['another-owner', 'another-list', 'conflicting-aria', 'closed', 'readonly', 'moved-widget']) {
      await open(); await startLookup();
      const old = find(await snapshot(), 'Обращение');
      await portal.page.evaluate(kind => {
        const box = document.querySelector('#lookup'), input = box.querySelector('input');
        if (kind === 'another-owner') {
          const other = input.cloneNode(true); other.removeAttribute('id'); box.append(other);
        }
        if (kind === 'another-list') box.append(document.querySelector('#service > [role=listbox]'));
        if (kind === 'conflicting-aria') input.setAttribute('aria-controls', 'unrelated-list');
        if (kind === 'closed') input.setAttribute('aria-expanded', 'false');
        if (kind === 'readonly') input.readOnly = true;
        if (kind === 'moved-widget') {
          const replacement = box.cloneNode(false);
          replacement.append(...box.childNodes); box.replaceWith(replacement);
        }
      }, variant);
      await assert.rejects(portal.action({ action: 'click', ref: old.ref }), /fresh_snapshot_required/, variant);
      assert.equal(await portal.page.locator('#filter').inputValue(), '', variant);
      assert.equal(isOption(await snapshot(), 'Обращение'), variant === 'moved-widget', variant);
    }
    await open('/help');
    await startLookup();
    assert.equal(isOption(await snapshot(), 'Обращение'), false, 'the fallback is confined to portal forms');
  } finally {
    await portal.page.unroute(route);
  }
}

export async function optionBrowserSmoke(portal) {
  await portal.page.route('https://pos.gosuslugi.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: markup }));
  const open = async () => portal.page.goto('https://pos.gosuslugi.ru/form/?opaId=223643&fz59=false');
  const snapshot = () => portal.snapshot(value => value);
  const find = (state, label) => { const target = state.controls.find(control => control.label === label); assert.ok(target, `missing control ${label}`); return target; };
  const region = async () => {
    const before = await snapshot();
    await portal.action({ action: 'fill', ref: find(before, 'Ваш регион').ref, text: 'Ленинградская область' });
    return find(await snapshot(), 'Ленинградская область');
  };
  await open();
  const before = await snapshot();
  assert.equal(before.controls.some(control => control.label === 'Ленинградская область'), false, 'closed menu gives no option references');
  const choice = await region();
  assert.equal(choice.role, 'option');
  await portal.action({ action: 'click', ref: choice.ref });
  await assert.rejects(portal.action({ action: 'click', ref: choice.ref }), /fresh_snapshot_required/);
  await portal.action({ action: 'click', ref: find(await snapshot(), 'Продолжить заполнение').ref });
  assert.equal(await portal.page.locator('.select__single-value').textContent(), 'Ленинградская область', 'selection survives blur; typing alone does not commit React Select');

  // Standard ARIA choices must belong to one open combobox/listbox. A disabled
  // or unowned option cannot become a new generic click surface.
  let state = await snapshot();
  for (const label of ['Недоступный регион', 'Посторонний вариант', 'Недоступная категория', 'Вне списка'])
    assert.equal(state.controls.some(control => control.label === label), false, label);
  await portal.action({ action: 'click', ref: find(state, 'Автомобильные дороги').ref });
  assert.equal(await portal.page.locator('#selected-category').textContent(), 'Автомобильные дороги');
  state = await snapshot();
  await assert.rejects(portal.action({ action: 'click', ref: find(state, 'Подтвердить отправку').ref }), /manual_confirmation_required/);
  assert.equal(await portal.page.evaluate(() => window.submissions), 0, 'choosing a field value never presses Enter or submits');

  for (const mutation of ['label', 'owner', 'closed', 'disabled', 'replacement', 'reparent']) {
    await open(); const old = await region();
    await portal.page.evaluate(kind => {
      const option = document.querySelector('#react-select-2-option-28');
      if (kind === 'label') option.textContent = 'Другая область';
      if (kind === 'owner') document.querySelector('#react-select-2-input').id = 'react-select-3-input';
      if (kind === 'closed') document.querySelector('.select__control').classList.remove('select__control--menu-is-open');
      if (kind === 'disabled') option.setAttribute('aria-disabled', 'true');
      if (kind === 'replacement') option.replaceWith(option.cloneNode(true));
      if (kind === 'reparent') {
        const list = document.querySelector('.select__menu'), replacement = list.cloneNode(true);
        replacement.querySelector('#react-select-2-option-28').replaceWith(option);
        list.replaceWith(replacement);
      }
    }, mutation);
    await assert.rejects(portal.action({ action: 'click', ref: old.ref }), /fresh_snapshot_required/, mutation);
    assert.equal(await portal.page.locator('.select__single-value').textContent(), '');
  }
  await open();
  const aria = find(await snapshot(), 'Автомобильные дороги');
  await portal.page.locator('#category').evaluate(node => node.setAttribute('aria-expanded', 'false'));
  await assert.rejects(portal.action({ action: 'click', ref: aria.ref }), /fresh_snapshot_required/);
  assert.equal((await snapshot()).controls.some(control => control.label === 'Автомобильные дороги'), false);
  await portal.page.unroute('https://pos.gosuslugi.ru/**');
  await portalLookupSmoke(portal, snapshot, find);
}
