import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// The public sf-portal-st/main.ba6704cc9f35425f.js uses Quill 2.0.3 inside
// epgu-cf-ui-html-input, with a .ql-editor editing host and text-change/form
// synchronization. Use that real editor version rather than a textarea mock.
// Only synthetic text and intercepted requests are involved in this fixture.
const quillDirectory = new URL('fixtures/quill/node_modules/quill/dist/', import.meta.url);
const url = 'https://www.gosuslugi.ru/600367/1/form';
const markup = `<!doctype html><html lang="ru"><head>
<link rel="stylesheet" href="/fixture/quill.core.css"><style>.ql-editor{min-height:80px}</style></head><body><main>
<h1>Напишите ходатайство</h1><p id="limit">Не более 9000 символов</p>
<form id="petition"><epgu-cf-ui-html-input><div class="html-input"><div id="editor" class="editor-content"></div></div></epgu-cf-ui-html-input>
<button type="button" id="continue" disabled>Продолжить</button></form>
</main><script src="/fixture/quill.js"></script><script>
window.editor=new Quill('#editor',{modules:{toolbar:false},placeholder:'Текст ходатайства'});
window.submissions=0;window.inputEvents=0;window.formValue='';
const sync=()=>{window.formValue=editor.root.innerHTML;window.formText=editor.getText();
document.querySelector('#continue').disabled=editor.getLength()<=1||editor.getLength()-1>9000};
editor.on('text-change',(_delta,_old,source)=>{if(source==='user')window.inputEvents++;sync()});
const saved=sessionStorage.getItem('synthetic-petition');if(saved)editor.setContents(editor.clipboard.convert({html:saved}),'silent');sync();
document.querySelector('#petition').onsubmit=event=>{event.preventDefault();window.submissions++};
document.querySelector('#continue').onclick=()=>{
  sessionStorage.setItem('synthetic-petition',window.formValue);
  const text=window.formText;document.querySelector('main').innerHTML='<h1>Проверьте ходатайство</h1><p id="review"></p><button type="button" id="send">Отправить</button>';
  document.querySelector('#review').textContent=text;document.querySelector('#send').onclick=()=>window.submissions++;
};
</script></body></html>`;

export async function richTextBrowserSmoke(portal) {
  const [script, css] = await Promise.all(['quill.js', 'quill.core.css'].map(name => fs.readFile(new URL(name, quillDirectory), 'utf8')));
  const intercept = route => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill(pathname === '/fixture/quill.js' ? { contentType: 'application/javascript', body: script }
      : pathname === '/fixture/quill.core.css' ? { contentType: 'text/css', body: css }
        : { contentType: 'text/html; charset=utf-8', body: markup });
  };
  await portal.page.route('**/*', intercept);
  const open = async () => {
    await portal.page.goto(url);
    await portal.page.locator('.ql-editor').waitFor();
  };
  const snapshot = () => portal.snapshot(value => value);
  const editor = async () => {
    const state = await snapshot();
    const fields = state.controls.filter(control => control.type === 'contenteditable');
    assert.equal(fields.length, 1);
    assert.equal(fields[0].label, 'Текст ходатайства');
    assert.equal(fields[0].role, 'textbox');
    assert.equal('binding' in fields[0], false);
    return fields[0].ref;
  };
  try {
    await open();
    const text = 'Первый абзац\n\nВторой абзац\n<em>Буквальный текст</em> 🧾';
    const ref = await editor();
    const result = await portal.action({ action: 'fill', ref, text });
    assert.deepEqual(result, { inputVerified: true });
    await assert.rejects(portal.action({ action: 'fill', ref, text }), /fresh_snapshot_required/);
    assert.equal(await portal.page.evaluate(() => editor.getText()), text + '\n', 'real Quill retains every paragraph');
    assert.equal(await portal.page.evaluate(() => window.formText), text + '\n', 'the form model receives the editor change');
    assert.ok(await portal.page.evaluate(() => window.inputEvents > 0), 'native input triggers Quill user text-change');
    assert.equal(await portal.page.locator('.ql-editor em').count(), 0, 'caller text is never interpreted as HTML');
    const state = await snapshot();
    assert.ok(!JSON.stringify(state).includes('Буквальный текст'), 'snapshots must not expose existing editor contents');
    const next = state.controls.find(control => control.label === 'Продолжить');
    assert.equal(await portal.page.locator('#continue').isEnabled(), true);
    await portal.action({ action: 'click', ref: next.ref });
    assert.equal(await portal.page.locator('#review').textContent(), text + '\n');
    const send = (await snapshot()).controls.find(control => control.label === 'Отправить');
    await assert.rejects(portal.action({ action: 'click', ref: send.ref }), /manual_confirmation_required/);
    assert.equal(await portal.page.evaluate(() => window.submissions), 0);
    await open();
    assert.equal(await portal.page.evaluate(() => editor.getText()), text + '\n', 'the synthetic restored draft contains the committed form model');

    // Empty, boundary-sized, CRLF and whitespace-only values all go through
    // native fill and exact private read-back; no HTML or editor API writes.
    for (const value of ['', 'Одна строка', 'Последняя строка\n', 'Строка\r\n\r\nЕщё строка', ' \n\n ', 'я'.repeat(9000)]) {
      await portal.action({ action: 'fill', ref: await editor(), text: value });
      assert.equal(await portal.page.evaluate(() => editor.getText()), value.replace(/\r\n?/g, '\n') + '\n');
    }
    assert.equal(await portal.page.locator('#continue').isEnabled(), true, 'the actual editor accepts the 9000-character boundary');
    await portal.action({ action: 'fill', ref: await editor(), text: 'я'.repeat(9001) });
    assert.equal(await portal.page.locator('#continue').isEnabled(), false, 'verified input never bypasses native form validation');
    const inputs = await portal.page.evaluate(() => window.inputEvents);
    await assert.rejects(portal.action({ action: 'fill', ref: await editor(), text: 'я'.repeat(10001) }), /input_not_allowed/);
    assert.equal(await portal.page.evaluate(() => window.inputEvents), inputs, 'transport limit rejects before input');

    for (const mutation of ['readonly', 'aria-readonly', 'disabled', 'hidden', 'label', 'replacement', 'reparent']) {
      await open();
      const old = await editor();
      await portal.page.evaluate(kind => {
        const root = document.querySelector('.ql-editor');
        if (kind === 'readonly') root.contentEditable = 'false';
        if (kind === 'aria-readonly') root.setAttribute('aria-readonly', 'true');
        if (kind === 'disabled') root.setAttribute('aria-disabled', 'true');
        if (kind === 'hidden') root.hidden = true;
        if (kind === 'label') root.setAttribute('aria-label', 'Другой редактор');
        if (kind === 'replacement') root.replaceWith(root.cloneNode(true));
        if (kind === 'reparent') {
          const owner = document.querySelector('.ql-container'), replacement = owner.cloneNode(true);
          replacement.querySelector('.ql-editor').replaceWith(root);owner.replaceWith(replacement);
        }
      }, mutation);
      await assert.rejects(portal.action({ action: 'fill', ref: old, text: 'Не вводить' }), /fresh_snapshot_required/, mutation);
      assert.equal(await portal.page.evaluate(() => window.inputEvents), 0, mutation);
    }

    await open();
    await portal.page.locator('.ql-editor').evaluate(root => {
      root.setAttribute('aria-labelledby', 'editor-label');
      const label=document.createElement('label');label.id='editor-label';label.textContent='Текст ходатайства';root.before(label);
      root.insertAdjacentHTML('beforeend', '<span contenteditable="true">Вложенный</span><span contenteditable="false">Только чтение</span>');
    });
    assert.equal((await snapshot()).controls.filter(control => control.type === 'contenteditable').length, 1, 'only the real editing host is a field');

    // A plain editing host shares the fill API. An asynchronous rewrite must
    // not be reported as a verified fill or trigger another input attempt.
    await portal.page.locator('main').evaluate(main => {
      main.innerHTML='<div contenteditable="true" aria-label="Обычный редактор"></div>';
      const input=main.firstElementChild;window.plainInputs=0;
      input.oninput=()=>{window.plainInputs++;input.textContent='Изменено сайтом'};
    });
    const plain = (await snapshot()).controls.find(control => control.type === 'contenteditable');
    await assert.rejects(portal.action({ action: 'fill', ref: plain.ref, text: 'Исходный текст' }), /input_result_unverified/);
    assert.equal(await portal.page.evaluate(() => window.plainInputs), 1, 'verification never repeats input');
    await assert.rejects(portal.action({ action: 'fill', ref: plain.ref, text: 'Исходный текст' }), /fresh_snapshot_required/);
    await portal.page.locator('main').evaluate(main => {
      main.innerHTML='<div contenteditable="plaintext-only" aria-label="Обычный редактор"></div>';
    });
    const freshPlain = (await snapshot()).controls.find(control => control.type === 'contenteditable');
    assert.deepEqual(await portal.action({ action: 'fill', ref: freshPlain.ref, text: 'Обычный текст\nНовая строка' }), { inputVerified: true });
    await portal.page.locator('main').evaluate(main => {
      main.innerHTML='<div contenteditable="true" aria-label="Обычный редактор">'+
        '<a href="/help">Содержимое ходатайства в ссылке</a><button>Содержимое ходатайства в кнопке</button>'+
        '<span contenteditable="false"><a href="/help">Содержимое readonly-вставки</a></span></div>';
    });
    const privateContent = await snapshot();
    assert.equal(privateContent.controls.length, 1, 'editor children are never independent navigation controls');
    assert.doesNotMatch(JSON.stringify(privateContent), /Содержимое/, 'restored links and readonly islands cannot leak through control labels');
    await portal.page.locator('main').evaluate(main => {
      const root=main.firstElementChild, label=root.querySelector('[contenteditable="false"]');
      label.id='private-label';root.removeAttribute('aria-label');root.setAttribute('aria-labelledby',label.id);
    });
    assert.equal((await snapshot()).controls[0].label, 'Редактор текста', 'aria-labelledby cannot disclose a readonly island inside the editor');
    await portal.page.locator('main').evaluate(main => main.firstElementChild.setAttribute('role', 'button'));
    assert.equal((await snapshot()).controls.length, 0, 'a clickable mixed container is neither an editor nor a safe content label');
    await portal.page.locator('main').evaluate(main => {
      main.innerHTML='<div contenteditable="true" aria-label="Password"></div><div contenteditable="false">Не редактируется</div>';
    });
    assert.equal((await snapshot()).controls.some(control => control.type === 'contenteditable'), false, 'secret-labelled and readonly hosts have no refs');
    await portal.page.locator('main').evaluate(main => {
      main.innerHTML='<label for="native-text">Текст поля</label><input id="native-text">';
      const field=main.querySelector('input');field.pattern='[A-Za-z —]+';field.maxLength=40;
      window.nativeInputs=0;field.oninput=()=>window.nativeInputs++;
    });
    const native = (await snapshot()).controls.find(control => control.tag === 'input');
    assert.deepEqual(native.inputConstraints, { pattern: '[A-Za-z —]+', maxLength: 40 });
    await assert.rejects(portal.action({ action: 'fill', ref: native.ref, text: 'Text – text' }), /input_pattern_rejected/);
    assert.equal(await portal.page.evaluate(() => window.nativeInputs), 0, 'unsupported punctuation is rejected before touching the real field');
    await portal.action({ action: 'fill', ref: native.ref, text: 'Text — text' });
    assert.equal(await portal.page.locator('#native-text').inputValue(), 'Text — text', 'the same unchanged ref permits a corrected, not-yet-dispatched input');
    const changed = (await snapshot()).controls.find(control => control.tag === 'input');
    await portal.page.locator('#native-text').evaluate(node => node.maxLength=5);
    await assert.rejects(portal.action({ action: 'fill', ref: changed.ref, text: 'ABC' }), /fresh_snapshot_required/);
    const limited = (await snapshot()).controls.find(control => control.tag === 'input');
    const events=await portal.page.evaluate(() => window.nativeInputs);
    await assert.rejects(portal.action({ action: 'fill', ref: limited.ref, text: 'ABCDEF' }), /input_length_rejected/);
    assert.equal(await portal.page.evaluate(() => window.nativeInputs), events);
    await portal.action({ action: 'fill', ref: limited.ref, text: 'ABC' });
    await portal.page.goto('https://esia.gosuslugi.ru/login/');
    await assert.rejects(snapshot(), /authentication_is_private/, 'adding editing hosts cannot expose an auth document');
  } finally {
    await portal.page.unroute('**/*', intercept);
  }
}
