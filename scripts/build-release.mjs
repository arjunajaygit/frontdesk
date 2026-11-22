// Builds the release images from the EXACT committed revision: the build context is `git archive <rev>`, so
// uncommitted files (e.g. a locally modified CLAUDE.md), .env files and .local/ credentials can never enter it.
// Usage: node scripts/build-release.mjs [rev=HEAD]   -> frontdesk-{app,migrate,tools}:rc-<short> (+ :local tags)
import { execFileSync, spawn } from 'node:child_process';

const rev = process.argv[2] ?? 'HEAD';
const sha = execFileSync('git', ['rev-parse', `${rev}^{commit}`], { encoding: 'utf8' }).trim();
const short = sha.slice(0, 12);
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty)
  console.log(
    `note: working tree has local changes; they are EXCLUDED (building ${short} from git archive)`,
  );

function build(target, name) {
  return new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', sha], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const docker = spawn(
      'docker',
      [
        'build',
        '--quiet',
        '--target',
        target,
        '--build-arg',
        `GIT_SHA=${sha}`,
        '-t',
        `${name}:rc-${short}`,
        '-t',
        `${name}:local`,
        '-',
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    archive.stdout.pipe(docker.stdin);
    docker.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${target} build failed (${code})`)),
    );
  });
}
for (const [target, name] of [
  ['runtime', 'frontdesk-app'],
  ['migrate', 'frontdesk-migrate'],
  ['tools', 'frontdesk-tools'],
]) {
  await build(target, name);
  console.log(`built ${name}:rc-${short} (${target}) from ${sha}`);
}
