import assert from 'node:assert/strict';

const category = 'Подать ходатайство или объяснение';
const formUrl = 'https://www.gosuslugi.ru/600367/1/form';
// Public category wording only. No real account, case, applicant or submission
// is involved: every request and every effect belongs to this synthetic page.
const markup = `<!doctype html><html lang="ru"><body><main>
<h1>Выберите категорию обращения</h1><section id="choices">
<button type="button" id="category">${category}</button><button type="button">Иное</button>
</section></main><script>
window.selections=0;window.submissions=0;
document.querySelector('#category').onclick=()=>{
  window.selections++;
  document.querySelector('main').innerHTML='<h1>Текст обращения</h1><label>Обращение<textarea></textarea></label>'+
    '<button type="button" id="same-label">${category}</button>'+
    '<button type="button" id="send">Отправить заявление</button>'+
    '<button type="submit" id="submit">Далее</button>';
  for(const button of document.querySelectorAll('button'))button.onclick=()=>window.submissions++;
};
</script></body></html>`;

export async function petitionCategoryBrowserSmoke(portal) {
  const intercept = route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: markup });
  await portal.page.route('**/*', intercept);
  const open = (url = formUrl) => portal.page.goto(url);
  const snapshot = () => portal.snapshot(value => value);
  const choice = async () => {
    const state = await snapshot();
    const control = state.controls.find(item => item.label === category);
    assert.ok(control, 'category remains a normal snapshot control');
    assert.equal('binding' in control, false, 'private screen binding must not leave the browser adapter');
    return control.ref;
  };
  try {
    await open();
    const ref = await choice();
    await portal.action({ action: 'click', ref });
    assert.equal(await portal.page.evaluate(() => window.selections), 1);
    await assert.rejects(portal.action({ action: 'click', ref }), /fresh_snapshot_required/);
    const state = await snapshot();
    await portal.action({ action: 'fill', ref: state.controls.find(item => item.tag === 'textarea').ref, text: 'Синтетическое обращение' });
    assert.equal(await portal.page.locator('textarea').inputValue(), 'Синтетическое обращение');
    for (const label of [category, 'Отправить заявление', 'Далее']) {
      const control = (await snapshot()).controls.find(item => item.label === label);
      await assert.rejects(portal.action({ action: 'click', ref: control.ref }), /manual_confirmation_required/);
    }
    assert.equal(await portal.page.evaluate(() => window.submissions), 0, 'category selection and filling never submit');

    // The exception is not an allowlist for this label on every portal page.
    for (const url of ['https://www.gosuslugi.ru/600352/1/form', 'https://pos.gosuslugi.ru/form/']) {
      await open(url);
      await assert.rejects(portal.action({ action: 'click', ref: await choice() }), /manual_confirmation_required/);
      assert.equal(await portal.page.evaluate(() => window.selections), 0);
    }
    for (const mutation of ['label', 'submit', 'implicit-submit', 'field', 'duplicate', 'disabled', 'hidden', 'screen', 'reparent']) {
      await open();
      const old = await choice();
      await portal.page.evaluate(kind => {
        const button = document.querySelector('#category');
        if (kind === 'label') button.textContent += ' и отправить';
        if (kind === 'submit') button.type = 'submit';
        if (kind === 'implicit-submit') button.removeAttribute('type');
        if (kind === 'field') document.querySelector('main').insertAdjacentHTML('beforeend', '<textarea></textarea>');
        if (kind === 'duplicate') button.after(button.cloneNode(true));
        if (kind === 'disabled') button.disabled = true;
        if (kind === 'hidden') button.hidden = true;
        if (kind === 'screen') document.querySelector('h1').textContent = 'Проверьте заявление перед отправкой';
        if (kind === 'reparent') {
          const main = document.querySelector('main'), replacement = main.cloneNode(true);
          replacement.querySelector('#category').replaceWith(button);main.replaceWith(replacement);
        }
      }, mutation);
      await assert.rejects(portal.action({ action: 'click', ref: old }), /fresh_snapshot_required/, mutation);
      assert.equal(await portal.page.evaluate(() => window.selections), 0, mutation);
    }
    // A fresh snapshot must also reject native submit buttons and text fields;
    // invalidating an old reference alone is not enough to preserve that gate.
    for (const fragment of ['<textarea></textarea>', '<input>', '<input type="checkbox">', '<select><option>Выбор</option></select>', '<div contenteditable="true">Текст</div>']) {
      await open();
      await portal.page.locator('main').evaluate((node, html) => node.insertAdjacentHTML('beforeend', html), fragment);
      await assert.rejects(portal.action({ action: 'click', ref: await choice() }), /manual_confirmation_required/);
    }
    for (const type of ['submit', 'image', '']) {
      await open();
      await portal.page.locator('#category').evaluate((node, value) => value ? node.setAttribute('type', value) : node.removeAttribute('type'), type);
      await assert.rejects(portal.action({ action: 'click', ref: await choice() }), /manual_confirmation_required/);
    }
    await open();
    await portal.page.evaluate(() => {
      const form = document.createElement('form');
      document.querySelector('#choices').append(form);
      form.append(document.querySelector('#category'));
      document.querySelector('main').insertAdjacentHTML('beforeend', '<textarea></textarea>');
    });
    await assert.rejects(portal.action({ action: 'click', ref: await choice() }), /manual_confirmation_required/,
      'a nested empty form must not hide fields elsewhere on the same screen');
  } finally {
    await portal.page.unroute('**/*', intercept);
  }
}
