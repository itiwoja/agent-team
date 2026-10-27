#!/usr/bin/env node
/**
 * Node 24 / build済みイメージ限定の直列ライフサイクル検査。build/pullはしない。
 *   node apps/box-agent/test/lifecycle-check.mjs [image]
 *   LIFECYCLE_CHECK_IMAGE=makase-s1.2-box-browser node apps/box-agent/test/lifecycle-check.mjs
 * 結果・秘匿済みログ: /tmp/opencode/box-agent-lifecycle-check-<random>/results.json
 * 0=全件成功、1=失敗、2=既定sandboxが利用可能でfallback未検証（合格ではない）。
 * 検査240秒＋回収最大30秒。実アカウント・外部ページ・既存volumeは使わない。
 *
 * backendはstderr/試行数を公開しないため、既定seccompケースだけこのファイルを
 * readonly bindし、NODE_OPTIONSの--importで観測する。spawnの引数・戻り値・
 * signal・再試行判断は変更しない。記録するのは回数・PID・終了値・診断分類のみ。
 * 専用seccompの死亡/INT/HUP検査にはpreloadを使わない。
 */
import childProcess, { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const OBSERVER = '/opt/box-agent-lifecycle-observer.mjs';
const EVIDENCE = '/tmp/box-agent-lifecycle-attempts.jsonl';
const MAIN = '/srv/apps/box-agent/src/main.ts';

function installObserver() {
  if (process.argv[1] !== MAIN) return; // start.shのhealthzプローブには干渉しない。
  const spawn = childProcess.spawn;
  let attempt = 0;
  const record = (event) => {
    try { appendFileSync(EVIDENCE, `${JSON.stringify(event)}\n`, { mode: 0o600 }); }
    catch { process.stderr.write('[lifecycle-observer] 証跡を書き込めません。\n'); }
  };
  childProcess.spawn = function (...parameters) {
    const child = Reflect.apply(spawn, this, parameters);
    if (parameters[0] !== '/usr/lib/chromium/chromium') return child;
    const args = parameters[1];
    const index = ++attempt;
    let stderr = '';
    let truncated = false;
    record({ event: 'spawn', attempt: index, pid: child.pid ?? null,
      sandboxEnabled: Array.isArray(args) && !args.includes('--no-sandbox'),
      pipeOnly: Array.isArray(args) && args.includes('--remote-debugging-pipe')
        && !args.some((arg) => arg.startsWith('--remote-debugging-port')) });
    child.stderr?.on('data', (chunk) => {
      if (!Buffer.isBuffer(chunk)) { truncated = true; return; }
      stderr += chunk.toString('utf8');
      if (stderr.length > 128 * 1024) { truncated = true; stderr = stderr.slice(-128 * 1024); }
    });
    child.once('exit', (exitCode, signal) => {
      // 一般的なEPERM・CDP失敗ではなく、Chromium自身の限定された診断だけを採用。
      const noUsableSandbox = stderr.split('\n').some((line) =>
        /^\[[\d:./]+:(?:ERROR|FATAL):[^\]]*(?:sandbox|zygote)[^\]]*\].*No usable sandbox!/.test(line));
      const namespaceDenied = stderr.split('\n').some((line) =>
        /^Failed to move to new namespace:.*(?:errno = Operation not permitted|errno = Permission denied)/.test(line));
      record({ event: 'exit', attempt: index, pid: child.pid ?? null, exitCode, signal,
        diagnostic: noUsableSandbox ? 'NO_USABLE_SANDBOX' : namespaceDenied ? 'NAMESPACE_DENIED' : null,
        policyDenied: /remote debugging.*(?:disallowed|disabled)|DeveloperToolsAvailability/i.test(stderr),
        truncated });
      stderr = '';
    });
    return child;
  };
  syncBuiltinESMExports();
}

async function runChecks() {
  const script = fileURLToPath(import.meta.url);
  const root = resolve(dirname(script), '../../..');
  const seccompPath = join(root, 'docker/makase-browser-seccomp.json');
  const image = process.argv[2] ?? process.env.LIFECYCLE_CHECK_IMAGE ?? 'makase-s1.2-box-browser';
  const label = 'open-team.box-agent-lifecycle-check';
  const runId = randomBytes(12).toString('hex');
  const prefix = `makase-lifecycle-${runId}`;
  const lifetime = new AbortController();
  const containers = new Map();
  const tokens = new Set();
  const baseEnv = { ...process.env };
  delete baseEnv.BROWSER_TOKEN;
  delete baseEnv.SHELL_TOKEN;
  const report = { runId, image, startedAt: new Date().toISOString(), status: 'running', cases: [], cleanup: [] };
  let artifacts;
  let seccomp;
  let cleanupUntil = 0;
  let failed = false;
  let unverified = false;
  class CheckFailure extends Error {}
  class Unverified extends CheckFailure {}
  function check(condition, message) { if (!condition) throw new CheckFailure(message); }
  function object(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
  function parse(text, context) {
    try { return JSON.parse(text); } catch { throw new CheckFailure(`${context}: JSONが不正です`); }
  }
  function hasToken(text) { return [...tokens].some((value) => text.includes(value)); }
  function redact(text) {
    for (const value of tokens) text = text.replaceAll(value, '[REDACTED]');
    return text;
  }
  const safeError = (error) => error instanceof CheckFailure ? error.message
    : lifetime.signal.aborted ? '検査全体の期限超過または中断' : '予期しない失敗（生の例外・資格は表示しません）';

  function docker(args, { timeout = 8_000, env = baseEnv, allowFailure = false, cleanup = false } = {}) {
    return new Promise((resolveResult, reject) => {
      const remaining = cleanup ? cleanupUntil - Date.now() : timeout;
      if (remaining <= 0) { reject(new CheckFailure('cleanupの30秒期限を超えました')); return; }
      // docker execはConfig.Envを再利用する。資格・観測preloadを検査用Nodeに渡さない。
      const command = args[0] === 'exec'
        ? ['exec', '--env', 'BROWSER_TOKEN=', '--env', 'SHELL_TOKEN=', '--env', 'NODE_OPTIONS=', ...args.slice(1)] : args;
      const child = execFile('docker', command, {
        env, shell: false, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
        timeout: Math.min(timeout, remaining), killSignal: 'SIGKILL',
        ...(cleanup ? {} : { signal: lifetime.signal }),
      }, (error, stdout, stderr) => {
        // execFileのerror.messageはコマンド・生ログを含むので一切出さない。
        const diagnostic = {
          exitCode: !error ? 0 : Number.isInteger(error.code) ? error.code : null,
          signal: ['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP'].includes(error?.signal) ? error.signal : null,
          classification: !error ? 'OK' : error.name === 'AbortError' ? 'ABORTED'
            : error.killed ? 'COMMAND_TIMEOUT' : error.code === 'ENOENT' ? 'DOCKER_NOT_FOUND'
              : Number.isInteger(error.code) ? 'NONZERO_EXIT' : 'EXEC_ERROR',
        };
        if (error && !allowFailure) reject(new CheckFailure(`Docker ${args[0]}: ${diagnostic.classification}（exit=${diagnostic.exitCode}, signal=${diagnostic.signal}）`));
        else resolveResult({ ok: !error, stdout, stderr, diagnostic });
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    });
  }
  async function inspect(current, field, options = {}) {
    return parse((await docker(['inspect', '--format', `{{json ${field}}}`, current.name], options)).stdout, 'inspect');
  }
  async function saveReport() {
    if (artifacts) await writeFile(join(artifacts, 'results.json'), redact(`${JSON.stringify(report, null, 2)}\n`), { mode: 0o600 });
  }
  async function collectLogs(current, cleanup = false) {
    const output = await docker(['logs', '--timestamps', current.name], { cleanup });
    const text = output.stdout + output.stderr;
    current.result.logTokenLeak = hasToken(text);
    current.result.logFile = `${current.result.id}.log`;
    await writeFile(join(artifacts, current.result.logFile), redact(text), { mode: 0o600 });
    check(!current.result.logTokenLeak, 'コンテナログへの資格漏出を検出しました（保存時に秘匿済み）');
    return text;
  }
  async function stateEvidence(current, cleanup = false) {
    const state = await inspect(current, '.State', { cleanup });
    check(object(state), 'コンテナ状態を取得できません');
    current.result.state = { running: state.Running, exitCode: state.ExitCode, oomKilled: state.OOMKilled,
      errorEmpty: state.Error === '' };
    current.result.oomChecked = state.OOMKilled === false;
    check(state.OOMKilled === false && state.Error === '', 'OOMまたはDocker状態エラーを検出しました');
    return state;
  }

  async function constraints(current) {
    const host = await inspect(current, '.HostConfig');
    check(host.ReadonlyRootfs === true && host.Init === true && isDeepStrictEqual(host.CapDrop, ['ALL'])
      && (!host.CapAdd || host.CapAdd.length === 0), 'rootfs/init/capability制限が不正です');
    check(host.SecurityOpt.some((entry) => ['no-new-privileges', 'no-new-privileges=true'].includes(entry)), 'no-new-privilegesがありません');
    const actual = host.SecurityOpt.filter((entry) => entry.startsWith('seccomp='));
    if (current.result.seccomp === 'dedicated') {
      check(actual.length === 1 && isDeepStrictEqual(parse(actual[0].slice(8), 'seccomp'), seccomp), '専用seccompが一致しません');
    } else check(actual.length === 0, '既定seccompのケースに上書きがあります');
    check(host.ShmSize === 536870912 && host.Memory === 1610612736 && host.NanoCpus === 1500000000
      && host.PidsLimit === 512 && host.RestartPolicy.Name === 'no', '資源制限または再起動設定が不正です');
    check(host.PublishAllPorts === false && Object.keys(host.PortBindings).length === 1
      && host.PortBindings['6080/tcp']?.length === 1 && host.PortBindings['6080/tcp'][0].HostIp === '127.0.0.1', 'publishがloopbackのAPI専用ではありません');
    check(await inspect(current, '.Config.User') === '10000:10000', 'uid/gidが10000ではありません');
    current.result.constraintsVerified = true;
  }

  async function start(current) {
    await docker(['create', '--pull', 'never', '--name', current.name, '--label', `${label}=${runId}`,
      '--user', '10000:10000', '--init', '--read-only', '--restart', 'no', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      ...(current.result.seccomp === 'dedicated' ? ['--security-opt', `seccomp=${seccompPath}`] : []),
      '--shm-size', '512m', '--memory', '1.5g', '--cpus', '1.5', '--pids-limit', '512',
      '--mount', 'type=volume,dst=/home/browser', '--mount', 'type=volume,dst=/tmp',
      ...(current.result.seccomp === 'default' ? ['--mount', `type=bind,src=${script},dst=${OBSERVER},readonly`,
        '--env', `NODE_OPTIONS=--import=${OBSERVER}`] : []),
      '--publish', '127.0.0.1::6080', '--env', 'BROWSER_TOKEN', '--env', 'CONTROL_EPOCH=0',
      '--env', 'BROWSER_PROXY_URL=', image], { env: { ...baseEnv, BROWSER_TOKEN: current.token } });
    check((await inspect(current, '.Config.Labels'))?.[label] === runId, '自分のコンテナlabelではありません');
    const mounts = await inspect(current, '.Mounts');
    for (const destination of ['/home/browser', '/tmp']) {
      const mount = mounts.find((entry) => entry.Destination === destination);
      check(mount?.Type === 'volume' && typeof mount.Name === 'string' && /^[a-f0-9]{64}$/.test(mount.Name), '自分専用の匿名volumeではありません');
      current.volumes.add(mount.Name);
    }
    check(current.volumes.size === 2, 'profile/tmpが独立した匿名volumeではありません');
    current.result.volumes = [...current.volumes];
    await constraints(current);
    await docker(['start', current.name]);
    const port = (await docker(['port', current.name, '6080/tcp'])).stdout.trim();
    check(/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(port), 'APIのpublish先が不正です');
    current.base = `http://${port}`;
    const until = performance.now() + 45_000;
    while (performance.now() < until) {
      lifetime.signal.throwIfAborted();
      let response;
      let text;
      try {
        response = await fetch(`${current.base}/healthz`, { headers: { Authorization: `Bearer ${current.token}` },
          redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1_000)]) });
        text = await response.text();
      } catch {
        check((await stateEvidence(current)).Running === true, 'healthz準備前にコンテナが終了しました');
      }
      if (response && text !== undefined) {
        check(!hasToken(text) && !hasToken(JSON.stringify([...response.headers])), 'healthzへの資格漏出を検出しました');
        check(text.length <= 16 * 1024 && response.headers.get('content-type')?.startsWith('application/json'), 'healthz形式が不正です');
        const health = parse(text, 'healthz');
        check(object(health) && typeof health.sandboxEnabled === 'boolean', 'healthzのsandboxEnabledが不明です');
        if (response.status === 200) {
          check(health.ready === true, 'healthz=200なのにready=trueではありません');
          current.result.health = { ready: health.ready, sandboxEnabled: health.sandboxEnabled };
          if (current.result.seccomp === 'dedicated') check(health.sandboxEnabled === true, '専用seccompでsandboxが無効です');
          await stateEvidence(current);
          return health;
        }
        check(response.status === 503 && health.ready === false, '準備中healthzが503/ready=falseではありません');
      }
      await delay(100, undefined, { signal: lifetime.signal });
    }
    throw new CheckFailure('healthzが45秒以内に準備完了になりませんでした');
  }

  async function processes(current, killRole = null) {
    // /procで実行ファイルと完全なargv位置を照合し、一意の親だけを同じプローブ内でkill。
    // 子renderer・検査用node -e・名前の部分一致を対象にしない。argv/env自体は出さない。
    const probe = `
      import {readFileSync,readdirSync,readlinkSync,writeSync} from 'node:fs';
      import {basename} from 'node:path';
      const roles = {chromium: [], agent: [], openbox: []};
      const diagnostics = {readErrors: {}, candidates: [], chromiumExecutables: []};
      const errorCode = error => ['EACCES', 'EPERM', 'ENOENT', 'ESRCH'].includes(error?.code) ? error.code : 'OTHER';
      const fail = (exitCode, classification) => {
        writeSync(1, JSON.stringify({ok: false, classification, diagnostics,
          counts: Object.fromEntries(Object.entries(roles).map(([role, items]) => [role, items.length]))}));
        process.exit(exitCode);
      };
      for (const entry of readdirSync('/proc').filter(value => /^\\d+$/.test(value))) {
        let argv, executable, status, comm, exeStatus = 'OK';
        try {
          argv = readFileSync('/proc/' + entry + '/cmdline', 'utf8').split('\\0').filter(Boolean);
          status = readFileSync('/proc/' + entry + '/status', 'utf8');
          comm = readFileSync('/proc/' + entry + '/comm', 'utf8').trim();
        } catch (error) {
          const code = errorCode(error);
          diagnostics.readErrors[code] = (diagnostics.readErrors[code] ?? 0) + 1;
          continue;
        }
        try { executable = readlinkSync('/proc/' + entry + '/exe'); }
        catch (error) { exeStatus = errorCode(error); }
        const parentPid = Number(/^PPid:\\s+(\\d+)$/m.exec(status)?.[1]);
        if (executable === '/usr/lib/chromium/chromium') diagnostics.chromiumExecutables.push({pid: Number(entry), parentPid,
          argumentCount: argv.length, executableArgv0: argv[0] === '/usr/lib/chromium/chromium',
          typeArgument: argv.some(arg => arg.startsWith('--type=')),
          typeInTitle: /(?:^|\\s)--type=/.test(argv[0] ?? '')});
        const argvRole = argv[0] === '/usr/lib/chromium/chromium' && !argv.some(arg => arg.startsWith('--type=')) ? 'chromium'
          : basename(argv[0] ?? '') === 'node' && argv[1] === ${JSON.stringify(MAIN)} ? 'agent'
            : basename(argv[0] ?? '') === 'openbox' ? 'openbox' : null;
        if (argvRole) diagnostics.candidates.push({pid: Number(entry), role: argvRole, exeStatus,
          commMatches: comm === {chromium: 'chromium', agent: 'node', openbox: 'openbox'}[argvRole],
          hasSmDisable: argv.includes('--sm-disable')});
        if (exeStatus !== 'OK') continue;
        let role;
        // Chromium子はprocess titleを書き換え、--type=が単独argvでなくargv[0]内に入る。
        // exe一致と「--type=の独立要素なし」だけでは子も親として数えてしまう。
        if (executable === '/usr/lib/chromium/chromium' && argvRole === 'chromium'
          && argv.includes('--user-data-dir=/home/browser') && argv.includes('--remote-debugging-pipe')) role = 'chromium';
        if (basename(executable) === 'node' && argv[1] === ${JSON.stringify(MAIN)}) role = 'agent';
        if (basename(executable) === 'openbox' && argv.includes('--sm-disable')) role = 'openbox';
        if (!role) continue;
        if (!/^Uid:\\s+10000\\s+10000\\s+10000\\s+10000$/m.test(status)
          || !/^NoNewPrivs:\\s+1$/m.test(status) || !/^Seccomp:\\s+2$/m.test(status)) fail(2, 'PROCESS_CONSTRAINT_MISMATCH');
        roles[role].push({pid: Number(entry), parentPid, sandboxEnabled: !argv.includes('--no-sandbox'),
          pipeOnly: argv.includes('--remote-debugging-pipe') && !argv.some(arg => arg.startsWith('--remote-debugging-port'))});
      }
      if (Object.values(roles).some(items => items.length !== 1)) fail(3, 'ROLE_COUNT_MISMATCH');
      if (roles.chromium[0].parentPid !== roles.agent[0].pid
        || roles.agent[0].parentPid !== roles.openbox[0].parentPid) fail(5, 'PROCESS_PARENT_MISMATCH');
      const killRole = ${JSON.stringify(killRole)};
      const result = {ok: true, diagnostics, chromium: roles.chromium[0], agentPid: roles.agent[0].pid, openboxPid: roles.openbox[0].pid};
      if (killRole !== null) {
        try { process.kill(roles[killRole][0].pid, 'SIGKILL'); }
        catch { fail(4, 'KILL_FAILED'); }
        result.killed = {role: killRole, pid: roles[killRole][0].pid, signal: 'SIGKILL'};
      }
      writeSync(1, JSON.stringify(result));
    `;
    const output = await docker(['exec', current.name, 'node', '--input-type=module', '-e', probe], { timeout: 4_000, allowFailure: true });
    current.result.processProbe = { command: output.diagnostic };
    check(!hasToken(output.stdout) && !hasToken(output.stderr), 'process probeへの資格漏出を検出しました');
    check(output.stdout.trim() !== '', `process probe: ${output.diagnostic.classification}（exit=${output.diagnostic.exitCode}、診断JSONなし）`);
    const evidence = parse(output.stdout, 'process probe');
    current.result.processProbe.evidence = evidence;
    check(output.ok && evidence.ok === true, `process probe: ${['ROLE_COUNT_MISMATCH', 'PROCESS_CONSTRAINT_MISMATCH', 'PROCESS_PARENT_MISMATCH', 'KILL_FAILED'].includes(evidence.classification) ? evidence.classification : 'UNKNOWN_FAILURE'}（exit=${output.diagnostic.exitCode}）`);
    check(evidence.chromium?.pipeOnly === true && evidence.chromium.sandboxEnabled === current.result.health.sandboxEnabled,
      'Chromiumのpipe/sandboxフラグとhealthzが一致しません');
    current.result.processes = evidence;
    return evidence;
  }

  async function stopped(current, since, allowedCodes = null) {
    const result = await docker(['wait', current.name], { timeout: Math.max(1, 12_000 - Math.ceil(performance.now() - since)) });
    const elapsedMs = Math.ceil(performance.now() - since);
    check(/^\d+$/.test(result.stdout.trim()), 'docker waitの終了値が不正です');
    const exitCode = Number(result.stdout.trim());
    current.result.stop = { elapsedMs, exitCode, expectedCodes: allowedCodes ?? 'nonzero' };
    check(elapsedMs <= 12_000 && (allowedCodes ? allowedCodes.includes(exitCode) : exitCode !== 0),
      '12秒以内の期待する終了値での停止に失敗しました');
    const state = await stateEvidence(current);
    check(state.Running === false && state.ExitCode === exitCode && await inspect(current, '.RestartCount') === 0,
      '停止後の状態・終了値・再起動回数が不正です');
  }
  async function signalStop(current, signal) {
    const since = performance.now();
    await docker(['kill', '--signal', signal, current.name], { timeout: 3_000 });
    await stopped(current, since, [0, { TERM: 143, INT: 130, HUP: 129 }[signal]]);
    const log = await collectLogs(current);
    check(/\[box-agent\] stopped OK(?:\r?\n|$)/.test(log) && !/\[box-agent\] (?:failed|stopped FAILED)\b/.test(log),
      'supervisorは終了しましたが、agent自身の正常停止を確認できません');
    current.result.agentStoppedNormally = true;
  }

  async function defaultSandbox(current) {
    await processes(current);
    const raw = (await docker(['exec', current.name, 'cat', EVIDENCE])).stdout;
    check(!hasToken(raw), '観測証跡への資格漏出を検出しました');
    const events = raw.trim().split('\n').map((line) => parse(line, 'Chromium起動証跡'));
    current.result.attemptEvents = events;
    const starts = events.filter((event) => event.event === 'spawn');
    const exits = events.filter((event) => event.event === 'exit');
    check(starts.every((event) => event.pipeOnly === true && Number.isInteger(event.pid)), '起動証跡のCDP pipe/PIDが不正です');
    if (current.result.health.sandboxEnabled === true) {
      check(starts.length === 1 && starts[0].attempt === 1 && starts[0].sandboxEnabled === true && exits.length === 0,
        '既定sandboxが有効なのに起動証跡が一致しません');
      await signalStop(current, 'TERM');
      throw new Unverified('既定seccompでもsandboxが利用可能でした。fallback経路は未検証であり合格にしません');
    }
    check(starts.length === 2 && starts[0].attempt === 1 && starts[0].sandboxEnabled === true
      && starts[1].attempt === 2 && starts[1].sandboxEnabled === false && starts[0].pid !== starts[1].pid,
      'sandbox有効で1回起動→無効で1回だけretryという証跡ではありません');
    const fatalExit = exits.length === 1 && ((Number.isInteger(exits[0].exitCode) && exits[0].exitCode !== 0 && exits[0].signal === null)
      || (exits[0].exitCode === null && ['SIGTRAP', 'SIGILL', 'SIGABRT', 'SIGBUS'].includes(exits[0].signal)));
    check(fatalExit && exits[0].attempt === 1 && exits[0].pid === starts[0].pid
      && ['NO_USABLE_SANDBOX', 'NAMESPACE_DENIED'].includes(exits[0].diagnostic)
      && exits[0].policyDenied === false && exits[0].truncated === false,
      '最初の終了が実際のsandbox不可診断によるものと立証できません');
    check(events.indexOf(exits[0]) < events.indexOf(starts[1]), '最初の自然終了前にretryしています');
    check(current.result.processes.chromium.pid === starts[1].pid, 'readyになったChromiumがretryのプロセスではありません');
    current.result.fallbackVerified = true;
    await signalStop(current, 'TERM');
  }

  async function cleanupContainer(current, cleanup = false) {
    const found = await docker(['container', 'inspect', '--format', '{{json .Config.Labels}}', current.name], { allowFailure: true, cleanup });
    const evidenceErrors = [];
    if (!found.ok) {
      check(/No such (?:container|object)/i.test(found.stderr), 'cleanup: コンテナの存在を確認できません');
    } else {
      check(parse(found.stdout, 'cleanup label')?.[label] === runId, 'cleanup: 自分のlabelでないコンテナには触れません');
      // create直後の中断でも、自分のlabel確認後に匿名volume名を回収する。
      const mounts = await inspect(current, '.Mounts', { cleanup });
      for (const mount of mounts) {
        if (['/home/browser', '/tmp'].includes(mount.Destination) && mount.Type === 'volume'
          && typeof mount.Name === 'string' && /^[a-f0-9]{64}$/.test(mount.Name)) current.volumes.add(mount.Name);
      }
      try { await stateEvidence(current, cleanup); } catch (error) { evidenceErrors.push(safeError(error)); }
      try { await collectLogs(current, cleanup); } catch (error) { evidenceErrors.push(safeError(error)); }
      await docker(['rm', '--force', '--volumes', current.name], { cleanup });
    }
    for (const volume of [...current.volumes]) {
      const exists = await docker(['volume', 'inspect', '--format', '{{json .Name}}', volume], { allowFailure: true, cleanup });
      if (exists.ok) {
        // label確認済みの自分のMounts由来だけ。forceなしで他コンテナ使用中なら拒否。
        check(parse(exists.stdout, 'volume name') === volume, 'cleanup: volumeの名前が一致しません');
        await docker(['volume', 'rm', volume], { cleanup });
      } else check(/No such volume/i.test(exists.stderr), 'cleanup: volumeの存在を確認できません');
      current.volumes.delete(volume);
    }
    containers.delete(current.name);
    current.result.cleaned = true;
    check(evidenceErrors.length === 0, `終了時証跡検査: ${evidenceErrors.join('、')}`);
  }

  const cases = [
    { id: 'default-fallback', seccomp: 'default' },
    ...['chromium', 'agent', 'openbox'].map((role) => ({ id: `kill-${role}`, seccomp: 'dedicated', role })),
    { id: 'signal-term-held-mouse', seccomp: 'dedicated', signal: 'TERM', heldMouse: true },
    ...['INT', 'HUP'].map((signal) => ({ id: `signal-${signal.toLowerCase()}`, seccomp: 'dedicated', signal })),
  ];
  const abort = () => lifetime.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  process.once('SIGHUP', abort);
  const timer = setTimeout(abort, 240_000);
  try {
    check(process.argv.length <= 3 && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image),
      '使い方: node apps/box-agent/test/lifecycle-check.mjs [image]（上書きはimageだけ）');
    check(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24以上が必要です');
    check(!script.includes(','), '検査ファイルのbindパスにカンマは使えません');
    seccomp = parse(await readFile(seccompPath, 'utf8'), '専用seccomp');
    await mkdir('/tmp/opencode', { recursive: true });
    artifacts = await mkdtemp('/tmp/opencode/box-agent-lifecycle-check-');
    await chmod(artifacts, 0o700);
    for (const definition of cases) {
      lifetime.signal.throwIfAborted();
      const result = { ...definition, status: 'running', oomChecked: false, logTokenLeak: null, cleaned: false };
      report.cases.push(result);
      const token = randomBytes(32).toString('hex');
      tokens.add(token);
      const current = { name: `${prefix}-${definition.id}`, token, volumes: new Set(), result };
      result.container = current.name;
      containers.set(current.name, current); // createの応答前に中断されても回収対象にする。
      try {
        await start(current);
        if (definition.seccomp === 'default') await defaultSandbox(current);
        else if (definition.role) {
          const since = performance.now();
          await processes(current, definition.role);
          await stopped(current, since);
        } else {
          await processes(current);
          if (definition.heldMouse) {
            const response = await fetch(`${current.base}/actions`, {
              method: 'POST', redirect: 'error',
              headers: { Authorization: `Bearer ${current.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ actionId: 'held-mouse', controlEpoch: 0, action: { kind: 'left_mouse_down' } }),
              signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
            });
            const text = await response.text();
            check(!hasToken(text) && response.status === 200 && parse(text, '押下保持').executed === true,
              '終了前のマウス押下保持が成功しませんでした');
            result.heldMouseStarted = true;
          }
          await signalStop(current, definition.signal);
        }
        result.status = 'passed';
      } catch (error) {
        result.status = error instanceof Unverified ? 'unverified' : 'failed';
        result.reason = safeError(error);
        if (result.status === 'unverified') unverified = true; else failed = true;
      } finally {
        try { await cleanupContainer(current); }
        catch (error) { failed = true; result.status = 'failed'; result.cleanupError = safeError(error); }
        result.oomChecked = result.state?.oomKilled === false;
        await saveReport();
      }
      console.log(`${result.status.toUpperCase()} - ${definition.id}${result.reason ? `: ${result.reason}` : ''}`);
      // cleanup不能のコンテナを残して次のケースを起こさない。
      check(!containers.has(current.name), '専用コンテナの回収に失敗したため後続ケースを中止します');
    }
  } catch (error) {
    failed = true;
    report.error = safeError(error);
  } finally {
    clearTimeout(timer);
    cleanupUntil = Date.now() + 30_000;
    for (const current of containers.values()) {
      try { await cleanupContainer(current, true); report.cleanup.push({ container: current.name, ok: true }); }
      catch (error) { failed = true; report.cleanup.push({ container: current.name, ok: false, reason: safeError(error) }); }
    }
    report.finishedAt = new Date().toISOString();
    report.notRun = cases.filter((entry) => !report.cases.some((result) => result.id === entry.id)).map((entry) => entry.id);
    report.status = failed ? 'failed' : unverified ? 'unverified' : 'passed';
    report.exitCode = failed ? 1 : unverified ? 2 : 0;
    try { await saveReport(); } catch { failed = true; report.exitCode = 1; }
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGHUP', abort);
  }
  if (report.error) console.error(`FAIL - ${report.error}`);
  console.log(`結果: ${failed ? 'failed' : report.status}${artifacts ? ` / ${join(artifacts, 'results.json')}` : ''}`);
  process.exitCode = report.exitCode;
}

if (fileURLToPath(import.meta.url) === OBSERVER) installObserver();
else await runChecks();
