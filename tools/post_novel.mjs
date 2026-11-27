#!/usr/bin/env node
// 每日小說 Threads 發文：讀網站上的 today.json，用 @jobdone.cc 發「封面圖＋純文字開場」主文，
// 再在第一則回覆放全文連結（主文不放連結，避免降觸及）。
//
// 用法：
//   node tools/novel/post_novel.mjs            # 正式發文
//   node tools/novel/post_novel.mjs --dry-run  # 只印出要發的內容，不呼叫 API
//   node tools/novel/post_novel.mjs --chapter 1          # 指定發第 1 章
//   node tools/novel/post_novel.mjs --chapter 2 --force  # 已發過也重發
//   node tools/novel/post_novel.mjs --chapter 3 --force --time1500  # 排一次：台灣時間 15:00 發（也可寫 --time 1500）
//     排程會在背景等待，關掉終端機也照發；但主機重開機會取消。取消：kill <PID>（排程時會印出）。
//
// 設定（環境變數）：
//   THREADS_TOKEN_FILE     預設 /home/jobdone/threads-fb/config/secrets/threads-jobdone-access-token（@jobdone.cc）
//   ACCOUNTS_JSON          預設 /home/jobdone/threads-fb/config/accounts.json（讀 threadsJobdone.userId / apiVersion）
//   NOVEL_TODAY_URL        預設 https://jobdone-cc.github.io/Novel/today.json
//   NOVEL_STATE_FILE       預設 ~/.novel_threads_state.json（記錄已發過的章節，避免重發）
//   NOVEL_TOPIC_TAG        預設 工地日常
//   REPOST_TOKEN_FILE      預設 /home/jobdone/threads-fb/config/secrets/threads-jobdoing-access-token
//                          （@jobdoing 的 token；有這個檔就在發完後用 @jobdoing 轉發主文，沒有就略過）
//   --no-repost            這次不轉發
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';


// --time1500 / --time 1500：在台灣時間指定時刻發一次（背景等待）
{
  const i = process.argv.findIndex(a => /^--time\d*$/.test(a));
  if (i >= 0 && !process.env.NOVEL_RUN_AT) {
    const hhmm = process.argv[i].slice(6) || process.argv[i + 1] || '';
    if (!/^\d{3,4}$/.test(hhmm)) throw new Error('時間格式：--time1500 或 --time 1500（台灣時間，24 小時制）');
    const hh = +hhmm.slice(0, -2), mm = +hhmm.slice(-2);
    if (hh > 23 || mm > 59) throw new Error(`時間不對：${hhmm}`);
    const now = Date.now();
    const tw = new Date(now + 8 * 3600e3);
    let at = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate(), hh, mm) - 8 * 3600e3;
    if (at <= now) at += 24 * 3600e3;
    const args = process.argv.slice(2).filter((a, k) => k + 2 !== i && !(process.argv[i] === '--time' && k + 2 === i + 1));
    const when = new Date(at + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    const log = path.join(path.dirname(process.argv[1]), `scheduled-${when.replace(/[ :]/g, '')}.log`);
    const out = fs.openSync(log, 'a');
    const child = spawn(process.execPath, [process.argv[1], ...args], {
      detached: true, stdio: ['ignore', out, out], env: { ...process.env, NOVEL_RUN_AT: String(at) },
    });
    child.unref();
    console.log(`已排程：台灣時間 ${when} 執行 post_novel.mjs ${args.join(' ')}`);
    console.log(`背景 PID ${child.pid}（取消：kill ${child.pid}），紀錄寫在 ${log}`);
    process.exit(0);
  }
  if (process.env.NOVEL_RUN_AT) {
    const wait = +process.env.NOVEL_RUN_AT - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    console.log(`[${new Date().toISOString()}] 排程時間到，開始執行`);
  }
}

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

async function publish(params) {
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

if (!today.text || !today.image) throw new Error('today.json 格式不對（缺 text 或 image），網站可能還沒更新到新版');

if (DRY) {
  console.log(`--- 主文（封面圖＋文字，${today.text.length} 字）---\n${today.image}\n${today.text}\n#${TAG}`);
  console.log(`--- 第一則回覆 ---\n${today.reply_text}`);
  process.exit(0);
}
if (!token) throw new Error('沒有 token：請設定 THREADS_ACCESS_TOKEN 或 THREADS_TOKEN_FILE');

console.log(`開始發第 ${today.chapter} 章：${today.title}`);
const ids = FORCE ? [] : (state.partial?.[today.chapter] || []);
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
if (!ids[0]) {
  console.log('發主文（封面圖＋開場文字）…');
  ids[0] = await publish({ media_type: 'IMAGE', image_url: today.image, text: today.text, topic_tag: TAG });
  state.partial = { ...(state.partial || {}), [today.chapter]: ids }; save();
  console.log(`主文：${ids[0]}`);
}
if (!ids[1]) {
  await sleep(5000);
  console.log('發第一則回覆（全文連結）…');
  ids[1] = await publish({ media_type: 'TEXT', text: today.reply_text, reply_to_id: ids[0] });
  console.log(`回覆：${ids[1]}`);
}
const REPOST_FILE = process.env.REPOST_TOKEN_FILE || '/home/jobdone/threads-fb/config/secrets/threads-jobdoing-access-token';
const repostToken = process.env.REPOST_ACCESS_TOKEN ||
  (fs.existsSync(REPOST_FILE) ? fs.readFileSync(REPOST_FILE, 'utf8').trim() : '');
if (process.argv.includes('--no-repost')) {
  console.log('--no-repost：這次不轉發。');
} else if (!repostToken) {
  console.log(`沒有 @jobdoing token（${REPOST_FILE}），略過轉發。`);
} else if (!ids[2]) {
  await sleep(5000);
  console.log('用 @jobdoing 轉發主文…');
  try {
    const url = new URL(`${API}/${ids[0]}/repost`);
    url.searchParams.set('access_token', repostToken);
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(60000) });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(JSON.stringify(body.error || body));
    ids[2] = body.id;
    console.log(`轉發：${ids[2]}`);
  } catch (e) {
    console.log(`轉發失敗（主文已發成功，不影響）：${e.message}`);
  }
}
state.posted[today.chapter] = ids;
if (state.partial) delete state.partial[today.chapter];
save();
console.log('完成。');
