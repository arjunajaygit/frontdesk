// The release gate must reject unapproved refs, SHAs without passing mandatory checks, stale or
// mismatched runs, artifact digest mismatches and non-exact signing identities. Run: node --test tests/release
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CI_GATE_JOB,
  evaluateGate,
  expectedSigningIdentity,
  verifyDigestMatch,
} from '../../scripts/release-gate.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (name, over = {}) => ({
  id: name === 'CI' ? 1 : 2,
  name,
  head_sha: SHA,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-22T10:00:00Z',
  ...over,
});
const good = {
  ref: 'refs/heads/main',
  inputSha: SHA,
  dispatchSha: SHA,
  runs: [run('CI'), run('Security')],
  ciJobs: [{ name: CI_GATE_JOB, conclusion: 'success' }],
};

test('passes only for main + exact SHA + successful CI and Security runs for that SHA', () => {
  assert.deepEqual(evaluateGate(good).ok, true);
});
test('rejects an unapproved reference', () => {
  const r = evaluateGate({ ...good, ref: 'refs/heads/feature-x' });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /not an approved release ref/);
});
test('rejects a typed SHA that differs from the dispatched commit, or a short SHA', () => {
  assert.match(
    evaluateGate({ ...good, inputSha: OTHER }).reasons.join(),
    /does not match the dispatched commit/,
  );
  assert.match(evaluateGate({ ...good, inputSha: 'abc123' }).reasons.join(), /full 40-character/);
});
test('rejects a SHA lacking passing mandatory checks (missing, failed, cancelled, in progress)', () => {
  assert.match(
    evaluateGate({ ...good, runs: [run('CI')] }).reasons.join(),
    /Security: no push run/,
  );
  assert.match(
    evaluateGate({
      ...good,
      runs: [run('CI', { conclusion: 'failure' }), run('Security')],
    }).reasons.join(),
    /CI: latest run 1 concluded failure/,
  );
  assert.match(
    evaluateGate({
      ...good,
      runs: [run('CI'), run('Security', { conclusion: 'cancelled' })],
    }).reasons.join(),
    /concluded cancelled/,
  );
  assert.match(
    evaluateGate({
      ...good,
      runs: [run('CI', { status: 'in_progress', conclusion: null }), run('Security')],
    }).reasons.join(),
    /in_progress/,
  );
});
test('rejects stale evidence: runs only for another commit, a PR run, or another branch', () => {
  assert.match(
    evaluateGate({
      ...good,
      runs: [run('CI', { head_sha: OTHER }), run('Security', { head_sha: OTHER })],
    }).reasons.join(),
    /stale/,
  );
  assert.equal(
    evaluateGate({ ...good, runs: [run('CI', { event: 'pull_request' }), run('Security')] }).ok,
    false,
  );
  assert.equal(
    evaluateGate({ ...good, runs: [run('CI', { head_branch: 'dev' }), run('Security')] }).ok,
    false,
  );
});
test('the LATEST run for the SHA decides (a later failed re-run beats an earlier success)', () => {
  const runs = [
    run('CI'),
    run('CI', { id: 3, conclusion: 'failure', created_at: '2026-11-22T11:00:00Z' }),
    run('Security'),
  ];
  assert.match(evaluateGate({ ...good, runs }).reasons.join(), /latest run 3 concluded failure/);
});
test('rejects when the CI release-gate job did not succeed or is absent', () => {
  assert.match(
    evaluateGate({
      ...good,
      ciJobs: [{ name: CI_GATE_JOB, conclusion: 'skipped' }],
    }).reasons.join(),
    /release gate job concluded skipped/,
  );
  assert.match(evaluateGate({ ...good, ciJobs: [] }).reasons.join(), /not found/);
});
test('rejects an artifact digest mismatch between the tested and the published image', () => {
  const a = `sha256:${'1'.repeat(64)}`;
  const b = `sha256:${'2'.repeat(64)}`;
  assert.equal(verifyDigestMatch(a, a).ok, true);
  assert.match(verifyDigestMatch(a, b).reason, /artifact digest mismatch/);
  assert.equal(verifyDigestMatch(a, 'latest').ok, false);
});
test('signing identity is exact (no wildcards) and only for approved refs', () => {
  assert.equal(
    expectedSigningIdentity('acme/frontdesk', 'refs/heads/main'),
    'https://github.com/acme/frontdesk/.github/workflows/release.yml@refs/heads/main',
  );
  assert.throws(
    () => expectedSigningIdentity('acme/frontdesk', 'refs/heads/attacker'),
    /not approved/,
  );
  assert.throws(
    () => expectedSigningIdentity('acme/frontdesk; rm -rf', 'refs/heads/main'),
    /invalid repository/,
  );
});
