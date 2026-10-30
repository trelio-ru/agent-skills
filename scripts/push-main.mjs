// Repository-owned transport. Shared FIFO admission/evidence is imported,
// not copied; ordinary main updates and immutable provider tags use one slot.
import {execFileSync} from 'node:child_process';
import {assertPush, read, policy} from '@trelio/git-coordinator/coordinator';
const cwd = process.cwd(), tag = process.argv[2] === '--tag' ? process.argv[3] : '';
if (process.argv.length !== (tag ? 4 : 2)) throw Error('Use [--tag TAG]');
const git = (...args) => read('git', args, cwd);
const sha = git('rev-parse', 'HEAD'), canonical = git('config', '--get', policy(cwd).canonicalKey);
assertPush(cwd, sha, tag);
if (read('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], canonical)) throw Error('Canonical main is dirty');
// A clean canonical tree can still contain an unpublished divergent commit.
// Reject it BEFORE remote mutation; failed local sync must not leave a pushed
// main behind. Ordinary stale/ahead canonical ancestors of the candidate remain safe.
try {
  git('merge-base', '--is-ancestor', read('git', ['rev-parse', 'HEAD'], canonical), sha);
} catch { throw Error('Canonical main is outside the verified source path'); }
execFileSync('git', ['fetch', '--prune', 'origin'], {cwd, stdio: 'inherit'});
git('merge-base', '--is-ancestor', 'origin/main', sha);
// No blind retry after ambiguous mutation: exact remote state is read first.
let failure;
try { execFileSync('git', ['push', ...(tag ? ['--atomic'] : []), 'origin', `${sha}:refs/heads/main`, ...(tag ? [`refs/tags/${tag}`] : [])], {cwd, stdio: 'inherit'}); }
catch (error) { failure = error; }
const remoteMain = git('ls-remote', '--refs', 'origin', 'refs/heads/main');
if (remoteMain !== `${sha}\trefs/heads/main`) throw failure ?? Error('Remote main read-back mismatch');
if (tag) {
  const remoteTag = git('ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  const final = remoteTag.split('\n').at(-1);
  if (final !== `${sha}\trefs/tags/${tag}^{}` && final !== `${sha}\trefs/tags/${tag}`) throw Error('Tag read-back mismatch');
}
execFileSync('git', ['fetch', '--prune', 'origin'], {cwd: canonical, stdio: 'inherit'});
execFileSync('git', ['merge', '--ff-only', sha], {cwd: canonical, stdio: 'inherit'});
execFileSync('git', ['config', '--local', 'core.hooksPath', canonical + '/.githooks'], {cwd: canonical, stdio: 'inherit'});
