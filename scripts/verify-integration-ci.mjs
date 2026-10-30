import {verifyHosted} from '@trelio/git-coordinator/hosted-ci';
import {read} from '@trelio/git-coordinator/coordinator';
import {selectProviderRegressions} from '../platform-skills/tools/select-provider-regressions.mjs';
const [mode, sha] = process.argv.slice(2);
if (mode !== '--prepare' || !/^[a-f0-9]{40}$/u.test(sha ?? '')) throw Error('Use --prepare SHA');
const raw = read('git', ['diff', '--name-only', '-z', 'refs/remotes/origin/main...' + sha], process.cwd());
if (raw && !raw.endsWith('\0')) throw Error('Incomplete source path inventory');
const files = raw ? raw.slice(0, -1).split('\0') : [];
const requirements = [
  {file: 'git-coordination.yml', jobs: ['Git coordination']},
  {file: "public-source.yml", jobs: ["public-source"]},
];
// Reuse the provider owner's selection; a queue must never invent a smaller
// OS matrix or treat a missing dedicated workflow as a skipped success.
const dedicated = {
  't-bank': ['tbank-security.yml', 'Native vault and bank authentication'],
  'email-imap-smtp': ['email-security.yml', 'Native vault and lifecycle'],
  'gosuslugi': ['gosuslugi-security.yml', 'Native vault and lifecycle'],
  'whatsapp-web': ['whatsapp-browser.yml', 'Persistent profile and lifecycle'],
};
for (const [provider, [file, name]] of Object.entries(dedicated)) {
  if (files.some(value => value.startsWith(`platform-skills/${provider}/`) || value === '.github/workflows/' + file)
    || provider === 't-bank' && files.some(value => /^platform-skills\/gosuslugi\/scripts\/(?:native|private-directory\.ps1)/u.test(value))) {
    requirements.push({file, jobs: ['macos-latest', 'windows-latest'].map(os => `${name} (${os})`)});
  }
}
const general = files.some(value => value === '.github/workflows/platform-skill-runtimes.yml'
  || value.startsWith('platform-skills/') && !Object.keys(dedicated).some(id => value.startsWith(`platform-skills/${id}/`)));
if (general) {
  const selected = selectProviderRegressions(files);
  const jobs = ['Select changed provider regressions'];
  if (selected.runPackageTool) jobs.push('Package builder regressions');
  if (selected.runSourceTests) jobs.push("Public provider source regressions");
  jobs.push(...selected.hostedMatrix.include.map(row => `${row.skill} (${row.os})`));
  requirements.push({file: 'platform-skill-runtimes.yml', jobs});
}
await verifyHosted(process.cwd(), sha, requirements, {prepare: true});
