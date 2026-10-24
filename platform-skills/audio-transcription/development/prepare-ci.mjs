import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installationPlan, performSetup, ready} from '../scripts/bootstrap.mjs';
import {atomicJson, privateDirectory} from '../scripts/storage.mjs';

if (process.argv[2] === 'package') {
  // Runtime source is already frozen in Git. No native binary, model, local
  // recording or test cache is ever added to a public signed code package.
  process.stdout.write('Audio transcription package uses committed source only.\n');
} else {
  const provider = fileURLToPath(new URL('../', import.meta.url));
  const root = privateDirectory(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trelio-audio-ci-')));
  const plan = installationPlan(root);
  // Explicit test-fixture consent exercises the same production installer.
  // It is not an agent authorization or a receipt for a person's device.
  atomicJson(path.join(root, 'download-consent.json'), {planHash: plan.planHash, testFixture: true});
  await performSetup(plan.planHash, root);
  if (!ready(root)) {
    process.stderr.write(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'setup.json')))) + '\n');
    throw Error('audio_ci_setup_failed');
  }
  atomicJson(path.join(provider, '.ci-state.json'), {root});
  process.stdout.write('Audio transcription real CPU environment and official model ready.\n');
}
