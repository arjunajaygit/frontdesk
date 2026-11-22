// Release gate (final audit H03). Decides whether a commit may be built, published, signed and deployed.
// Pure decision functions are unit-tested (tests/unit/release-gate.test.ts); the CLI fetches GitHub data.
//
//   node scripts/release-gate.mjs gate    # env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REF, GITHUB_SHA, INPUT_SHA
//   node scripts/release-gate.mjs digest <tested-config-digest> <pushed-config-digest>
//
// Rules: only refs/heads/main; the operator must type the exact 40-hex SHA and it must equal the dispatched commit;
// the latest `push` run on main of EVERY mandatory workflow for that exact SHA must have concluded `success`, and the
// CI run's final release-gate job must have succeeded. Anything missing, failed, cancelled, in progress, for another
// SHA or another branch is rejected.

export const APPROVED_REFS = ['refs/heads/main'];
export const MANDATORY_WORKFLOWS = ['CI', 'Security'];
export const CI_GATE_JOB = 'Release gate (all mandatory jobs must pass)';
const SHA = /^[0-9a-f]{40}$/;

/**
 * @param {{ ref: string, inputSha: string, dispatchSha: string,
 *   runs: Array<{ name: string, head_sha: string, head_branch: string, event: string, status: string, conclusion: string|null, run_attempt?: number, created_at: string, id: number }>,
 *   ciJobs: Array<{ name: string, conclusion: string|null }> | null }} input
 */
export function evaluateGate({ ref, inputSha, dispatchSha, runs, ciJobs }) {
  const reasons = [];
  if (!APPROVED_REFS.includes(ref))
    reasons.push(`ref ${ref} is not an approved release ref (${APPROVED_REFS.join(', ')})`);
  if (!SHA.test(inputSha ?? '')) reasons.push('input sha must be the full 40-character commit SHA');
  else if (inputSha !== dispatchSha)
    reasons.push(`input sha ${inputSha} does not match the dispatched commit ${dispatchSha}`);
  const chosen = {};
  for (const wf of MANDATORY_WORKFLOWS) {
    const candidates = runs
      .filter((r) => r.name === wf && r.event === 'push' && r.head_branch === 'main')
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const forSha = candidates.filter((r) => r.head_sha === inputSha);
    if (!forSha.length) {
      reasons.push(
        `${wf}: no push run on main for ${inputSha}${candidates.length ? ' (runs exist only for other commits: stale)' : ''}`,
      );
      continue;
    }
    const latest = forSha[0];
    if (latest.status !== 'completed')
      reasons.push(`${wf}: latest run ${latest.id} is ${latest.status}`);
    else if (latest.conclusion !== 'success')
      reasons.push(`${wf}: latest run ${latest.id} concluded ${latest.conclusion}`);
    chosen[wf] = latest.id;
  }
  if (chosen.CI !== undefined) {
    const gate = (ciJobs ?? []).find((j) => j.name === CI_GATE_JOB);
    if (!gate) reasons.push(`CI: job "${CI_GATE_JOB}" not found in run ${chosen.CI}`);
    else if (gate.conclusion !== 'success')
      reasons.push(`CI: release gate job concluded ${gate.conclusion}`);
  }
  return { ok: reasons.length === 0, reasons, runs: chosen };
}

/** The image that was tested and scanned must be byte-identical (same config digest) to what is published/signed. */
export function verifyDigestMatch(tested, pushed) {
  const d = /^sha256:[0-9a-f]{64}$/;
  if (!d.test(tested ?? '') || !d.test(pushed ?? ''))
    return { ok: false, reason: 'both digests must be sha256:<64 hex>' };
  return tested === pushed
    ? { ok: true }
    : { ok: false, reason: `artifact digest mismatch: tested ${tested}, published ${pushed}` };
}

/** Exact keyless signing identity for this workflow on an approved ref (no wildcards). */
export function expectedSigningIdentity(repository, ref) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid repository');
  if (!APPROVED_REFS.includes(ref)) throw new Error(`ref ${ref} is not approved for signing`);
  return `https://github.com/${repository}/.github/workflows/release.yml@${ref}`;
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json();
}

async function cli() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'digest') {
    const r = verifyDigestMatch(a, b);
    console.log(r.ok ? `digest match: ${a}` : `REJECTED: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd !== 'gate') throw new Error('usage: release-gate.mjs gate | digest <tested> <pushed>');
  const repo = process.env.GITHUB_REPOSITORY;
  const inputSha = (process.env.INPUT_SHA ?? '').trim();
  const runs = SHA.test(inputSha)
    ? (await gh(`/repos/${repo}/actions/runs?head_sha=${inputSha}&per_page=100`)).workflow_runs
    : [];
  const ci = runs
    .filter(
      (r) =>
        r.name === 'CI' &&
        r.event === 'push' &&
        r.head_branch === 'main' &&
        r.head_sha === inputSha,
    )
    .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))[0];
  const ciJobs = ci
    ? (await gh(`/repos/${repo}/actions/runs/${ci.id}/jobs?per_page=100`)).jobs
    : null;
  const verdict = evaluateGate({
    ref: process.env.GITHUB_REF,
    inputSha,
    dispatchSha: process.env.GITHUB_SHA,
    runs,
    ciJobs,
  });
  if (!verdict.ok) {
    console.log('RELEASE GATE REJECTED:');
    for (const r of verdict.reasons) console.log(` - ${r}`);
    process.exit(1);
  }
  console.log(`release gate passed for ${inputSha}: ${JSON.stringify(verdict.runs)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
