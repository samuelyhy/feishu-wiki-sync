import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { globToRegExp, matchesAny, shouldInclude } from '../src/glob.js';

describe('globToRegExp', () => {
  it('* 不跨目录', () => {
    assert.equal(globToRegExp('*.md').test('a.md'), true);
    assert.equal(globToRegExp('*.md').test('sub/a.md'), false);
  });

  it('** 跨任意层级，且能匹配零层', () => {
    assert.equal(globToRegExp('docs/**/*.md').test('docs/a.md'), true);
    assert.equal(globToRegExp('docs/**/*.md').test('docs/x/y/a.md'), true);
    assert.equal(globToRegExp('docs/**/*.md').test('other/a.md'), false);
  });

  it('? 匹配单个非斜杠字符', () => {
    assert.equal(globToRegExp('a?.md').test('ab.md'), true);
    assert.equal(globToRegExp('a?.md').test('a/.md'), false);
  });

  it('转义正则元字符', () => {
    assert.equal(globToRegExp('a.b.md').test('a.b.md'), true);
    assert.equal(globToRegExp('a.b.md').test('aXb.md'), false);
  });
});

describe('matchesAny', () => {
  it('任一命中即为真', () => {
    assert.equal(matchesAny('docs/a.md', ['nope/**', 'docs/*.md']), true);
    assert.equal(matchesAny('docs/a.md', ['nope/**']), false);
  });

  it('空模式列表不命中', () => {
    assert.equal(matchesAny('a.md', []), false);
  });
});

describe('shouldInclude', () => {
  it('exclude 优先于 include', () => {
    // 排除是「无论如何都不要碰」的强意图，不该被 include 命中而失效
    assert.equal(shouldInclude('docs/releases/v1.md', ['**/*.md'], ['**/releases/**']), false);
  });

  it('include 为空时默认全收', () => {
    assert.equal(shouldInclude('any/path.md', [], []), true);
  });

  it('命中 exclude 即排除', () => {
    assert.equal(shouldInclude('docs/a.draft.md', ['**/*.md'], ['**/*.draft.md']), false);
    assert.equal(shouldInclude('docs/a.md', ['**/*.md'], ['**/*.draft.md']), true);
  });

  it('Windows 风格反斜杠路径也能匹配', () => {
    assert.equal(shouldInclude('docs\\sub\\a.md', ['docs/**/*.md'], []), true);
  });
});
