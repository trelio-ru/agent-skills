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
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/form/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
          <textarea id="description">Synthetic reviewed statement</textarea><input type="file" multiple>
          <input type="checkbox" id="check-agree"><input type="checkbox" id="check-requestedFederalLawType" style="display:none">
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
          document.querySelector('#check-agree').onchange=e=>footer.disabled=!e.target.checked;
          footer.onclick=()=>overlay.hidden=false;
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
        createAuthorization: async () => { auths++; return { close: async () => {} }; },
        observeAuthorization: () => ({ snapshot: () => ({ phase: returned ? 'esia_callback_verified' : 'esia_request_pending' }) }),
      });
      await flow.select({inputId:'react-select-2-input',label:'Synthetic region (A+B)'});
      await flow.setFederalLaw({enabled:true});
      assert.equal(await page.locator('#check-requestedFederalLawType').isChecked(),true);
      const review = await flow.review(); assert.equal(review.phase, 'consent_required');
      // Simulates the actual human gesture, never a production consent helper.
      await page.locator('#check-agree').check();
      await flow.start({ reviewed: review.reviewId, confirmSubmission: true });
      await flow.advance(); assert.equal(await page.locator('body').getAttribute('data-auth-started'), 'yes');
      returned = true; await page.evaluate(() => window.syntheticReturn());
      await flow.advance();
      let result;
      for (let attempt = 0; attempt < 400; attempt++) {
        result = await flow.inspect();
        if (['submitted', 'blocked'].includes(result.phase)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(auths, 1); assert.equal(creates, rejectUpload?0:1);
      assert.equal(uploads,rejectUpload?3:5); assert.equal(maxUploading,1,'the widget Promise.all must not burst five uploads');
      assert.equal(result.evidence.attachment_upload.httpStatus,rejectUpload?403:200);
      if(rejectUpload){assert.deepEqual(result.evidence.appeal_create,{});assert.equal(result.stage,'attachment_upload');}
      else assert.equal(result.evidence.appeal_create.httpStatus, status);
      assert.equal(result.outcome, status === 200&&!rejectUpload ? 'confirmed_succeeded' : 'unknown');
      if (status === 200&&!rejectUpload) assert.equal(result.receipt.registrationNumber, '123456789');
      else if(!rejectUpload) assert.equal(result.stage, 'appeal_create');
      assert.equal(await page.locator('#check-agree').isChecked(), true);
      assert.equal(await page.locator('#description').inputValue(), 'Synthetic reviewed statement');
      assert.deepEqual(await page.locator('input[type=file]').evaluate(input => [...input.files].map(file =>
        ({ name: file.name, size: file.size }))), files.map(file => ({ name: file.name, size: file.buffer.length })));
      assert.ok(!JSON.stringify(result).includes('must never leave'));
      await flow.close(); assert.equal(page.isClosed(), false);
    } finally { await context.close(); }
  }
}
