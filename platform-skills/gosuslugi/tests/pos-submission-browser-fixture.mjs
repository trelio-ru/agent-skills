import assert from 'node:assert/strict';
import { createPosSubmissionFlow } from '../scripts/pos-submission.mjs';

// Use the actual production observer, browser events, native checkbox, selected
// Files and widget DOM structure. Only ESIA's separately tested promises and
// provider network are synthetic. A plain mocked Page cannot test these paths.
export async function testPosSubmission(browser) {
  for (const [status, rejectUpload] of [[200, false], [503, false], [200, true]]) {
    const context = await browser.newContext();
    try {
      let creates = 0, auths = 0, returned = false, uploading = 0, maxUploading = 0, uploads = 0;
      let changeDuringSetup, helpersClosed = 0;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/form/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
          <textarea id="description">Synthetic reviewed statement</textarea><input type="file" multiple>
          <input type="checkbox" id="check-agree" readonly style="display:none"><label for="check-agree">Я соглашаюсь с правилами подачи сообщений и обращений</label>
          <div class="fz-accordion"><div class="accordion__summary">Порядок рассмотрения</div><div class="accordion__content" hidden>
          <input type="checkbox" id="check-requestedFederalLawType" readonly style="display:none"><label for="check-requestedFederalLawType">Подать обращение по 59-ФЗ</label></div></div>
          <div class="basic-multi-select"><input id="react-select-2-input"><span class="select__single-value"></span><div class="select__menu"></div></div>
          <button class="esia-auth-button" disabled>Войти через Госуслуги</button>
          <div class="form-auth-overlay" hidden><button id="modal">Войти через </button></div>
          <script>
          const overlay=document.querySelector('.form-auth-overlay');
          const footer=document.querySelector('.esia-auth-button');
          const region=document.querySelector('.basic-multi-select');
          region.querySelector('input').oninput=()=>{
            region.querySelector('.select__menu').innerHTML='<div class="select__option" id="react-select-2-option-0">Wrong region</div><div class="select__option" id="react-select-2-option-1">Synthetic region (A+B)</div>';
            region.querySelectorAll('.select__option').forEach(node=>node.onclick=()=>{region.querySelector('.select__single-value').textContent=node.textContent;region.querySelector('.select__menu').innerHTML='';region.querySelector('input').value='';});
          };
          // Match the observed widget contract: a hidden readOnly input has
          // no state-changing input handler; the visible label owns it.
          // input.click() alone must therefore fail this regression.
          document.body.dataset.rulesClicks='0';
          document.body.dataset.entryClicks='0';
          document.querySelectorAll('input[type=checkbox]').forEach(input=>input.onclick=e=>e.preventDefault());
          document.querySelectorAll('label[for]').forEach(label=>label.onclick=e=>{
            e.preventDefault();const input=label.control;input.checked=!input.checked;
            if(input.id==='check-agree'){footer.disabled=!input.checked;document.body.dataset.rulesClicks=String(Number(document.body.dataset.rulesClicks)+1);}
          });
          document.querySelector('.accordion__summary').onclick=()=>document.querySelector('.accordion__content').hidden=false;
          footer.onclick=()=>{document.body.dataset.entryClicks=String(Number(document.body.dataset.entryClicks)+1);overlay.hidden=false;};
          document.querySelector('#modal').onclick=()=>document.body.dataset.authStarted='yes';
          window.syntheticReturn=async()=>{
            await fetch('/user-service/esia/esia-token');await fetch('/user-service/esia/get-user-info');
            overlay.innerHTML='<button id="personal">Synthetic name, Частное лицо</button>';
            document.querySelector('#personal').onclick=async()=>{
              document.querySelector('#personal').disabled=true;
              // The real widget derives one concurrent upload from EACH
              // selected File. Keep that relationship in this fixture so a
              // dropped/replaced attachment cannot pass a five-request test.
              try{await Promise.all([...document.querySelector('input[type=file]').files].map(file=>{
                const body=new FormData();body.append('file',file);
                return fetch('/inbox-service/filestorage',{method:'POST',body}).then(response=>{if(!response.ok)throw Error('synthetic-upload-rejected');});
              }));}
              catch{overlay.hidden=true;return;}
              const response=await fetch('/inbox-service/appeals',{method:'POST',body:'synthetic'});
              overlay.hidden=true;
              if(response.ok)document.body.insertAdjacentHTML('beforeend',
                '<div class="feedback-text feedback-status">Отправлено</div><div class="feedback-text">Регистрационный номер: 123456789</div>');
            };
          };
          </script>` });
        if (url.pathname === '/inbox-service/filestorage') {
          uploads++; uploading++; maxUploading=Math.max(maxUploading,uploading);
          await new Promise(resolve=>setTimeout(resolve,75)); uploading--;
          return route.fulfill({ status:rejectUpload&&uploads===3?403:200,contentType:'application/json',body:'{"id":"synthetic-file"}' });
        }
        if (url.pathname === '/inbox-service/appeals') {
          creates++; return route.fulfill({ status, contentType: 'application/json', body: status === 200 ? '{"id":123456789}' : '{"private":"must never leave browser"}' });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      const page = await context.newPage(); await page.goto('https://pos.gosuslugi.ru/form/?opaId=123');
      const files = Array.from({ length: 5 }, (_, index) => ({ name: `synthetic-proof-${index + 1}.txt`,
        mimeType: 'text/plain', buffer: Buffer.from(`synthetic-${index + 1}`) }));
      await page.locator('input[type=file]').setInputFiles(files);
      const flow = createPosSubmissionFlow(page, { confirm: true }, {
        createAuthorization: async () => { auths++; await changeDuringSetup?.(); return { close: async () => { helpersClosed++; } }; },
        observeAuthorization: () => ({ snapshot: () => ({ phase: returned ? 'esia_callback_verified' : 'esia_request_pending' }) }),
      });
      await flow.select({inputId:'react-select-2-input',label:'Synthetic region (A+B)'});
      await flow.setFederalLaw({enabled:true});
      assert.equal(await page.locator('#check-requestedFederalLawType').isChecked(),true);
      const unapproved = await flow.review();
      assert.equal((await flow.start({ reviewed: unapproved.reviewId })).code, 'pos_submission_permission_required');
      assert.equal(await page.locator('#check-agree').isChecked(), false);
      assert.equal(await page.locator('body').getAttribute('data-rules-clicks'), '0');
      // An unknown consent caption is never covered by submission authority.
      // Correcting that preflight retains the SAME form and all five Files.
      const rules = page.locator('label[for="check-agree"]');
      await rules.evaluate(node => { node.textContent += ' и дополнительное неизвестное условие'; });
      const unknown = await flow.review();
      const refused = await flow.start({ reviewed: unknown.reviewId, confirmSubmission: true });
      assert.equal(refused.code, 'pos_choice_unsupported'); assert.equal(auths, 0);
      assert.equal(await page.locator('#check-agree').isChecked(), false);
      // A pre-checked unknown consent is just as unsupported. It must not
      // bypass validation simply because no label click would be necessary.
      await page.locator('#check-agree').evaluate(input => { input.checked = true; });
      assert.equal((await flow.start({ reviewed: unknown.reviewId, confirmSubmission: true })).code, 'pos_choice_unsupported');
      assert.equal(auths, 0);
      await page.locator('#check-agree').evaluate(input => { input.checked = false; });
      await rules.evaluate(node => { node.textContent = 'Я соглашаюсь с правилами подачи сообщений и обращений'; });
      // Both visible caption and linked conditions stay bound to the review
      // across the native helper await. Correct either in the SAME form; the
      // unused helper must close without a footer/login click or losing Files.
      changeDuringSetup = () => rules.evaluate(node => { node.textContent += ' changed'; });
      const beforeSetup = await flow.review();
      assert.equal((await flow.start({ reviewed: beforeSetup.reviewId, confirmSubmission: true })).code, 'pos_review_changed');
      assert.equal(helpersClosed, 1);
      await rules.evaluate(node => { node.innerHTML = 'Я соглашаюсь с правилами подачи сообщений и обращений<a href="/rules-original"></a>'; });
      changeDuringSetup = () => rules.locator('a').evaluate(node => { node.href = '/rules-replaced'; });
      const beforeTerms = await flow.review();
      assert.equal((await flow.start({ reviewed: beforeTerms.reviewId, confirmSubmission: true })).code, 'pos_review_changed');
      assert.equal(helpersClosed, 2);
      assert.equal(await page.locator('body').getAttribute('data-entry-clicks'), '0');
      await rules.locator('a').evaluate(node => { node.href = '/rules-original'; });
      changeDuringSetup = undefined;
      const review = await flow.review(); assert.equal(review.phase, 'prepared');
      await flow.start({ reviewed: review.reviewId, confirmSubmission: true });
      assert.equal(await page.locator('#check-agree').isChecked(), true);
      assert.equal(await page.locator('body').getAttribute('data-rules-clicks'), '1');
      await flow.advance(); assert.equal(await page.locator('body').getAttribute('data-auth-started'), 'yes');
      returned = true; await page.evaluate(() => window.syntheticReturn());
      await flow.advance();
      let result;
      for (let attempt = 0; attempt < 400; attempt++) {
        result = await flow.inspect();
        if (['submitted', 'blocked'].includes(result.phase)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(auths, 3); assert.equal(creates, rejectUpload?0:1);
      assert.equal(await page.locator('body').getAttribute('data-entry-clicks'), '1');
      assert.equal(uploads,rejectUpload?3:5); assert.equal(maxUploading,1,'the widget Promise.all must not burst five uploads');
      assert.equal(result.evidence.attachment_upload.httpStatus,rejectUpload?403:200);
      if(rejectUpload){assert.deepEqual(result.evidence.appeal_create,{});assert.equal(result.stage,'attachment_upload');}
      else assert.equal(result.evidence.appeal_create.httpStatus, status);
      assert.equal(result.outcome, status === 200&&!rejectUpload ? 'confirmed_succeeded' : 'unknown');
      if (status === 200&&!rejectUpload) assert.equal(result.receipt.registrationNumber, '123456789');
      else if(!rejectUpload) assert.equal(result.stage, 'appeal_create');
      assert.equal(await page.locator('#check-agree').isChecked(), true);
      assert.equal(await page.locator('body').getAttribute('data-rules-clicks'), '1');
      assert.equal(await page.locator('#description').inputValue(), 'Synthetic reviewed statement');
      assert.deepEqual(await page.locator('input[type=file]').evaluate(input => [...input.files].map(file =>
        ({ name: file.name, size: file.size }))), files.map(file => ({ name: file.name, size: file.buffer.length })));
      assert.ok(!JSON.stringify(result).includes('must never leave'));
      await flow.close(); assert.equal(page.isClosed(), false);
    } finally { await context.close(); }
  }
}
