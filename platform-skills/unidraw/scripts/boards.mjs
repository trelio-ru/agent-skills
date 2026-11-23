import { createHash } from 'node:crypto';
import { canonicalBoardUrl, readScene, UniDrawError } from './model.mjs';
import { assertBoardTitleAvailable, browserStep, exportBoard, findImportedBoard, verifyImport } from './browser.mjs';
import { verifyUnaffected } from './editing.mjs';

const HOME = 'https://unidraw.io/app';
const PREVIEW = 'Превью к шаблону ';
const WAIT = { timeout: 9_000 };
const exact = name => ({ name, exact: true });
const fail = code => { throw new UniDrawError(code); };

export async function chooseProject(ui, name) {
  if (!name) return;
  const project = ui.getByRole('dialog').getByRole('combobox', exact('Проект'));
  await project.getByRole('button', exact('Открыть')).click(WAIT);
  const option = ui.getByRole('option', exact(name));
  await option.waitFor({ state: 'visible', ...WAIT });
  if (await option.count() !== 1) fail('PROJECT_NOT_UNIQUE');
  await option.click(WAIT);
  if (!await project.getByText(name, { exact: true }).isVisible()) fail('PROJECT_NOT_SELECTED');
}

export async function gallery(browser) {
  await browser.navigate(HOME);
  const { ui } = browser;
  await ui.getByText('Создать доску из шаблона', { exact: true }).waitFor({ state: 'visible', ...WAIT });
  await ui.locator('img[alt^="Превью к шаблону "][src]').first().waitFor({ state: 'visible', ...WAIT });
  const records = await ui.evaluate(prefix => [...document.querySelectorAll('img[alt]')]
    .filter(image => image.alt.startsWith(prefix) && image.getClientRects().length)
    .map(image => ({ name: image.alt.slice(prefix.length), source: image.getAttribute('src') ?? '' })), PREVIEW);
  return records.slice(0, 100).filter(item => item.name && item.source).map(item => ({
    name: item.name, source: item.source,
    // The preview differentiates cards with the same displayed name.
    key: createHash('sha256').update(item.name + '\0' + item.source).digest('hex').slice(0, 24),
  }));
}

async function editorBoard(browser, onIdentified) {
  for (let attempt = 0; attempt < 24; attempt++) {
    let result;
    try { result = canonicalBoardUrl(await browser.url()); }
    catch (cause) { if (cause.code !== 'INVALID_BOARD_URL') throw cause; }
    if (result) {
      // Keep the observed navigation in the unknown-outcome receipt even if
      // the editor never becomes ready enough to export and verify the board.
      await onIdentified(result);
      await browserStep('TEMPLATE_EDITOR_NOT_READY',() =>
        browser.ui.getByTestId('elements-search-button').waitFor({ state: 'visible', ...WAIT }));
      if (canonicalBoardUrl(await browser.url()) !== result) fail('BOARD_CHANGED');
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  fail('CREATED_BOARD_NOT_IDENTIFIED');
}

export async function createFromTemplate(browser, spec, onProgress) {
  const records = await gallery(browser);
  const matches = records.filter(item => item.name === spec.template &&
    (spec.templateKey === undefined || item.key === spec.templateKey));
  if (matches.length !== 1) fail('TEMPLATE_NOT_UNIQUE');
  const { source } = matches[0];
  // Treat the DOM attribute as a literal, never as a selector or a URL to fetch.
  const image = browser.ui.getByRole('img', exact(PREVIEW + spec.template));
  const candidates = await image.all();
  const targets = [];
  for (const candidate of candidates) {
    if (await candidate.getAttribute('src') === source) targets.push(candidate);
  }
  if (targets.length !== 1) fail('TEMPLATE_NOT_UNIQUE');
  // Check the image's actual actionability without clicking. A blocking
  // overlay or stale carousel must fail before the receipt claims a write.
  const target = targets[0];
  await browserStep('TEMPLATE_NOT_ACTIONABLE',() => target.click({ ...WAIT, trial: true }));
  if ((await browser.url()).replace(/\/$/,'') !== HOME) fail('WRONG_GALLERY_LOCATION');
  if (await target.getAttribute('src') !== source) fail('TEMPLATE_PREVIEW_CHANGED');
  await onProgress({ stage: 'template' });
  await browserStep('TEMPLATE_CLICK_OUTCOME_UNKNOWN',() => target.click(WAIT));
  const board = await editorBoard(browser,board => onProgress({ stage: 'read_back', board }));
  const scene = await exportBoard(browser, board);
  const count = readScene(scene).elements.length;
  if (!count) fail('TEMPLATE_CONTENT_NOT_VERIFIED');
  await browser.reload();
  const saved = await exportBoard(browser, board);
  if (readScene(saved).elements.length !== count) fail('TEMPLATE_CONTENT_NOT_VERIFIED');
  verifyUnaffected(scene, saved);
  return { board, template: spec.template, elements: count };
}

export async function copyBoard(browser, spec, onProgress) {
  await assertBoardTitleAvailable(browser, spec.title);
  await browser.navigate(spec.board);
  const before = await exportBoard(browser, spec.board);
  const { ui } = browser;
  const item = ui.getByRole('menuitem', exact('Создать копию'));
  await ui.getByTestId('menu-button').click(WAIT);
  await item.click(WAIT);
  const dialog = ui.getByRole('dialog');
  await dialog.getByText('Копия доски', { exact: true }).waitFor({ state: 'visible', ...WAIT });
  await dialog.getByRole('textbox', exact('Название')).fill(spec.title, WAIT);
  await chooseProject(ui, spec.project);
  if (canonicalBoardUrl(await browser.url()) !== spec.board) fail('BOARD_CHANGED');
  await onProgress({ stage: 'copy' });
  await dialog.getByRole('button', exact('Сохранить')).click(WAIT);
  await ui.getByText('Создана копия доски', { exact: true }).waitFor({ state: 'visible', ...WAIT });
  await browser.navigate(HOME);
  const board = await findImportedBoard(browser, spec.title);
  if (board === spec.board) fail('CREATED_BOARD_NOT_IDENTIFIED');
  await onProgress({ stage: 'read_back', board });
  await browser.navigate(board);
  const snapshot = await exportBoard(browser, board);
  const comparison = verifyImport(before, snapshot);
  await browser.reload();
  const saved = await exportBoard(browser, board);
  if (readScene(saved).elements.length !== comparison.elements) fail('COPIED_BOARD_NOT_VERIFIED');
  verifyUnaffected(snapshot, saved);
  return { board, title: spec.title, ...comparison };
}
