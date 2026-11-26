import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, DEFAULT_COOL_MIN } from '../lib/limits.mjs';

const NOW = Date.parse('2026-11-16T14:30:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Texts seen in real runs (cofre3d, Open3dFarmManager; Mac and host-1, 2026-11-13..17), as the thread's last reply.
const REAL = {
  antigravity: 'Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 5 days, 4 hours.',
  antigravityMinutes: 'Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 4 days, 33 minutes.',
  antigravity15: '\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 113h11m4s.\n', // CLI 1.5.13, host-2 2026-11-20
  claude: "You've hit your Fable limit · resets Nov 17 at 12am (America/Sao_Paulo). Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
  codex: 'You’ve hit your usage limit. Visit <url> to purchase more credits or try again at Nov 9th, 2026 11:58 AM.',
  capacity: 'No capacity available for model gemini-3.8-flash-high on the server',
};

test('real usage-limit replies are limits, with the reset time the provider gave', () => {
  const ag = classifyFailure(REAL.antigravity, NOW);
  assert.deepEqual([ag.kind, ag.until, ag.reason], ['limit', NOW + 5 * DAY + 4 * HOUR, 'Usage Limit Reached']);
  assert.equal(classifyFailure(REAL.antigravityMinutes, NOW).until, NOW + 4 * DAY + 33 * MIN);
  for (const strict of [false, true]) {
    const ag15 = classifyFailure(REAL.antigravity15, NOW, { strict });
    assert.deepEqual([ag15.kind, ag15.until], ['limit', NOW + 113 * HOUR + 11 * MIN + 4000]);
    assert.match(ag15.reason, /Individual quota reached/);
  }
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
    '', null, undefined,
  ]) assert.equal(classifyFailure(t, NOW), null, String(t).slice(0, 40));
});

// Shapes seen 2026-11-20..26 that the first-line, 600-character reading missed.
const NARRATION = 'Reading the upload service and its tests to find where the retry belongs.\n'.repeat(40); // about 3 KB
const SHAPES = {
  minimax: 'Token Plan usage limit reached (2056)',
  quota: 'Quota reached',
  reached: `You have reached your quota. ${'Details of the plan and its windows follow. '.repeat(14)}`, // 629 characters
  codex: 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 27th, 2026 3:05 PM.',
};

test('long texts and newer shapes: MiniMax, a bare "Quota reached", a long quota line, a refusal after narration', () => {
  for (const strict of [false, true]) {
    for (const [name, t] of Object.entries(SHAPES)) assert.equal(classifyFailure(t, NOW, { strict })?.kind, 'limit', `${name} strict=${strict}`);
    // the refusal comes after 3 KB of the worker's own narration, or past the 4 KB tail of a longer one
    for (const t of [REAL.antigravity15, SHAPES.minimax, SHAPES.codex]) {
      assert.equal(classifyFailure(`${NARRATION}\n${t}`, NOW, { strict })?.kind, 'limit', `${t.slice(0, 30)} strict=${strict}`);
      assert.equal(classifyFailure(`${NARRATION.repeat(4)}\n${t}`, NOW, { strict })?.kind, 'limit', `${t.slice(0, 30)} long, strict=${strict}`);
    }
  }
  // the reset is read from the refusal, not from the narration before it
  const ag = classifyFailure(`Will try again in 2 minutes.\n${NARRATION}${REAL.antigravity15}`, NOW);
  assert.equal(ag.until, NOW + 113 * HOUR + 11 * MIN + 4000);
  assert.match(ag.reason, /^⚠ Individual quota reached/);
  const codex = classifyFailure(`${NARRATION}${SHAPES.codex}`, Date.parse('2026-11-26T15:00:00Z'));
  assert.equal(codex.until, new Date(2026, 10, 27, 15, 5).getTime());
  assert.equal(classifyFailure(`Usage limit reached ${'x'.repeat(700)}`, NOW).kind, 'limit'); // a long line is still a refusal
});

test('long prose that only mentions quotas and limits is no failure', () => {
  const prose = [
    'The service now returns "Quota reached" when a tenant uploads past its plan.',
    'Added a banner: you have reached your quota is shown above the upload form.',
    'Quota reached events are now logged with the tenant id.',
    'Token plan usage limits are documented in docs/billing.md.',
    'DONE: usage limit reached handling covered by tests; the 429 path retries.',
    '- Quota reached.',
    '> You have reached your quota',
  ];
  for (const strict of [false, true]) {
    assert.equal(classifyFailure(`${NARRATION}${prose.join('\n')}\n${NARRATION}`, NOW, { strict }), null, `strict=${strict}`);
    assert.equal(classifyFailure(`${NARRATION.repeat(4)}${prose.join('\n')}`, NOW, { strict }), null, `long, strict=${strict}`);
  }
  // a completed turn is judged by its first and last lines only: a refusal quoted mid-report is not one
  assert.equal(classifyFailure(`DONE\n${SHAPES.minimax}\nAll tests pass.`, NOW, { strict: true }), null);
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

test('review fix 1: worker narration on a failed thread is no limit; a code needs error context', () => {
  for (const t of ['429 tests pass, 0 fail', '401 files changed', 'Rate limited the retry loop to 3 attempts.', 'Too many requests handling added to the client.',
    'Overloaded constructor fixed', '503 handler added for the status page', 'Rate limit reached in the docs example is now explained.']) {
    assert.equal(classifyFailure(t, NOW), null, t);
  }
  for (const [t, kind] of [['429 Too Many Requests', 'limit'], ['Error: 429 rate limited', 'limit'], ['Rate limited: try again in 30 seconds', 'limit'],
    ['Too many requests. Retry after 60s.', 'limit'], ['503 Service Unavailable', 'capacity'], ['Error: 529 {"type":"overloaded_error"}', 'capacity'],
    ['401 Unauthorized', 'auth'], ['Error: rate_limit_error', 'limit']]) {
    assert.equal(classifyFailure(t, NOW)?.kind, kind, t);
  }
});

test('review fix 2: current claude and gemini texts', () => {
  const local = (y, mo, d, h) => new Date(y, mo, d, h).getTime();
  const five = classifyFailure('5-hour limit reached ∙ resets 3pm', NOW, { strict: true });
  assert.equal(five.kind, 'limit');
  assert.ok(five.until > NOW && five.until <= NOW + 24 * HOUR && new Date(five.until).getHours() === 15);
  assert.equal(classifyFailure('Weekly limit reached ∙ resets Nov 20, 5pm', NOW, { strict: true }).until, local(2026, 10, 20, 17));
  assert.equal(classifyFailure('Claude usage limit reached. Your limit will reset at 3pm (America/Los_Angeles)', NOW, { strict: true }).until, Date.parse('2026-11-16T23:00:00Z'));
  const epoch = Math.floor((NOW + 2 * HOUR) / 1000);
  assert.equal(classifyFailure(`Claude AI usage limit reached|${epoch}`, NOW, { strict: true }).until, epoch * 1000);
  assert.equal(classifyFailure('RESOURCE_EXHAUSTED: Quota exceeded for quota metric generate_content_requests', NOW, { strict: true }).kind, 'limit');
  assert.equal(classifyFailure('OAuth token has expired. Please re-authenticate.', NOW, { strict: true }).kind, 'auth');
  assert.equal(classifyFailure('Limit reached for the pagination helper; tests pass.', NOW, { strict: true }), null);
});

test('review fix 4: compact durations', () => {
  assert.equal(classifyFailure('Rate limit reached. Please try again in 1h30m.', NOW).until, NOW + 90 * MIN);
  assert.equal(classifyFailure('Rate limit reached. Please try again in 6m0s.', NOW).until, NOW + 6 * MIN);
});

test('review fix 9: a zoned reset on a daylight-saving change uses the offset at the reset itself', () => {
  // 2026-11-01 is the US fall-back day: 3pm in Los Angeles that day is PST (UTC-8), the morning was PDT (UTC-7)
  const morning = Date.parse('2026-11-01T08:30:00Z'); // 01:30 PDT
  assert.equal(classifyFailure("You've hit your limit · resets Nov 1 at 3pm (America/Los_Angeles)", morning).until, Date.parse('2026-11-01T23:00:00Z'));
  // 2026-03-08 spring forward: 9am is PDT (UTC-7), the night before PST
  const night = Date.parse('2026-03-08T07:00:00Z'); // 23:00 PST Mar 7
  assert.equal(classifyFailure("You've hit your limit · resets Mar 8 at 9am (America/Los_Angeles)", night).until, Date.parse('2026-03-08T16:00:00Z'));
});
