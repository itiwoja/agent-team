#!/usr/bin/env node
/**
 * build済みイメージの手順1.2実機検査。Node 24 / Docker / package依存のwsが必要。
 *   node apps/box-agent/test/vm-check.mjs [image]
 *   VM_CHECK_IMAGE=makase-s1.2-box-browser node apps/box-agent/test/vm-check.mjs
 * 上書き可能な設定はimageだけ。build/pullしない。全URLはコンテナ内loopback。
 * 画像・秘匿処理済みログは /tmp/opencode/box-agent-vm-check-* に残す。
 * 既定seccompでのfallback・主要子プロセス個別死亡は親の別検査に委ねる。
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PAGES = join(ROOT, 'evals/pages');
const SECCOMP = join(ROOT, 'docker/makase-browser-seccomp.json');
const EPOCH = 7;
const HTTP_TIMEOUT = 15_000;
const START_TIMEOUT = 60_000;
const LABEL = 'open-team.box-agent-vm-check';
const runId = randomBytes(12).toString('hex');
const prefix = `makase-vm-check-${runId}`;
const profile = `${prefix}-profile`;
const wrongToken = randomBytes(32).toString('hex');
const tokens = new Set([wrongToken]);
const protectedText = new Set([wrongToken]);
const containers = new Set();
const anonymousVolumes = new Set();
const lifetime = new AbortController();
let current;
let artifacts;
let profileRequested = false;
let secretValues = [];
let checkNumber = 0;

class CheckFailure extends Error {}
function check(condition, message) { if (!condition) throw new CheckFailure(message); }
function object(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new CheckFailure(`${label}: JSON形式ではありません`); }
}
function passed(message) { console.log(`ok ${++checkNumber} - ${message}`); }
function token() {
  const value = randomBytes(32).toString('hex');
  tokens.add(value);
  protectedText.add(value);
  return value;
}
function noToken(text, label) {
  check([...tokens].every((value) => !text.includes(value)), `${label}: 資格の漏出を検出しました`);
}
function redact(text) {
  for (const value of [...protectedText].sort((a, b) => b.length - a.length)) {
    if (value) text = text.replaceAll(value, '[REDACTED]');
  }
  return text;
}

// execFileのerror.messageにはコマンドやstderrが入り得るため、そのまま報告しない。
function docker(args, { timeout = 10_000, env = process.env, input = '', allowFailure = false, cleanup = false } = {}) {
  return new Promise((resolveResult, reject) => {
    // docker execは起動時Config.Envを再利用するため、検査用Python/Nodeにも資格を継承させない。
    const commandArgs = args[0] === 'exec'
      ? ['exec', '--env', 'BROWSER_TOKEN=', '--env', 'SHELL_TOKEN=', ...args.slice(1)] : args;
    const child = execFile('docker', commandArgs, {
      env, encoding: 'utf8', shell: false, timeout, killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      ...(cleanup ? {} : { signal: lifetime.signal }),
    }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new CheckFailure(`Docker ${args[0]} ${args[1] ?? ''}: 失敗または期限超過（生ログは表示しません）`));
      } else resolveResult({ ok: !error, stdout, stderr });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input, 'utf8');
  });
}

async function inspect(format, name = current.name) {
  const result = await docker(['inspect', '--format', format, name]);
  return parseJson(result.stdout, 'docker inspect');
}

async function request(path, { method = 'GET', body, raw, contentType = 'application/json', auth = current.token, timeout = HTTP_TIMEOUT } = {}) {
  const headers = {};
  if (auth !== null) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = contentType;
  let response;
  let bytes;
  try {
    response = await fetch(`${current.base}${path}`, {
      method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)]),
    });
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new CheckFailure('HTTP応答の上限を超えました');
      }
      chunks.push(Buffer.from(value));
    }
    bytes = Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    throw new CheckFailure(`HTTP ${method} ${path}: 接続失敗または期限超過`);
  }
  noToken(bytes.toString('utf8'), `HTTP ${path}`);
  noToken(JSON.stringify([...response.headers]), 'HTTPヘッダー');
  return { status: response.status, bytes, contentType: response.headers.get('content-type') };
}

function jsonResponse(response, status, label) {
  check(response.status === status, `${label}: HTTP ${status}を期待、実際は${response.status}`);
  check(response.contentType?.startsWith('application/json'), `${label}: Content-TypeがJSONではありません`);
  return parseJson(response.bytes.toString('utf8'), label);
}
function errorResponse(response, status, code, label) {
  const data = jsonResponse(response, status, label);
  check(object(data) && object(data.error) && data.error.code === code, `${label}: エラーコードが契約と異なります`);
  return data;
}
function actionBody(action, actionId = randomUUID(), controlEpoch = EPOCH) {
  return { actionId, controlEpoch, action };
}
async function post(body, options = {}) { return request('/actions', { ...options, method: 'POST', body }); }
async function action(kind, fields = {}, options = {}) {
  const data = jsonResponse(await post(actionBody({ kind, ...fields }), options), 200, `action ${kind}`);
  check(object(data) && data.executed === true, `action ${kind}: executed:trueがありません`);
  return data;
}
function validatePage(data) {
  check(object(data) && data.executed === true && Array.isArray(data.page) && typeof data.text === 'string', 'read_page: 応答の型が不正です');
  check(data.page.length <= 200 && Buffer.byteLength(JSON.stringify(data)) <= 16 * 1024, 'read_page: 件数/byte上限超過');
  for (const item of data.page) {
    check(object(item) && typeof item.role === 'string' && typeof item.name === 'string' && object(item.center), 'read_page: 要素の型が不正です');
    check(Number.isInteger(item.center.x) && item.center.x >= 0 && item.center.x < 1280
      && Number.isInteger(item.center.y) && item.center.y >= 0 && item.center.y < 800, 'read_page: 画面内の整数座標がありません');
    check(item.value === undefined || typeof item.value === 'string', 'read_page: valueが文字列ではありません');
  }
  return data;
}
async function readPage() { return validatePage(await action('read_page')); }
function has(data, role, name) { return data.page.some((item) => item.role === role && item.name === name); }
function element(data, role, name) {
  const matches = data.page.filter((item) => item.role === role && item.name === name);
  check(matches.length === 1, `read_page: ${role}の期待する要素が一意に見つかりません`);
  return matches[0];
}
async function click(item) { return action('left_click', item.center); }
async function pageUntil(predicate, { onPage = () => {}, closingDialog = false, navigating = false, label = 'fixture' } = {}) {
  const deadline = Date.now() + 5_000;
  let lastPage;
  do {
    const response = await post(actionBody({ kind: 'read_page' }), { timeout: Math.max(1, deadline - Date.now()) });
    // 明示遷移・タブ切替・dismissの直後だけ、document/focus/Closedイベント待ちを認める。
    if ((closingDialog || navigating) && response.status === 500) {
      errorResponse(response, 500, 'ACTION_FAILED', 'ページ状態の安定待ち');
    } else {
      const data = validatePage(jsonResponse(response, 200, 'read_page待ち'));
      lastPage = data;
      onPage(data);
      if (predicate(data)) return data;
    }
    await delay(100, undefined, { signal: lifetime.signal });
  } while (Date.now() < deadline);
  if (lastPage) await writeFile(join(artifacts, 'last-page.json'), redact(JSON.stringify(lastPage, null, 2)), { mode: 0o600 });
  throw new CheckFailure(`read_page: ${label}の期待する状態に5秒以内に到達しませんでした`);
}
async function openPage(file, heading, port = 8000) {
  await action('open_url', { url: `http://127.0.0.1:${port}/${file}` });
  return pageUntil((data) => has(data, 'heading', heading), { label: file, navigating: true });
}

function png(bytes, label) {
  check(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${label}: PNG signature不正`);
  check(bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', `${label}: IHDR不正`);
  check(bytes.readUInt32BE(16) === 1280 && bytes.readUInt32BE(20) === 800, `${label}: 1280x800ではありません`);
  return bytes;
}
function screenshotBytes(data) {
  check(object(data.screenshot) && data.screenshot.mimeType === 'image/png' && typeof data.screenshot.data === 'string', 'screenshot action: base64 objectではありません');
  const bytes = Buffer.from(data.screenshot.data, 'base64');
  check(bytes.toString('base64') === data.screenshot.data, 'screenshot action: 不正なbase64です');
  return png(bytes, 'screenshot action');
}
async function savePng(name, bytes) { await writeFile(join(artifacts, name), bytes, { mode: 0o600 }); }

function vnc(auth, allowed) {
  return new Promise((resolveResult, reject) => {
    let settled = false;
    let greeting = Buffer.alloc(0);
    const ws = new WebSocket(`${current.base.replace('http:', 'ws:')}/vnc`, {
      headers: auth === null ? {} : { Authorization: `Bearer ${auth}` },
      handshakeTimeout: 5_000, perMessageDeflate: false, maxPayload: 1024 * 1024,
    });
    const finish = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lifetime.signal.removeEventListener('abort', abort);
      ws.terminate();
      if (message) reject(new CheckFailure(message)); else resolveResult();
    };
    const abort = () => finish('VNC: 検査が中断されました');
    const timer = setTimeout(() => finish('VNC: handshake/RFBの期限超過'), 6_000);
    lifetime.signal.addEventListener('abort', abort, { once: true });
    ws.on('error', () => { if (!settled) finish('VNC: WebSocket接続エラー'); });
    ws.on('close', () => { if (!settled) finish('VNC: 期待する応答前に切断されました'); });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      finish(!allowed && response.statusCode === 401 ? undefined : 'VNC: 認証拒否のHTTP statusが不正です');
    });
    ws.on('open', () => { if (!allowed) finish('VNC: 無資格/別資格のupgradeが許可されました'); });
    ws.on('message', (data, binary) => {
      if (!allowed || !binary) { finish('VNC: 不正なRFB応答'); return; }
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      greeting = Buffer.concat([greeting, chunk]);
      if (greeting.length >= 12) {
        finish(/^RFB 003\.\d{3}\n$/.test(greeting.subarray(0, 12).toString('ascii')) ? undefined : 'VNC: RFB greetingがありません');
      }
    });
    if (lifetime.signal.aborted) abort();
  });
}

async function authentication(rejectedTokens) {
  for (const auth of [null, ...rejectedTokens]) {
    for (const [method, path] of [['GET', '/healthz'], ['POST', '/actions'], ['GET', '/screenshot'], ['GET', '/vnc']]) {
      const response = await request(path, { method, auth,
        ...(method === 'POST' ? { body: actionBody({ kind: 'wait', duration: 0 }) } : {}) });
      errorResponse(response, 401, 'UNAUTHORIZED', `${method} ${path} 認証拒否`);
    }
    await vnc(auth, false);
  }
  await vnc(current.token, true);
  passed('HTTP全口・WS/vncの無/別資格拒否、正資格でRFB greeting');
}

async function startContainer(generation) {
  const name = `${prefix}-${generation}`;
  current = { name, token: token(), base: '' };
  containers.add(name); // createの応答が期限超過しても、label確認後に回収する。
  await docker(['create', '--pull', 'never', '--name', name, '--label', `${LABEL}=${runId}`,
    '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--security-opt', `seccomp=${SECCOMP}`, '--shm-size', '512m', '--memory', '1.5g',
    '--cpus', '1.5', '--pids-limit', '512',
    '--mount', `type=volume,src=${profile},dst=/home/browser`, '--mount', 'type=volume,dst=/tmp',
    '--mount', `type=bind,src=${PAGES},dst=/opt/vm-check-pages,readonly`,
    '--publish', '127.0.0.1::6080', '--env', 'BROWSER_TOKEN', '--env', 'CONTROL_EPOCH',
    '--env', 'BROWSER_PROXY_URL', image], {
    env: { ...process.env, BROWSER_TOKEN: current.token, CONTROL_EPOCH: String(EPOCH), BROWSER_PROXY_URL: '' },
  });
  const mounts = await inspect('{{json .Mounts}}');
  const temporary = mounts.find((mount) => mount.Destination === '/tmp');
  check(temporary?.Type === 'volume' && typeof temporary.Name === 'string' && temporary.Name !== profile, '匿名/tmp volumeがありません');
  anonymousVolumes.add(temporary.Name);
  check(mounts.some((mount) => mount.Destination === '/home/browser' && mount.Type === 'volume' && mount.Name === profile), '専用profile volumeがありません');
  check(mounts.some((mount) => mount.Destination === '/opt/vm-check-pages' && mount.Type === 'bind' && mount.RW === false), 'fixtureのreadonly bindがありません');
  await docker(['start', name]);
  const published = (await docker(['port', name, '6080/tcp'])).stdout.trim();
  check(/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(published), 'publishは127.0.0.1の1ポートだけである必要があります');
  current.base = `http://${published}`;
  const deadline = Date.now() + START_TIMEOUT;
  while (Date.now() < deadline) {
    lifetime.signal.throwIfAborted();
    let response;
    try { response = await request('/healthz', { timeout: 1_500 }); }
    catch (error) {
      if (!(error instanceof CheckFailure) || !error.message.startsWith('HTTP GET /healthz: 接続失敗')) throw error;
      const state = await inspect('{{json .State}}');
      check(state.Running === true, 'healthz準備前にコンテナが終了しました');
    }
    if (response?.status === 200) {
      const health = jsonResponse(response, 200, 'healthz');
      check(health.ready === true && health.sandboxEnabled === true, 'healthz: ready=true / sandboxEnabled=trueが必要です');
      // Browser.getVersionだけのreadyを見逃さず、ページCDPも直ちに使えることを要求。
      await readPage();
      passed(`世代${generation}: healthz=200 / sandbox=true / ページCDP準備済み`);
      return;
    }
    if (response) {
      const health = jsonResponse(response, 503, '準備中healthz');
      check(health.ready === false, '準備中healthzはready=falseである必要があります');
    }
    await delay(100, undefined, { signal: lifetime.signal });
  }
  throw new CheckFailure('healthzが60秒以内に準備完了になりませんでした');
}

async function containerConstraints() {
  const host = await inspect('{{json .HostConfig}}');
  check(host.ReadonlyRootfs === true && host.Init === true && (!host.CapAdd || host.CapAdd.length === 0)
    && isDeepStrictEqual(host.CapDrop, ['ALL']), 'rootfs/capability/init制限が不正です');
  check(host.SecurityOpt.includes('no-new-privileges') || host.SecurityOpt.includes('no-new-privileges=true'), 'no-new-privilegesがありません');
  const seccomp = host.SecurityOpt.find((value) => value.startsWith('seccomp='));
  check(seccomp && isDeepStrictEqual(parseJson(seccomp.slice(8), '実行seccomp'), parseJson(await readFile(SECCOMP, 'utf8'), '専用seccomp')), '専用seccompと実行設定が一致しません');
  check(host.ShmSize === 536870912 && host.Memory === 1610612736 && host.NanoCpus === 1500000000 && host.PidsLimit === 512, '資源制限が契約と異なります');
  check(host.PublishAllPorts === false && Object.keys(host.PortBindings).length === 1
    && host.PortBindings['6080/tcp']?.length === 1 && host.PortBindings['6080/tcp'][0].HostIp === '127.0.0.1', '管理口以外がpublishされています');
  check(await inspect('{{json .Config.User}}') === '10000:10000', '非特権UID/GIDではありません');
  const probe = `
    import { readFileSync, readdirSync } from 'node:fs';
    const secrets = JSON.parse(readFileSync(0, 'utf8'));
    let main = 0;
    for (const pid of readdirSync('/proc').filter((value) => /^\\d+$/.test(value))) {
      let argv;
      try { argv = readFileSync('/proc/' + pid + '/cmdline', 'utf8'); } catch { continue; }
      if (!argv.startsWith('/usr/lib/chromium/chromium\\0')) continue;
      if (secrets.some((secret) => argv.includes(secret))) process.exit(1);
      if (argv.includes('--type=')) continue;
      main++;
      const env = readFileSync('/proc/' + pid + '/environ', 'utf8');
      if (/(?:^|\\0)(BROWSER_TOKEN|SHELL_TOKEN)=/.test(env) || secrets.some((secret) => env.includes(secret))) process.exit(2);
      if (!argv.includes('--remote-debugging-pipe\\0') || argv.includes('--remote-debugging-port') || argv.includes('--no-sandbox')) process.exit(3);
      const status = readFileSync('/proc/' + pid + '/status', 'utf8');
      if (!/^CapEff:\\s+0+$/m.test(status) || !/^NoNewPrivs:\\s+1$/m.test(status) || !/^Seccomp:\\s+2$/m.test(status)) process.exit(4);
    }
    if (main !== 1) process.exit(5);
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      for (const line of readFileSync(file, 'utf8').trim().split('\\n').slice(1)) {
        const columns = line.trim().split(/\\s+/);
        if (columns[3] !== '0A') continue;
        const port = parseInt(columns[1].split(':')[1], 16);
        if (![5900, 6080, 8000, 8001].includes(port)) process.exit(6);
      }
    }
  `;
  await docker(['exec', '-i', current.name, 'node', '--input-type=module', '-e', probe], { input: JSON.stringify([...tokens]) });
  passed('Docker制限・資格のChromium非継承・CDP pipe限定・sandboxフラグ');
}

async function fixtureServer(port = 8000) {
  await docker(['exec', '--detach', current.name, 'python3', '-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', '/opt/vm-check-pages']);
  const deadline = Date.now() + 5_000;
  do {
    const result = await docker(['exec', current.name, 'node', '--input-type=module', '-e',
      `fetch('http://127.0.0.1:${port}/index.html', {signal: AbortSignal.timeout(1000)}).then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))`],
    { allowFailure: true, timeout: 2_000 });
    if (result.ok) return;
    await delay(100, undefined, { signal: lifetime.signal });
  } while (Date.now() < deadline);
  throw new CheckFailure('fixture HTTP serverが5秒以内に準備できませんでした');
}

async function validationAndIdempotency() {
  let page = await openPage('buy.html', '購入ボタンの試験');
  check(has(page, 'heading', '購入回数：0 回'), 'buy fixtureの初期回数が0ではありません');
  const buy = element(page, 'button', '購入する（ダミー）');
  const valid = () => actionBody({ kind: 'left_click', ...buy.center });
  const invalid = [
    null, [], {}, { ...valid(), actionId: '' }, { ...valid(), actionId: 'x'.repeat(129) },
    { ...valid(), controlEpoch: -1 }, { ...valid(), controlEpoch: 0.5 },
    { ...valid(), controlEpoch: '7' }, { ...valid(), controlEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid(), unknown: true }, { ...valid(), dryRun: true }, { ...valid(), dryRun: false },
    { ...valid(), expect: null }, { ...valid(), expect: 'unsupported' },
    actionBody({ kind: 'unknown_action' }), actionBody({ kind: 'read_page', unknown: true }),
    actionBody({ kind: 'left_click', ...buy.center, unknown: true }),
    actionBody({ kind: 'left_click', x: -1, y: 0 }), actionBody({ kind: 'left_click', x: 1280, y: 0 }),
    actionBody({ kind: 'left_click', x: 0, y: 800 }), actionBody({ kind: 'left_click', x: 0.5, y: 0 }),
    ...['file:///etc/passwd', 'javascript:1+1', 'chrome://version'].map((url) => actionBody({ kind: 'open_url', url })),
  ];
  for (const body of invalid) errorResponse(await post(body), 400, 'VALIDATION_ERROR', '入力検証');
  errorResponse(await request('/actions', { method: 'POST', raw: '{' }), 400, 'VALIDATION_ERROR', '壊れたJSON');
  errorResponse(await request('/actions', { method: 'POST', body: valid(), contentType: 'text/plain' }), 400, 'VALIDATION_ERROR', '不正Content-Type');
  errorResponse(await post({ ...valid(), controlEpoch: EPOCH - 1 }), 409, 'STALE_CONTROL', '古いepoch');
  page = await readPage();
  check(has(page, 'heading', '購入回数：0 回'), '拒否した要求にクリックの副作用がありました');
  passed('未知field/action・dryRun/expect・座標/epoch・JSON/URL検証と副作用なし');

  const body = valid();
  // waitで操作列を占有し、同じIDの2要求を同時に進行中にする。
  const results = await Promise.allSettled([
    post(actionBody({ kind: 'wait', duration: 0.5 })), post(body), post(body),
  ]);
  check(results.every((result) => result.status === 'fulfilled'), '同時再送の通信が失敗しました');
  const responses = results.map((result) => result.value);
  for (const response of responses) check(jsonResponse(response, 200, '同時操作').executed === true, '同時操作のexecutedがありません');
  check(responses[1].bytes.equals(responses[2].bytes), '同じIDの同時再送結果が一致しません');
  page = await pageUntil((data) => has(data, 'heading', '購入回数：1 回'));
  const replay = await post(body);
  check(replay.status === 200 && replay.bytes.equals(responses[1].bytes), '完了後の同ID再送結果が一致しません');
  errorResponse(await post({ ...body, action: { ...body.action, x: body.action.x + 1 } }), 409, 'ACTION_CONFLICT', '同ID異payload');
  errorResponse(await post({ ...body, controlEpoch: EPOCH - 1 }), 409, 'STALE_CONTROL', 'キャッシュ済みIDの古いepoch');
  check(has(await readPage(), 'heading', '購入回数：1 回'), '再送/拒否により購入回数が余分に増えました');
  passed('同時同IDクリックは1回、完了結果再送、異payload/キャッシュより先のepoch拒否');

  const response = await request('/screenshot');
  check(response.status === 200 && response.contentType === 'image/png', 'GET /screenshotのstatus/MIMEが不正です');
  await savePng('buy-http.png', png(response.bytes, 'GET /screenshot'));
  await savePng('buy-action.png', screenshotBytes(await action('screenshot')));
  passed('HTTPとactionのPNG signature/IHDR 1280x800、確認画像保存');
}

async function inputsAndSecrets() {
  let page = await openPage('password.html', '通常入力・秘密入力の試験');
  const assertSecrets = (data) => {
    const json = JSON.stringify(data);
    check(secretValues.every((secret) => !json.includes(secret)), 'read_pageのJSON全文にダミー秘密値が含まれています');
    const secretFields = data.page.filter((item) => item.role === 'textbox'
      && !['通常入力（ASCII）', '通常入力（日本語）'].includes(item.name));
    check(secretFields.length === 6 && secretFields.every((item) => !Object.hasOwn(item, 'value')),
      '秘密6欄の値省略が確認できません');
  };
  assertSecrets(page);
  for (const [name, text] of [['通常入力（ASCII）', 'vm-check ASCII 123'], ['通常入力（日本語）', 'こんにちは、日本語の入力試験です。漢字かなカナ']]) {
    protectedText.add(text);
    await click(element(page, 'textbox', name));
    await action('key', { text: 'ctrl+a' });
    await action('type', { text });
    page = await pageUntil((data) => element(data, 'textbox', name).value === text, { label: name });
    assertSecrets(page);
  }
  passed('read_page座標で通常入力2欄へASCII/日本語を入力し実値照合、秘密6欄のJSON非漏出');
  await savePng('japanese-input.png', screenshotBytes(await action('screenshot')));
  await click(element(page, 'textbox', '通常入力（ASCII）'));
  await action('key', { text: 'ctrl+a' });
  await action('type', { text: 'Ab9!'.repeat(4000) });
  await click(element(await readPage(), 'button', 'ASCII長文を検証'));
  page = await pageUntil((data) => has(data, 'heading', '長文入力：全文一致'), { label: 'ASCII長文' });
  assertSecrets(page);
  passed('typeの上限16000bytesを大文字・記号込みで入力し、ページ側で全文一致を確認');
  await click(element(page, 'textbox', '通常入力（日本語）'));
  await action('key', { text: 'ctrl+a' });
  await action('type', { text: '日本語'.repeat(1777) + 'END1234' });
  await click(element(await readPage(), 'button', '日本語長文を検証'));
  page = await pageUntil((data) => has(data, 'heading', '日本語長文：全文一致'), { label: '日本語長文' });
  assertSecrets(page);
  passed('日本語混在の上限16000bytesもページ側で全文一致を確認');
}

async function failedActionCache() {
  const body = actionBody({ kind: 'open_url', url: 'http://127.0.0.1:8001/buy.html' });
  const failed = await post(body);
  errorResponse(failed, 500, 'ACTION_FAILED', '未起動のloopbackポートへの遷移');
  await fixtureServer(8001);
  await openPage('buy.html', '購入ボタンの試験', 8001); // 新IDでは実際に成功することを証明。
  const replay = await post(body);
  check(replay.status === failed.status && replay.bytes.equals(failed.bytes), '失敗したIDが後から再実行されています');
  check(has(await readPage(), 'heading', '購入回数：0 回'), '失敗結果の再送後に正常な前面ページが失われました');
  passed('実行失敗をキャッシュし、遷移先が利用可能になっても同IDは再実行しない');
}

async function newTab() {
  const page = await openPage('newtab.html', '新しいタブの試験');
  const clicked = await click(element(page, 'link', '購入試験を新しいタブで開く'));
  const notices = [clicked.text ?? ''];
  const front = await pageUntil((data) => has(data, 'heading', '購入ボタンの試験'), {
    onPage: (data) => notices.push(data.text),
    navigating: true,
  });
  check(notices.some((text) => text.includes('新しいタブまたはウィンドウを前面にしました。')), '新しいタブの前面化通知がありません');
  check(!has(front, 'heading', '新しいタブの試験') && has(front, 'heading', '購入回数：0 回'), '前面targetが新しい購入ページではありません');
  await click(element(front, 'button', '購入する（ダミー）'));
  await pageUntil((data) => has(data, 'heading', '購入回数：1 回'));
  passed('新タブ通知、read_pageとX入力の前面target一致');
  const launcher = await openPage('newtab.html', '新しいタブの試験');
  await click(element(launcher, 'link', '即時alertを新しいタブで開く'));
  let shot;
  const deadline = Date.now() + 3_000;
  do {
    shot = await action('screenshot');
    if ((shot.text ?? '').includes('JavaScript alert を検出しました。')) break;
    await delay(100, undefined, { signal: lifetime.signal });
  } while (Date.now() < deadline);
  check((shot.text ?? '').includes('JavaScript alert を検出しました。'), '新tabの再開直後のalert通知がありません');
  // CDP通知はXの描画より早い。描画を待ち、勝手に閉じられていないことも確認する。
  await delay(500, undefined, { signal: lifetime.signal });
  shot = await action('screenshot');
  check((shot.text ?? '').includes('JavaScript alert を検出しました。'), '新tabの即時alertが自動で応答されています');
  await savePng('newtab-immediate-alert.png', screenshotBytes(shot));
  errorResponse(await post(actionBody({ kind: 'read_page' })), 500, 'ACTION_FAILED', '新tabの即時dialog中の操作停止');
  await docker(['exec', current.name, 'xdotool', 'key', '--clearmodifiers', 'Return']);
  await pageUntil((data) => has(data, 'heading', '即時alert：閉じました'), { closingDialog: true, navigating: true });
  passed('新tab再開直後のalert通知・操作停止・明示dismiss後の復帰');
}

async function dialogs() {
  for (const [type, dismiss, result] of [['alert', 'Return', 'alert：閉じました'], ['confirm', 'Escape', 'confirm：キャンセル']]) {
    const page = await openPage('dialog.html', 'ダイアログの試験');
    check(has(page, 'heading', 'ダイアログ：未操作'), 'dialog fixtureの初期状態が不正です');
    const clicked = await click(element(page, 'button', `${type}を表示する`));
    const notice = `JavaScript ${type} を検出しました。`;
    let shot;
    const deadline = Date.now() + 3_000;
    do {
      shot = await action('screenshot', {}, { timeout: Math.max(1, deadline - Date.now()) });
      if ((shot.text ?? '').includes(notice)) break;
      await delay(100, undefined, { signal: lifetime.signal });
    } while (Date.now() < deadline);
    check((clicked.text ?? '').includes(notice) || (shot.text ?? '').includes(notice), `${type}: 検出通知がありません`);
    check((shot.text ?? '').includes(notice), `${type}: ダイアログが勝手に閉じられています`);
    await delay(500, undefined, { signal: lifetime.signal });
    shot = await action('screenshot');
    check((shot.text ?? '').includes(notice), `${type}: ダイアログが自動で応答されています`);
    await savePng(`dialog-${type}.png`, screenshotBytes(shot));
    errorResponse(await post(actionBody({ kind: 'read_page' })), 500, 'ACTION_FAILED', 'dialog中の操作停止');
    // ここだけ検査側が明示的に応答する。confirmは必ずCancelを選ぶ。
    await docker(['exec', current.name, 'xdotool', 'key', '--clearmodifiers', dismiss]);
    await pageUntil((data) => has(data, 'heading', result), { closingDialog: true });
  }
  passed('alert/confirm通知と維持、検査側の明示dismiss後に閉じた/キャンセル結果を照合');
}

async function logs(name, cleanup = false) {
  const result = await docker(['logs', '--timestamps', name], { cleanup });
  const text = result.stdout + result.stderr;
  await writeFile(join(artifacts, `${name}.log`), redact(text), { mode: 0o600 });
  noToken(text, 'コンテナログ');
  return text;
}

async function removeContainer(name, cleanup = false) {
  const found = await docker(['container', 'inspect', '--format', '{{json .Config.Labels}}', name], { allowFailure: true, cleanup });
  if (!found.ok) {
    check(/No such (?:container|object)/i.test(found.stderr), 'cleanup: コンテナの存在を確認できません');
    containers.delete(name);
    return;
  }
  check(parseJson(found.stdout, 'container label')?.[LABEL] === runId, 'cleanup: 自分のlabelでないコンテナには触れません');
  await docker(['rm', '--force', '--volumes', name], { cleanup });
  containers.delete(name);
}

async function restartAndTerminate() {
  const marker = randomBytes(32).toString('hex');
  const markerPath = '/home/browser/.vm-check-marker';
  await docker(['exec', '-i', current.name, 'node', '--input-type=module', '-e',
    `import {readFileSync,writeFileSync,lstatSync} from 'node:fs'; if(!lstatSync('/home/browser/SingletonLock').isSymbolicLink()) process.exit(1); writeFileSync('${markerPath}',readFileSync(0),{mode:0o600});`], { input: marker });
  const oldToken = current.token;
  await docker(['kill', '--signal', 'KILL', current.name]);
  check((await docker(['wait', current.name])).stdout.trim() === '137', 'SIGKILL後のexit codeが137ではありません');
  await logs(current.name);
  await removeContainer(current.name);
  await startContainer(2);
  const persisted = await docker(['exec', current.name, 'node', '--input-type=module', '-e',
    `import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync('${markerPath}'));`]);
  check(persisted.stdout === marker, '同profile再作成でmarkerが失われました');
  await authentication([wrongToken, oldToken]);
  await containerConstraints();
  await fixtureServer();
  const page = await openPage('buy.html', '購入ボタンの試験');
  check(has(page, 'heading', '購入回数：0 回'), '再作成後のページ操作が失敗しました');
  passed('SIGKILL→rm -v→同profile再作成、Singleton回復・marker維持・旧資格拒否');

  const start = performance.now();
  await docker(['kill', '--signal', 'TERM', current.name], { timeout: 3_000 });
  const stopped = await docker(['wait', current.name], { timeout: Math.max(1, 12_000 - Math.ceil(performance.now() - start)) });
  // 正常な親プロセスの終了は0、現在のstart.shのTERM trapは143。137は許さない。
  check(['0', '143'].includes(stopped.stdout.trim()) && performance.now() - start < 12_000, 'TERM後12秒以内の正常停止に失敗しました');
  const state = await inspect('{{json .State}}');
  check(state.Running === false && state.OOMKilled === false && state.Error === '', 'TERM後のコンテナ状態が不正です');
  const log = await logs(current.name);
  check(/\[box-agent\] stopped OK(?:\r?\n|$)/.test(log) && !/\[box-agent\] (?:failed|stopped FAILED)\b/.test(log),
    'supervisorは終了しましたが、agent自身の正常停止を確認できません');
  passed('TERMで12秒以内に停止し、agent自身のstopped OKを確認（OOMなし）');
}

async function cleanup() {
  const failures = [];
  for (const name of [...containers]) {
    if (artifacts) {
      try { await logs(name, true); } catch { failures.push('終了時ログの取得/資格検査'); }
    }
    try { await removeContainer(name, true); } catch { failures.push('専用コンテナの削除'); }
  }
  for (const name of [...anonymousVolumes, ...(profileRequested ? [profile] : [])]) {
    try {
      const found = await docker(['volume', 'inspect', '--format', '{{json .Labels}}', name], { allowFailure: true, cleanup: true });
      if (!found.ok) {
        check(/No such volume/i.test(found.stderr), 'volumeの存在確認に失敗しました');
        continue;
      }
      if (name === profile) check(parseJson(found.stdout, 'profile label')?.[LABEL] === runId, '専用profileのlabelが異なります');
      // 匿名volumeは自分のlabel付きコンテナのMountsから得た名前だけ。
      await docker(['volume', 'rm', name], { cleanup: true });
    } catch { failures.push('専用volumeの削除'); }
  }
  check(failures.length === 0, `cleanup失敗: ${[...new Set(failures)].join('、')}（専用prefix: ${prefix}）`);
}

async function preflight() {
  check(process.argv.length <= 3 && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image), '使い方: node apps/box-agent/test/vm-check.mjs [image]（設定はimageだけ）');
  check(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24以上が必要です');
  check(!PAGES.includes(','), 'Docker bindのパスにカンマは使えません');
  await readFile(SECCOMP);
  for (const file of ['index.html', 'password.html', 'buy.html', 'newtab.html', 'dialog.html']) await readFile(join(PAGES, file));
  // 現fixtureの二重引用符属性を読む。秘密6分類が欠けた場合は黙って検査を減らさない。
  const html = await readFile(join(PAGES, 'password.html'), 'utf8');
  const categories = new Set();
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]]));
    const category = attrs.type === 'password' ? 'password' : attrs.autocomplete;
    if (!['password', 'current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp'].includes(category)) continue;
    check(typeof attrs.value === 'string' && attrs.value.length > 0 && !attrs.value.includes('&'), '秘密fixtureのvalueを読み取れません');
    categories.add(category);
    secretValues.push(attrs.value);
    protectedText.add(attrs.value);
  }
  check(categories.size === 6 && secretValues.length === 6, 'password fixtureに秘密6分類が必要です');
  await mkdir('/tmp/opencode', { recursive: true });
  artifacts = await mkdtemp('/tmp/opencode/box-agent-vm-check-');
}

const image = process.argv[2] ?? process.env.VM_CHECK_IMAGE ?? 'makase-s1.2-box-browser';
const abort = () => lifetime.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
const deadline = setTimeout(abort, 240_000);
let failed = false;
try {
  await preflight();
  profileRequested = true;
  await docker(['volume', 'create', '--label', `${LABEL}=${runId}`, profile]);
  await startContainer(1);
  await containerConstraints();
  await authentication([wrongToken]);
  await fixtureServer();
  await validationAndIdempotency();
  await inputsAndSecrets();
  await failedActionCache();
  await newTab();
  await dialogs();
  await restartAndTerminate();
} catch (error) {
  failed = true;
  console.error(`FAIL - ${error instanceof CheckFailure ? error.message : '検査が中断されたか、実行環境/fixtureに予期しない問題があります（入力・資格は表示しません）'}`);
  if (current?.base && artifacts && !lifetime.signal.aborted) {
    try {
      const shot = await request('/screenshot');
      if (shot.status === 200) await savePng('failure.png', png(shot.bytes, '失敗時スクショ'));
    } catch { /* 失敗時の画面取得で元の検査結果を置き換えない。 */ }
  }
} finally {
  clearTimeout(deadline);
  try { await cleanup(); } catch (error) {
    failed = true;
    console.error(error instanceof CheckFailure ? error.message : 'cleanupで予期しない問題が起きました');
  }
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
if (artifacts) console.log(`目視用PNG・秘匿処理済みログ: ${artifacts}`);
if (!failed) passed('作成した専用コンテナ・profile・匿名/tmpを回収');
process.exitCode = failed ? 1 : 0;
