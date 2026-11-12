import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesAny } from '../lib/glob.mjs';

const m = (glob, p) => globToRegExp(glob).test(p);

test('a/** matches any depth below a', () => {
  assert.ok(m('a/**', 'a/x'));
  assert.ok(m('a/**', 'a/x/y'));
  assert.ok(!m('a/**', 'b/x'));
  assert.ok(!m('a/**', 'ab/x'));
});

test('**/x matches x at any depth including none', () => {
  assert.ok(m('**/x', 'x'));
  assert.ok(m('**/x', 'a/x'));
  assert.ok(m('**/x', 'a/b/x'));
  assert.ok(!m('**/x', 'xy'));
  assert.ok(!m('**/x', 'a/xy'));
});

test('a/**/b matches zero or more directories between', () => {
  assert.ok(m('a/**/b', 'a/b'));
  assert.ok(m('a/**/b', 'a/x/b'));
  assert.ok(m('a/**/b', 'a/x/y/b'));
  assert.ok(!m('a/**/b', 'a/x/c'));
});

test('bare ** matches everything', () => {
  assert.ok(m('**', 'a'));
  assert.ok(m('**', 'a/b/c.txt'));
});

test('* does not cross a slash', () => {
  assert.ok(m('*.js', 'a.js'));
  assert.ok(!m('*.js', 'a/b.js'));
  assert.ok(m('src/*.js', 'src/a.js'));
  assert.ok(!m('src/*.js', 'src/x/a.js'));
});

test('? matches exactly one non-slash char', () => {
  assert.ok(m('a?c', 'abc'));
  assert.ok(!m('a?c', 'ac'));
  assert.ok(!m('a?c', 'a/c'));
});

test('regex metacharacters are literal and the match is anchored', () => {
  assert.ok(!m('a.b', 'axb'));
  assert.ok(m('a.b', 'a.b'));
  assert.ok(m('a+b(1)[x]{2}|$^', 'a+b(1)[x]{2}|$^'));
  assert.ok(!m('a', 'ba'));
  assert.ok(!m('a', 'ab'));
});

test('invalid globs throw', () => {
  for (const bad of ['', 5, null, undefined, {}]) assert.throws(() => globToRegExp(bad), /glob/);
});

test('matchesAny', () => {
  assert.ok(matchesAny('lib/a.mjs', ['test/**', 'lib/*.mjs']));
  assert.ok(!matchesAny('x.md', ['lib/**']));
  assert.ok(!matchesAny('x.md', []));
  assert.throws(() => matchesAny('x', 'lib/**'), /globs/);
  assert.throws(() => matchesAny('', ['a']), /path/);
});
