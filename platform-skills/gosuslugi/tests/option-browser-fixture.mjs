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
}
