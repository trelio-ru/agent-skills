import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {policy, read} from '@trelio/git-coordinator/coordinator';
test('current repository uses the pinned common coordinator and refuses forged main admission', () => {
  const config = policy(process.cwd());
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(config.verify, ['node', 'scripts/verify-integration-ci.mjs']);
  const sha = read('git', ['rev-parse', 'HEAD'], process.cwd());
  const result = spawnSync('node', ['scripts/assert-coordination.mjs'], {encoding: 'utf8',
    input: `refs/heads/main ${sha} refs/heads/main ${sha}\n`,
    env: {...process.env, TRELIO_AGENT_WORKSPACES_GUARDED_MAIN_PUSH: '1'}});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FIFO owner/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
test('canonical divergence is rejected before remote main mutation through the real FIFO', {skip: process.platform === 'win32', timeout: 30000}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-canonical-'));
  const main = path.join(directory, 'main'), task = path.join(directory, 'task'), remote = path.join(directory, 'remote.git');
  fs.mkdirSync(main);
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.replace(/\n$/u, '');
  };
  const config = policy(process.cwd());
  fs.writeFileSync(path.join(main, 'git-coordination.json'), JSON.stringify({...config, repository: 'fixture/skills',
    verify: ['node', 'ci.mjs'], transport: ['node', path.resolve('scripts/push-main.mjs')]}));
  // Only hosted evidence is synthetic. Git, owner ancestry, FIFO and the
  // repository's actual protected transport run unchanged in this fixture.
  fs.writeFileSync(path.join(main, 'ci.mjs'), 'process.exit(0);\n');
  git(main, 'init', '--initial-branch=main');
  git(main, 'config', 'user.name', 'Canonical fixture'); git(main, 'config', 'user.email', 'fixture@example.invalid');
  git(main, 'add', '.'); git(main, 'commit', '-m', 'Основа');
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(main, 'remote', 'add', 'origin', remote); git(main, 'push', '-u', 'origin', 'main');
  const before = git(main, 'rev-parse', 'HEAD');
  git(main, 'worktree', 'add', '-b', 'codex/fixture', task, 'origin/main');
  fs.writeFileSync(path.join(task, 'task.txt'), 'candidate'); git(task, 'add', '.'); git(task, 'commit', '-m', 'Кандидат');
  // Simulate an accidental clean, but unpublished/divergent canonical commit.
  // A later failed local fast-forward must not leave remote main already changed.
  fs.writeFileSync(path.join(main, 'stray.txt'), 'unpublished'); git(main, 'add', '.'); git(main, 'commit', '-m', 'Невлитый main');
  git(main, 'config', config.canonicalKey, main);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('@trelio/git-coordinator/coordinator')), '--worker'],
    {cwd: task, detached: true, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await closed; }
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const code = await closed;
  assert.equal(git(main, '--git-dir=' + remote, 'rev-parse', 'refs/heads/main'), before, 'Reject before remote mutation');
  assert.notEqual(code, 0); assert.match(stderr, /Canonical main is outside the verified source path/);
});
