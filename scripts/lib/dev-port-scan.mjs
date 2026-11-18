#!/usr/bin/env node
// Coarse dev→v2 content-presence matrix for port QA.
//
// Extracts distinctive tokens from every content commit between <base> and
// <src>, then batch-greps them against each target tree. A commit scores
// PRESENT (>= 0.6 of its tokens found), PARTIAL (>= 0.2), MISSING, or NOTOK
// (no tokens extractable; needs a manual read).
//
// IMPORTANT — this is a COARSE SCREEN, never a verdict. Generic vocabulary
// from an adjacent wave can satisfy every token (the pool-selection gate
// once scored PRESENT on generic pool words while its doctrine was absent).
// A wave counts as ported only when its doctrine text AND its acceptance
// tests exist on the target tree. Use this tool to find candidates for a
// manual read and to record before/after evidence in port receipts.
//
// Usage:
//   node scripts/lib/dev-port-scan.mjs [--base <ref>] [--src <ref>] [--targets r1,r2]
// The default base is the merge-base of HEAD and <src>; commits whose subject
// matches the release-chore pattern are excluded.
//
// Example:
//   node scripts/lib/dev-port-scan.mjs --src origin/dev \
//     --targets HEAD,origin/dev-port/pr-1,origin/dev-port/pr-3

import { execFileSync } from 'node:child_process';

function git(args) {
  try {
    return {
      code: 0,
      out: execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
    };
  } catch (error) {
    if (error.status === undefined || error.status > 1) {
      throw new Error(`git ${args.join(' ')} failed: ${(error.stderr || '').trim()}`, { cause: error });
    }
    return { code: error.status, out: error.stdout || '' };
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const src = arg('--src', 'origin/dev');
const targets = arg('--targets', 'HEAD')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const base = arg('--base', null) || git(['merge-base', 'HEAD', src]).out.trim();

const RELEASE_CHORE = /chore\(release\)|chore: set version|chore: sync README|AGENTS\.md tool count|chore: re-trigger/i;

const STOP = new Set([
  'HUAWEICLOUD_DEVKIT_HOME',
  'HUAWEICLOUD_DEVKIT_TELEMETRY',
  'HUAWEICLOUD_DEVKIT_TRACE',
  'HUAWEICLOUD_NPM_REGISTRY',
  'HUAWEICLOUD_SECRET_ACCESS_KEY',
  'HUAWEICLOUD_STATE_DIR',
  'HUAWEICLOUD_CONFIG_DIR',
  'UNLICENSED',
  'README',
  'MIT',
  'PACKAGE_LOCK',
  'en-US',
  'zh-CN',
  'function',
  'undefined',
  'prototype',
]);

const commits = [];
for (const line of git(['log', '--no-merges', '--format=%H|%h|%s', `${base}..${src}`]).out.split('\n')) {
  if (!line) continue;
  const [full, short, subject] = line.split('|');
  if (!RELEASE_CHORE.test(subject)) commits.push({ full, short, subject, tokens: [] });
}

// Token classes in priority order: error codes, long identifiers, snake_case,
// CJK doctrine phrases. Longest-first within a class, six tokens per commit.
function extractTokens(diff) {
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  const pool = new Map();
  const bump = (cls, tok) => {
    if (STOP.has(tok)) return;
    const key = cls + tok;
    pool.set(key, (pool.get(key) || 0) + 1);
  };
  for (const line of added) {
    for (const m of line.matchAll(/\b[A-Z][A-Z0-9_]{6,}\b/g)) bump('C', m[0]);
    for (const m of line.matchAll(/\b[a-z][A-Za-z0-9]{11,}\b/g)) bump('I', m[0]);
    for (const m of line.matchAll(/\b[a-z0-9]+_[a-z0-9_]{9,}\b/g)) bump('S', m[0]);
    for (const m of line.matchAll(/[\u4e00-\u9fff]{6,}/g)) bump('K', m[0]);
  }
  const order = { C: 0, I: 1, S: 2, K: 3 };
  return [...pool.keys()]
    .sort((a, b) => {
      const oa = order[a[0]];
      const ob = order[b[0]];
      return oa !== ob ? oa - ob : b.length - a.length;
    })
    .slice(0, 6)
    .map((key) => key.slice(1));
}

for (const c of commits) c.tokens = extractTokens(git(['show', '--format=', c.full]).out);

const allTokens = [...new Set(commits.flatMap((c) => c.tokens))];
const hits = new Map();
for (const target of targets) {
  for (let i = 0; i < allTokens.length; i += 90) {
    const batch = allTokens.slice(i, i + 90);
    const pattern = batch.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const { out } = git(['grep', '-o', '-E', pattern, target, '--', '.']);
    for (const line of out.split('\n')) {
      if (!line) continue;
      const token = line.slice(line.lastIndexOf(':') + 1);
      const key = `${target} ${token}`;
      hits.set(key, (hits.get(key) || 0) + 1);
    }
  }
}

function fraction(target, tokens) {
  if (!tokens.length) return null;
  const found = tokens.filter((tok) => (hits.get(`${target} ${tok}`) || 0) > 0).length;
  return found / tokens.length;
}

function bucket(frac) {
  if (frac === null) return 'NOTOK';
  if (frac >= 0.6) return 'PRESENT';
  if (frac >= 0.2) return 'PARTIAL';
  return 'MISSING';
}

console.log(`# dev-port-scan  base=${base}  src=${src}  targets=${targets.join(',')}`);
console.log(`# content commits: ${commits.length}  tokens: ${allTokens.length}`);
console.log('# coarse screen only — PRESENT requires doctrine + acceptance-test confirmation');

const counts = new Map(targets.map((t) => [t, { PRESENT: 0, PARTIAL: 0, MISSING: 0, NOTOK: 0 }]));
for (const c of [...commits].reverse()) {
  const fr = targets.map((t) => fraction(t, c.tokens));
  const tags = fr.map((f) => bucket(f)[0]);
  fr.forEach((f, i) => counts.get(targets[i])[bucket(f)]++);
  const detail = targets.map((t, i) => `${t}=${fr[i] === null ? 'n/a' : fr[i].toFixed(2)}`).join(' ');
  console.log(`${tags.join('')} ${c.short} n=${c.tokens.length}  ${detail}  ${c.subject.slice(0, 90)}`);
}

console.log('\n# summary per target');
for (const t of targets) {
  const s = counts.get(t);
  console.log(`# ${t}: PRESENT=${s.PRESENT} PARTIAL=${s.PARTIAL} MISSING=${s.MISSING} NOTOK=${s.NOTOK}`);
}
