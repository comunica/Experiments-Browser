#!/usr/bin/env node
// Builds Comunica from a comunica/comunica checkout, links the lite engine into node_modules,
// fetches dataset release assets, and installs the Playwright browsers. Idempotent.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const COMUNICA_DIR = resolve(process.env.COMUNICA_DIR ?? join(ROOT, '.cache', 'comunica'));
const COMUNICA_REF = process.env.COMUNICA_REF ?? pkg.config.comunicaCommit;

function run(cmd, args, cwd = ROOT) {
  console.log(`$ ${cmd} ${args.join(' ')}${cwd === ROOT ? '' : `  (in ${relative(ROOT, cwd) || '.'})`}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}
const git = (...args) => execFileSync('git', [ '-C', COMUNICA_DIR, ...args ], { encoding: 'utf8' }).trim();

// 1. Comunica checkout at COMUNICA_REF (a commit, or a branch such as `master`).
if (!existsSync(join(COMUNICA_DIR, '.git'))) {
  mkdirSync(dirname(COMUNICA_DIR), { recursive: true });
  run('git', [ 'clone', pkg.config.comunicaRepo, COMUNICA_DIR ]);
}
let target;
try {
  target = git('rev-parse', '--verify', '--quiet', `${COMUNICA_REF}^{commit}`);
} catch {
  target = undefined;
}
if (!target || !/^[0-9a-f]{40}$/u.test(COMUNICA_REF)) {
  run('git', [ '-C', COMUNICA_DIR, 'fetch', '--quiet', 'origin' ]);
  const ref = /^[0-9a-f]{7,40}$/u.test(COMUNICA_REF) ? COMUNICA_REF : `origin/${COMUNICA_REF}`;
  target = git('rev-parse', '--verify', `${ref}^{commit}`);
}
if (git('rev-parse', 'HEAD') !== target) {
  run('git', [ '-C', COMUNICA_DIR, 'checkout', '--quiet', '--detach', target ]);
}

// 2. yarn install (its postinstall already builds) and yarn build, once per commit.
const marker = join(COMUNICA_DIR, '.bench-built');
if (!existsSync(marker) || readFileSync(marker, 'utf8').trim() !== target) {
  run('yarn', [ 'install', '--frozen-lockfile' ], COMUNICA_DIR);
  run('yarn', [ 'build' ], COMUNICA_DIR);
  writeFileSync(marker, `${target}\n`);
}

// 3. Link the built packages (equivalent to `npm link`): their dependencies resolve inside the checkout.
const links = {
  '@comunica/query-sparql-rdfjs-lite': join(COMUNICA_DIR, 'engines', 'query-sparql-rdfjs-lite'),
  '@comunica/utils-iterator': join(COMUNICA_DIR, 'packages', 'utils-iterator'),
};
for (const [ name, dir ] of Object.entries(links)) {
  const link = join(ROOT, 'node_modules', name);
  mkdirSync(dirname(link), { recursive: true });
  try {
    lstatSync(link);
    rmSync(link, { recursive: true, force: true });
  } catch {}
  symlinkSync(relative(dirname(link), dir), link, 'dir');
}
const lite = JSON.parse(readFileSync(join(links['@comunica/query-sparql-rdfjs-lite'], 'package.json'), 'utf8'));
const build = {
  repository: pkg.config.comunicaRepo,
  ref: COMUNICA_REF,
  commit: target,
  commitDate: git('show', '-s', '--format=%cI', target),
  commitSubject: git('show', '-s', '--format=%s', target),
  packageVersion: lite.version,
  dirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
};
mkdirSync(join(ROOT, '.cache'), { recursive: true });
writeFileSync(join(ROOT, '.cache', 'comunica-build.json'), `${JSON.stringify(build, null, 2)}\n`);
console.log(`Comunica ${lite.version} @ ${target} linked into node_modules`);

// 4. Datasets that exceed GitHub's file size limit live in release assets (data/<name>/release-asset.json).
for (const name of readdirSync(join(ROOT, 'data'))) {
  const assetFile = join(ROOT, 'data', name, 'release-asset.json');
  if (!existsSync(assetFile)) {
    continue;
  }
  const asset = JSON.parse(readFileSync(assetFile, 'utf8'));
  const dest = join(ROOT, 'data', name, asset.file);
  const sha = () => createHash('sha256').update(readFileSync(dest)).digest('hex');
  if (!existsSync(dest) || sha() !== asset.sha256) {
    run('curl', [ '-fL', '--retry', '4', '-o', dest, asset.url ]);
    if (sha() !== asset.sha256) {
      throw new Error(`Checksum mismatch for ${dest}`);
    }
  }
}

// 5. Browsers for the runner (skipped when already present).
if (!process.env.BENCH_SKIP_BROWSER_INSTALL) {
  run('npx', [ 'playwright', 'install', 'chromium', 'firefox', 'webkit' ]);
}
