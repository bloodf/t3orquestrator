import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, DEFAULT_COOL_MIN } from '../lib/limits.mjs';

const NOW = Date.parse('2026-11-16T14:30:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Texts seen in real runs (cofre3d, Open3dFarmManager; Mac and cortex, 2026-11-13..17), as the thread's last reply.
const REAL = {
  antigravity: 'Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 5 days, 4 hours.',
  antigravityMinutes: 'Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 4 days, 33 minutes.',
  claude: "You've hit your Fable limit · resets Nov 17 at 12am (America/Sao_Paulo). Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
  codex: 'You’ve hit your usage limit. Visit <url> to purchase more credits or try again at Nov 9th, 2026 11:58 AM.',
  capacity: 'No capacity available for model gemini-3.8-flash-high on the server',
};

test('real usage-limit replies are limits, with the reset time the provider gave', () => {
  const ag = classifyFailure(REAL.antigravity, NOW);
  assert.deepEqual([ag.kind, ag.until, ag.reason], ['limit', NOW + 5 * DAY + 4 * HOUR, 'Usage Limit Reached']);
  assert.equal(classifyFailure(REAL.antigravityMinutes, NOW).until, NOW + 4 * DAY + 33 * MIN);
  // Nov 17 00:00 in São Paulo (UTC-3) is 03:00 UTC
  const claude = classifyFailure(REAL.claude, NOW);
  assert.deepEqual([claude.kind, claude.until], ['limit', Date.parse('2026-11-17T03:00:00Z')]);
  // no zone given: the machine's local time, as the provider printed it for this machine
  const codex = classifyFailure(REAL.codex, Date.parse('2026-11-05T04:17:24Z'));
  assert.deepEqual([codex.kind, codex.until], ['limit', new Date(2026, 10, 9, 11, 58).getTime()]);
});

test('capacity, rate-limit and sign-out replies are classified; no reset time cools for a default', () => {
  const cap = classifyFailure(REAL.capacity, NOW);
  assert.deepEqual([cap.kind, cap.until], ['capacity', NOW + DEFAULT_COOL_MIN.capacity * MIN]);
  for (const t of ['API Error: 429 Too Many Requests', 'Rate limit reached for requests', 'Error: rate_limit_error']) {
    assert.equal(classifyFailure(t, NOW).kind, 'limit', t);
  }
  assert.equal(classifyFailure('Rate limit reached. Please try again in 5 minutes 20s.', NOW).until, NOW + 320_000);
  assert.equal(classifyFailure('You exceeded your current quota, please check your plan and billing details.', NOW).until, NOW + DEFAULT_COOL_MIN.limit * MIN);
  for (const t of ['Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    'You are signed out. Run /login to sign in.', 'Not logged in · Please run /login', 'Invalid API key · Please run /login']) {
    const r = classifyFailure(t, NOW);
    assert.deepEqual([r.kind, r.until], ['auth', NOW + DEFAULT_COOL_MIN.auth * MIN], t);
  }
  for (const t of ['API Error: 529 {"type":"overloaded_error"}', 'The model gpt-x is currently unavailable', 'Service temporarily unavailable']) {
    assert.equal(classifyFailure(t, NOW).kind, 'capacity', t);
  }
});

test('ordinary replies are not failures: worker reports, progress notes, review findings, long text', () => {
  for (const t of [
    'Added retry on HTTP 429 to the upload client.',
    'Added a redirect for users who are not logged in; run /login to test it.',
    'Summary: fixed overloaded constructor.\n\nDONE',
    'The health route now returns 503 Service Unavailable while migrating.',
    'Checking why the API returns 429 under load.',
    'Rate limit middleware added and tested.',
    'thread start failed (exit 1): model foo-9 not available for provider pa', // a wrong model name: an ordinary failure
    'No findings. The model is not available offline, which is expected.',
    'DONE Added a rate limit to the login route and a test for HTTP 429.',
    'BLOCKED: the usage limit of the plan is not defined in decisions.',
    'Now adding the quota check to the upload service.',
    "Let's read the rate limit middleware first.",
    `Usage limit reached ${'x'.repeat(700)}`,
    '', null, undefined,
  ]) assert.equal(classifyFailure(t, NOW), null, String(t).slice(0, 40));
});

test('reset times: milliseconds, a date across the new year, a time of day in a zone, a t3 start error', () => {
  // a reset that is already due still cools a minute from the time of reading, so a unit cannot relaunch in a loop
  assert.equal(classifyFailure('Rate limit reached for gpt-x. Please try again in 340ms.', NOW).until, NOW + MIN);
  assert.equal(classifyFailure('Usage Limit Reached', NOW - 3 * HOUR, { now: NOW }).until, NOW + MIN); // read 3 h late
  assert.equal(classifyFailure(REAL.antigravity, NOW - HOUR, { now: NOW }).until, NOW - HOUR + 5 * DAY + 4 * HOUR); // from when it was written
  const newYear = Date.parse('2027-01-01T02:00:00Z'); // still Dec 31 in Honolulu
  assert.equal(classifyFailure("You've hit your limit · resets Dec 31 at 8pm (Pacific/Honolulu)", newYear).until, Date.parse('2027-01-01T06:00:00Z'));
  // a time only: the next one in that zone (15:00 in Los Angeles is 23:00 UTC; NOW is 06:30 there)
  assert.equal(classifyFailure("You've hit your limit · resets 3pm (America/Los_Angeles)", NOW).until, Date.parse('2026-11-16T23:00:00Z'));
  assert.equal(classifyFailure("You've hit your limit · resets 5am (America/Los_Angeles)", NOW).until, Date.parse('2026-11-17T13:00:00Z'));
  const start = classifyFailure('thread start failed (exit 1): Not logged in · Please run /login', NOW);
  assert.equal(start.kind, 'auth');
});

test('a completed turn (strict) needs an explicit provider phrasing; a failed thread may start with a bare code', () => {
  for (const t of Object.values(REAL)) assert.ok(classifyFailure(t, NOW, { strict: true }), t);
  for (const t of ['API Error: 429 Too Many Requests', 'API Error: 529 {"type":"overloaded_error"}', 'Not logged in · Please run /login', 'Rate limit reached for requests']) {
    assert.ok(classifyFailure(t, NOW, { strict: true }), t);
  }
  for (const t of ['Rate limit errors are now retried with backoff; tests pass.', '429 responses from the upstream are now retried.', 'Overloaded operator fixed in parser.',
    'Too many requests are now batched.', 'Service temporarily unavailable pages now show a retry button.']) {
    assert.equal(classifyFailure(t, NOW, { strict: true }), null, t);
  }
  assert.equal(classifyFailure('429 Too Many Requests', NOW).kind, 'limit'); // a failed thread's error line
});

test('a reset time in the past or absurdly far ahead is ignored for the default', () => {
  assert.equal(classifyFailure('You have hit your usage limit. Try again at Jan 2nd, 2020 1:00 PM.', NOW).until, NOW + DEFAULT_COOL_MIN.limit * MIN);
  assert.equal(classifyFailure('Usage limit reached. Your limit will reset in 40 days.', NOW).until, NOW + DEFAULT_COOL_MIN.limit * MIN);
  // a date with no year that has passed this year is next year's
  const r = classifyFailure('You\'ve hit your limit · resets Jan 3 at 9am (UTC)', NOW);
  assert.equal(r.until, NOW + DEFAULT_COOL_MIN.limit * MIN); // 48 days ahead: past the 8-day horizon
  assert.equal(classifyFailure('You\'ve hit your limit · resets Nov 18 at 9:30pm (UTC)', NOW).until, Date.parse('2026-11-18T21:30:00Z'));
  assert.equal(classifyFailure('You\'ve hit your limit · resets Nov 18 at 9am (Nowhere/Zone)', NOW).until, Date.parse('2026-11-18T09:00:00Z')); // unknown zone: UTC
});
