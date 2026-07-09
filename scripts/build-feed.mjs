#!/usr/bin/env node
// @ts-check
/**
 * build-feed.mjs — build-time data pipeline (NOT shipped to the browser).
 *
 * Google Drive folder of .mp4  ──►  normalized web-safe MP4 + poster JPG + paginated manifest
 *
 * The running app has zero external dependencies: it only ever fetches the static
 * JSON + media this script produces. See ARCHITECTURE.md §4.
 *
 * Usage:
 *   node scripts/build-feed.mjs                  # download from the Drive folder, then process
 *   node scripts/build-feed.mjs --local          # skip download; process whatever is in RAW_DIR
 *   node scripts/build-feed.mjs --page-size=8
 *
 * Requires on PATH: ffmpeg, ffprobe, and (unless --local) gdown (`pip install -U gdown`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  FEED_DIR,
  INDEX_FILE,
  PAGE_FILE_RE,
  pageCount,
  pageFileName,
} from '../src/data/manifest.js';

const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/1L5lsFtOUSaIFt0nzQgo7fbAezBc0nBh-';

const ROOT = new URL('..', import.meta.url).pathname;
const RAW_DIR = join(ROOT, 'scripts/.cache/raw'); // downloaded originals (git-ignored)
const VIDEO_DIR = join(ROOT, 'public/videos'); // normalized, committed
const POSTER_DIR = join(ROOT, 'public/posters'); // committed
const FEED_OUT = join(ROOT, FEED_DIR); // manifest, committed (dir name shared with the runtime)

// One scale target for video AND poster — they must match, or the
// poster→first-frame handoff visibly jumps.
const SCALE = 'scale=-2:960';

const args = process.argv.slice(2);
const LOCAL = args.includes('--local');
const PAGE_SIZE = Number((args.find((a) => a.startsWith('--page-size=')) ?? '').split('=')[1] || 8);

/** @param {string} msg */
const log = (msg) => process.stdout.write(`  ${msg}\n`);
/** @param {string} msg */
const step = (msg) => process.stdout.write(`\n▸ ${msg}\n`);

/**
 * Check a CLI tool exists, or exit with an actionable message.
 * @param {string} bin @param {string} hint
 */
function requireTool(bin, hint) {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });

  if (r.status !== 0 && r.error) {
    console.error(`\n✗ "${bin}" not found on PATH. ${hint}`);
    process.exit(1);
  }
}

/**
 * Deterministic small hash → used to synthesize author/caption without randomness.
 * @param {string} str @returns {number}
 */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Filename → stable, URL-safe slug id (Drive names have spaces/unicode/dupes).
 * @param {string} name @param {Set<string>} seen @returns {string}
 */
function slugify(name, seen) {
  const base =
    basename(name, extname(name))
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'clip';
  let id = base;
  let n = 2;
  while (seen.has(id)) {
    id = `${base}-${n++}`;
  }
  seen.add(id);
  return id;
}

const AUTHORS = ['@nova', '@driftwood', '@peachy', '@kilo', '@mika', '@volt', '@sable', '@echo'];
const CAPTIONS = [
  'POV: the algorithm found you 👀',
  'wait for it… 🔥',
  'no because why is this so real',
  'saving this for later fr',
  'the vibes are immaculate ✨',
  'tell me you relate without telling me',
  'this took 47 takes 😭',
  'day 1 of posting until it works',
];

/** ffprobe → { duration, width, height }. @param {string} file */
function probe(file) {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:format=duration',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  const j = JSON.parse(out);
  const s = j.streams?.[0] ?? {};
  return {
    duration: Math.round((Number(j.format?.duration) || 0) * 100) / 100,
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
  };
}

// ── 1. Download ────────────────────────────────────────────────────────────
if (!LOCAL) {
  step(`Downloading videos from Google Drive folder`);
  requireTool('gdown', 'Install with: pip install -U gdown');
  mkdirSync(RAW_DIR, { recursive: true });
  // gdown handles the large-file virus-scan confirm token automatically. (Older
  // gdown lacks --remaining-ok; a folder with >50 files just prints a warning.)
  const r = spawnSync('gdown', ['--folder', '-O', RAW_DIR, DRIVE_FOLDER], {
    stdio: 'inherit',
  });

  if (r.status !== 0) {
    console.error(
      '\n✗ Download failed. Common causes:\n' +
        '  • >50 files in the folder (Drive listing cap) — download in batches or use rclone.\n' +
        '  • HTTP 403 "quota exceeded" — copy the folder to your own Drive and point --folder there.\n' +
        '  Then re-run with --local to process what did download.',
    );
    process.exit(1);
  }
} else {
  step(`--local: skipping download, using ${RAW_DIR}`);
}

// ── 2. Normalize + poster + probe ────────────────────────────────────────────
step('Normalizing videos (H.264 / yuv420p / +faststart) and extracting posters');
requireTool('ffmpeg', 'Install with: apt install ffmpeg  (or) brew install ffmpeg');
requireTool('ffprobe', 'Comes with ffmpeg.');

for (const dir of [VIDEO_DIR, POSTER_DIR, FEED_OUT]) {
  mkdirSync(dir, { recursive: true });
}

const rawFiles = existsSync(RAW_DIR)
  ? readdirSync(RAW_DIR)
      .filter((f) => /\.(mp4|mov|webm|m4v)$/i.test(f))
      .sort()
  : [];

if (rawFiles.length === 0) {
  console.error(`\n✗ No source videos in ${RAW_DIR}. Run without --local, or drop files there.`);
  process.exit(1);
}

const seen = new Set();
/** @type {Array<{id:string,src:string,poster:string,author:string,caption:string,duration:number,width:number,height:number,likes:number}>} */
const items = [];

for (const [i, file] of rawFiles.entries()) {
  const id = slugify(file, seen);
  const src = join(RAW_DIR, file);
  const outVideo = join(VIDEO_DIR, `${id}.mp4`);
  const outPoster = join(POSTER_DIR, `${id}.jpg`);

  log(`[${i + 1}/${rawFiles.length}] ${file} → ${id}`);

  // yuv420p → decodes in every browser; +faststart → moov atom first → instant start.
  // crf 27 + 960p + 96k audio: demo-grade quality at roughly half the size, so the
  // committed repo stays light for reviewers cloning it.
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    src,
    '-c:v',
    'libx264',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '27',
    '-preset',
    'slower',
    '-vf',
    SCALE,
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    outVideo,
  ]);

  // -ss 0 first frame; if it's black in practice, bump to 00:00:01.
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    '0',
    '-i',
    outVideo,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    '-vf',
    SCALE,
    outPoster,
  ]);

  const meta = probe(outVideo);
  const h = hash(id);
  items.push({
    id,
    src: `public/videos/${id}.mp4`,
    poster: `public/posters/${id}.jpg`,
    author: /** @type {string} */ (AUTHORS[h % AUTHORS.length]),
    caption: /** @type {string} */ (CAPTIONS[(h >> 3) % CAPTIONS.length]),
    likes: 1000 + (h % 90000),
    ...meta,
  });
}

// ── 3. Emit paginated manifest ───────────────────────────────────────────────
step('Writing paginated manifest');
// Clear old pages so a shrunk feed doesn't leave stale pages behind.
for (const f of readdirSync(FEED_OUT).filter((f) => PAGE_FILE_RE.test(f))) {
  rmSync(join(FEED_OUT, f));
}

const total = items.length;
const totalPages = pageCount(total, PAGE_SIZE);
for (let p = 0; p < totalPages; p++) {
  const page = items.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  writeFileSync(join(FEED_OUT, pageFileName(p)), JSON.stringify(page, null, 2));
}
// No totalPages field: the consumer derives it via pageCount() — one source.
writeFileSync(join(FEED_OUT, INDEX_FILE), JSON.stringify({ pageSize: PAGE_SIZE, total }, null, 2));

log(`✓ ${total} videos → ${totalPages} page(s) of ${PAGE_SIZE}`);
step('Done. Run `npm start` and open the feed.');
