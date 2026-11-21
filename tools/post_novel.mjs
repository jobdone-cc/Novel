#!/usr/bin/env node
// 每日小說 Threads 發文：讀網站上的 today.json，用 @jobdone.cc 發多圖貼文（超過 20 張以回覆接續）。
//
// 用法：
//   node tools/novel/post_novel.mjs            # 正式發文
//   node tools/novel/post_novel.mjs --dry-run  # 只印出要發的內容，不呼叫 API
//   node tools/novel/post_novel.mjs --chapter 1          # 指定發第 1 章
//   node tools/novel/post_novel.mjs --chapter 2 --force  # 已發過也重發
//
// 設定（環境變數）：
//   THREADS_TOKEN_FILE     預設 /home/jobdone/threads-fb/config/secrets/threads-jobdone-access-token（@jobdone.cc）
//   ACCOUNTS_JSON          預設 /home/jobdone/threads-fb/config/accounts.json（讀 threadsJobdone.userId / apiVersion）
//   NOVEL_TODAY_URL        預設 https://jobdone-cc.github.io/Novel/today.json
//   NOVEL_STATE_FILE       預設 ~/.novel_threads_state.json（記錄已發過的章節，避免重發）
//   NOVEL_TOPIC_TAG        預設 工地日常
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const CHAPTER = (process.argv[process.argv.indexOf('--chapter') + 1] || '').padStart(3, '0');
const PICK = process.argv.includes('--chapter');
const ACCOUNTS = process.env.ACCOUNTS_JSON || '/home/jobdone/threads-fb/config/accounts.json';
const TODAY_URL = process.env.NOVEL_TODAY_URL || 'https://jobdone-cc.github.io/Novel/today.json';
const STATE = process.env.NOVEL_STATE_FILE || path.join(os.homedir(), '.novel_threads_state.json');
const TAG = process.env.NOVEL_TOPIC_TAG || '工地日常';

const TOKEN_FILE = process.env.THREADS_TOKEN_FILE || '/home/jobdone/threads-fb/config/secrets/threads-jobdone-access-token';
const token = process.env.THREADS_ACCESS_TOKEN ||
  (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '');
const acct = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')).threadsJobdone;
if (!acct?.userId) throw new Error('accounts.json 找不到 threadsJobdone.userId');
const API = `https://graph.threads.net/${acct.apiVersion || 'v1.0'}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { posted: {} };

async function call(pathname, params, method = 'POST') {
  const url = new URL(`${API}/${pathname}`);
  for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, v);
  const res = await fetch(url, { method, signal: AbortSignal.timeout(60000) });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`${pathname}: ${JSON.stringify(body.error || body)}`);
  return body;
}

async function waitReady(id) {
  for (let i = 0; i < 30; i++) {
    const { status, error_message } = await call(id, { fields: 'status,error_message' }, 'GET');
    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`container ${id}: ${status} ${error_message || ''}`);
    await sleep(5000);
  }
  throw new Error(`container ${id}: 等待處理逾時`);
}

async function postCarousel(images, text, replyTo) {
  const children = [];
  for (const [n, image_url] of images.entries()) {
    const { id } = await call(`${acct.userId}/threads`, { media_type: 'IMAGE', image_url, is_carousel_item: 'true' });
    children.push(id);
    console.log(`  上傳圖片 ${n + 1}/${images.length}`);
  }
  for (const [n, id] of children.entries()) { await waitReady(id); console.log(`  圖片處理完成 ${n + 1}/${children.length}`); }
  console.log('  組成多圖貼文中…');
  const params = { media_type: 'CAROUSEL', children: children.join(','), text };
  if (replyTo) params.reply_to_id = replyTo;
  else params.topic_tag = TAG;
  const { id: container } = await call(`${acct.userId}/threads`, params);
  await waitReady(container);
  const { id } = await call(`${acct.userId}/threads_publish`, { creation_id: container });
  return id;
}

const SRC = PICK ? TODAY_URL.replace(/today\.json$/, `posts/${CHAPTER}.json`) : TODAY_URL;
console.log(`讀取 ${SRC}`);
const today = await (await fetch(SRC, { cache: 'no-store', signal: AbortSignal.timeout(30000) })).json();
const taipeiToday = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
if (!DRY && !PICK && today.date && today.date !== taipeiToday) {
  console.log(`網站上的章節日期是 ${today.date}，今天是 ${taipeiToday}，新章還沒上架，稍後再試。`);
  process.exit(0);
}
if (state.posted[today.chapter] && !FORCE) {
  console.log(`第 ${today.chapter} 章已經發過（${state.posted[today.chapter].join(', ')}），略過。`);
  process.exit(0);
}

const total = today.posts.length;
const texts = today.posts.map((_, i) => i === 0
  ? `${today.title}\n\n全文：${today.url}\n\n#${TAG}`
  : `${today.title}（續 ${i + 1}/${total}）`);

if (DRY) {
  today.posts.forEach((imgs, i) => console.log(`--- 貼文 ${i + 1}/${total}（${imgs.length} 張）---\n${texts[i]}\n${imgs.join('\n')}`));
  process.exit(0);
}
if (!token) throw new Error('沒有 token：請設定 THREADS_ACCESS_TOKEN 或 THREADS_TOKEN_FILE');

console.log(`開始發第 ${today.chapter} 章：${today.title}（${total} 則貼文）`);
const ids = FORCE ? [] : (state.partial?.[today.chapter] || []);
if (ids.length) console.log(`接續上次中斷的進度：已發 ${ids.length}/${total} 則`);
for (let i = ids.length; i < total; i++) {
  console.log(`貼文 ${i + 1}/${total}（${today.posts[i].length} 張圖）`);
  const id = await postCarousel(today.posts[i], texts[i], ids[ids.length - 1]);
  ids.push(id);
  state.partial = { ...(state.partial || {}), [today.chapter]: ids };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`已發貼文 ${i + 1}/${total}：${id}`);
}
state.posted[today.chapter] = ids;
if (state.partial) delete state.partial[today.chapter];
fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
console.log('完成。');
