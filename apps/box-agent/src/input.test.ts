import type { ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserChildEnvironment, parseKeyChord, XInput } from './input.ts';

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execMock }));

interface Call { file: string; args: string[]; options: ExecFileOptionsWithBufferEncoding; stdin: string; stdinBytes: Buffer; close(): void }
let calls: Call[];
let failure: ((args: string[]) => boolean) | undefined;
let commandHook: ((args: string[]) => void) | undefined;
let deferClose: ((args: string[]) => boolean) | undefined;
let stdout: Buffer;
let keyState: Buffer;
let pasteOutput: string;
const isPaste = (args: string[]) => args[1]?.endsWith('/x11-paste.py') === true;
const isPasteKey = (args: string[]) => args[0] === 'key' && args[2] === 'ctrl+v';
const inputs: XInput[] = [];
const input = () => { const instance = new XInput(); inputs.push(instance); return instance; };

beforeEach(() => {
  calls = [];
  failure = undefined;
  commandHook = undefined;
  deferClose = undefined;
  stdout = Buffer.alloc(0);
  keyState = Buffer.alloc(32);
  pasteOutput = 'READY\nPASTED\n';
  execMock.mockImplementation((file: string, args: string[], options: ExecFileOptionsWithBufferEncoding,
    callback: (error: Error | null, output: Buffer) => void) => {
    const stdin = new PassThrough();
    const output = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout: output });
    let code = 0;
    const call: Call = { file, args, options, stdin: '', stdinBytes: Buffer.alloc(0), close: () => { child.emit('close', code, code ? 'SIGKILL' : null); } };
    stdin.on('data', (chunk: Buffer) => {
      call.stdin += chunk.toString('utf8');
      call.stdinBytes = Buffer.concat([call.stdinBytes, chunk]);
    });
    calls.push(call);
    queueMicrotask(() => {
      if (isPaste(args) && pasteOutput.startsWith('READY\n')) {
        // readyはstdoutのchunk境界をまたいでも1回だけ扱う。
        output.write('REA');
        output.write('DY\n');
      }
      commandHook?.(args);
      code = failure?.(args) ? 1 : 0;
      callback(code ? new Error('入力本文を含む外部ツールのエラー') : null,
        args.at(-1) === 'snapshot' ? keyState : isPaste(args) ? Buffer.from(pasteOutput) : stdout);
      if (!deferClose?.(args)) call.close();
    });
    return child;
  });
});
afterEach(async () => {
  failure = undefined;
  deferClose = undefined;
  for (const instance of inputs.splice(0)) await instance.releaseAll();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('XInput', () => {
  it('オプション風・シェル風・日本語の本文をargvに入れずUTF-8 stdinへ渡す', async () => {
    const text = '--window 123\n$(not-a-command); 日本語の試験';
    await input().execute({ kind: 'type', text });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ file: '/usr/bin/python3', args: ['-I', expect.stringMatching(/\/x11-keys\.py$/), 'snapshot'] });
    expect(calls[1]).toMatchObject({
      file: '/usr/bin/python3', args: ['-I', expect.stringMatching(/\/x11-paste\.py$/)], stdin: text,
      options: { shell: false, timeout: 10000, killSignal: 'SIGKILL', encoding: 'buffer' },
    });
    expect(calls[2]).toMatchObject({ file: '/usr/bin/xdotool', args: ['key', '--clearmodifiers', 'ctrl+v'], stdin: '' });
    expect(calls.every((call) => !call.args.join(' ').includes(text))).toBe(true);
    expect(calls.some((call) => call.args.at(-1) === 'restore')).toBe(false);
  });

  it.each([
    ['ASCII', 'a'.repeat(16_000)], ['UTF-8', 'あ'.repeat(5333) + 'a'],
  ])('%sの上限16000バイトを同じUTF-8転送・10秒予算・15秒hard deadlineで受ける', async (_label, text) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await expect(input().execute({ kind: 'type', text: text! })).resolves.toEqual({ executed: true });
      expect(timeout).toHaveBeenCalledWith(15_000);
      const typed = calls.find((call) => isPaste(call.args));
      expect(typed?.stdinBytes.length).toBe(16_000);
      expect(typed?.options.timeout).toBe(10_000);
      expect(calls.filter((call) => isPasteKey(call.args))).toHaveLength(1);
    } finally { timeout.mockRestore(); }
  });

  it.each(['abort', 'timeout'])('typeの%s callback後も所有者とキー操作の両方のcloseを待って押下状態を戻す', async (mode) => {
    const instance = input();
    const controller = new AbortController();
    keyState[6] = 4; // 入力前から押されていたキーの状態を復旧補助へそのまま渡す。
    const events: string[] = [];
    let callbackSeen!: () => void;
    const callbackReady = new Promise<void>((resolve) => { callbackSeen = resolve; });
    commandHook = (args) => {
      if (isPaste(args)) {
        if (mode === 'abort') controller.abort();
        events.push('error-callback');
        callbackSeen();
      }
      if (args.at(-1) === 'restore') events.push('restore');
    };
    failure = isPaste;
    deferClose = (args) => isPaste(args) || isPasteKey(args);
    const execution = instance.execute({ kind: 'type', text: 'a'.repeat(6000) }, controller.signal);
    const rejected = expect(execution).rejects.toThrow(mode === 'abort' ? 'INPUT_ABORTED' : 'INPUT_COMMAND_FAILED');
    await callbackReady;
    // browserから並行してcleanupされても、まだXイベントを送れる子が先に終わる。
    const cleanup = instance.releaseAll();
    await Promise.resolve();
    expect(calls.some((call) => call.args.at(-1) === 'restore')).toBe(false);
    events.push('owner-close');
    calls.find((call) => isPaste(call.args))!.close();
    await Promise.resolve();
    expect(calls.some((call) => call.args.at(-1) === 'restore')).toBe(false);
    events.push('keys-close');
    calls.find((call) => isPasteKey(call.args))!.close();
    await rejected;
    await cleanup;
    expect(events).toEqual(['error-callback', 'owner-close', 'keys-close', 'restore']);
    const restored = calls.filter((call) => call.args.at(-1) === 'restore');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.stdinBytes).toEqual(keyState);
    expect(restored[0]?.options.signal).toBeUndefined();
    expect(restored[0]?.options.env).toEqual(browserChildEnvironment());
  });

  it('type復旧失敗は成功扱いせずfailure通知し、次のcleanupで再試行する', async () => {
    const instance = input();
    const onFailure = vi.fn();
    instance.on('failure', onFailure);
    failure = (args) => isPaste(args) || args.at(-1) === 'restore';
    await expect(instance.execute({ kind: 'type', text: 'a' })).rejects.toThrow(/^INPUT_RELEASE_FAILED$/);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ message: 'INPUT_RELEASE_FAILED' });
    failure = undefined;
    await instance.releaseAll();
    expect(calls.filter((call) => call.args.at(-1) === 'restore')).toHaveLength(2);
  });

  it('押下状態を保存できない場合はtypeを開始しない', async () => {
    keyState = Buffer.alloc(31);
    await expect(input().execute({ kind: 'type', text: 'a' })).rejects.toThrow('INPUT_KEY_STATE_FAILED');
    expect(calls.some((call) => isPaste(call.args))).toBe(false);
  });

  it('転送完了通知がない場合は成功にせず押下状態を復旧する', async () => {
    pasteOutput = 'READY\n';
    await expect(input().execute({ kind: 'type', text: '入力' })).rejects.toThrow('INPUT_PASTE_FAILED');
    expect(calls.filter((call) => isPasteKey(call.args))).toHaveLength(1);
    expect(calls.at(-1)?.args.at(-1)).toBe('restore');
  });

  it('所有者の準備前にはpasteキーを送らず、空文字でもクリップボードを変更しない', async () => {
    await expect(input().execute({ kind: 'type', text: '' })).resolves.toEqual({ executed: true });
    expect(calls).toHaveLength(0);
    pasteOutput = '';
    await expect(input().execute({ kind: 'type', text: '入力' })).rejects.toThrow('INPUT_PASTE_FAILED');
    expect(calls.some((call) => isPasteKey(call.args))).toBe(false);
  });

  it('固定pasteキーの失敗も操作失敗とし押下状態を復旧する', async () => {
    failure = isPasteKey;
    await expect(input().execute({ kind: 'type', text: '入力' })).rejects.toThrow();
    expect(calls.at(-1)?.args.at(-1)).toBe('restore');
  });

  it('子の環境に認証情報・loader・Chromium追加flagsを継承しない', () => {
    vi.stubEnv('BROWSER_TOKEN', 'test-only');
    vi.stubEnv('SHELL_TOKEN', 'test-only');
    vi.stubEnv('LD_PRELOAD', '/not-a-library');
    vi.stubEnv('CHROMIUM_FLAGS', '--remote-debugging-port=9222');
    expect(Object.keys(browserChildEnvironment()).sort()).toEqual([
      'DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'USER',
      'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
    ].sort());
  });

  it.each(['--window', 'ctrl+a exec x', 'ctrl+a;whoami', 'ctrl+\nA', 'ctrl++a', 'U0041', 'keydown', 'Control_L+Control_L'])('keysym注入・非allowlistを拒否する: %s', async (text) => {
    await expect(input().execute({ kind: 'key', text })).rejects.toThrow('INPUT_INVALID_KEY');
    expect(calls).toHaveLength(0);
  });

  it('Ctrl+Shift+Aを正規化し逆順に必ず離す', async () => {
    expect(parseKeyChord('ctrl+shift+a')).toEqual(['Control_L', 'Shift_L', 'a']);
    await input().execute({ kind: 'key', text: 'ctrl+shift+a' });
    expect(calls.map((call) => call.args)).toEqual([
      ['keydown', 'Control_L'], ['keydown', 'Shift_L'], ['keydown', 'a'],
      ['keyup', 'a'], ['keyup', 'Shift_L'], ['keyup', 'Control_L'],
    ]);
  });

  it('keydownの部分失敗でも押し始めたキーを解放し、本文入りerrorを隠す', async () => {
    failure = (args) => args[0] === 'keydown' && args[1] === 'a';
    await expect(input().execute({ kind: 'key', text: 'ctrl+a' })).rejects.toThrow(/^INPUT_COMMAND_FAILED$/);
    expect(calls.slice(-2).map((call) => call.args)).toEqual([['keyup', 'a'], ['keyup', 'Control_L']]);
  });

  it('hold中のabortをfinallyで解放する（解放にはabort済みsignalを渡さない）', async () => {
    const controller = new AbortController();
    commandHook = (args) => { if (args[0] === 'keydown') controller.abort(); };
    await expect(input().execute({ kind: 'hold_key', text: 'shift', duration: 10 }, controller.signal)).rejects.toThrow();
    expect(calls.at(-1)!.args).toEqual(['keyup', 'Shift_L']);
    expect(calls.at(-1)!.options.signal).toBeUndefined();
  });

  it.each(['key', 'mouse'] as const)('%sの押下中に並行cleanupされても子のcloseより先に解放しない', async (kind) => {
    const instance = input();
    const controller = new AbortController();
    const down = kind === 'key' ? 'keydown' : 'mousedown';
    const up = kind === 'key' ? 'keyup' : 'mouseup';
    let callbackSeen!: () => void;
    const callbackReady = new Promise<void>((resolve) => { callbackSeen = resolve; });
    commandHook = (args) => { if (args[0] === down) { controller.abort(); callbackSeen(); } };
    failure = (args) => args[0] === down;
    deferClose = (args) => args[0] === down;
    const execution = instance.execute(kind === 'key' ? { kind: 'key', text: 'shift' } : { kind: 'left_mouse_down' }, controller.signal);
    const rejected = expect(execution).rejects.toThrow('INPUT_ABORTED');
    await callbackReady;
    const cleanup = instance.releaseAll();
    try {
      expect(calls.some((call) => call.args[0] === up)).toBe(false);
    } finally {
      calls.find((call) => call.args[0] === down)!.close();
      await rejected;
      await cleanup;
    }
    expect(calls.filter((call) => call.args[0] === up)).toHaveLength(1);
  });

  it('drag移動がtimeout相当で失敗してもマウスを離す', async () => {
    failure = (args) => args[0] === 'mousemove' && args[2] === '200';
    await expect(input().execute({ kind: 'left_click_drag', startX: 10, startY: 20, x: 200, y: 300 })).rejects.toThrow('INPUT_COMMAND_FAILED');
    expect(calls.map((call) => call.args)).toEqual([
      ['mousemove', '--sync', '10', '20'], ['mousedown', '1'],
      ['mousemove', '--sync', '200', '300'], ['mouseup', '1'],
    ]);
  });

  it('明示downは次のmove/upまで保持し、upで解放する', async () => {
    const instance = input();
    await instance.execute({ kind: 'left_mouse_down' });
    await instance.execute({ kind: 'mouse_move', x: 20, y: 30 });
    expect(calls.some((call) => call.args[0] === 'mouseup')).toBe(false);
    await instance.execute({ kind: 'left_mouse_up' });
    expect(calls.at(-1)!.args).toEqual(['mouseup', '1']);
  });

  it('明示downの持ち主が消えても10秒のleaseで離す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await input().execute({ kind: 'left_mouse_down' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.at(-1)!.args).toEqual(['mouseup', '1']);
  });

  it('lease解放に失敗した場合は親へfailureを通知する', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const instance = input();
    const onFailure = vi.fn();
    instance.on('failure', onFailure);
    await instance.execute({ kind: 'left_mouse_down' });
    failure = (args) => args[0] === 'mouseup';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ message: 'INPUT_RELEASE_FAILED' });
  });

  it('カーソル位置とscrollの固定buttonを使う', async () => {
    stdout = Buffer.from('X=120\nY=230\nSCREEN=0\nWINDOW=123\n');
    const instance = input();
    expect(await instance.execute({ kind: 'cursor_position' })).toEqual({ executed: true, cursor: { x: 120, y: 230 } });
    await instance.execute({ kind: 'scroll', direction: 'right', amount: 3, x: 100, y: 200 });
    expect(calls.map((call) => call.args)).toContainEqual(['click', '--repeat', '3', '--delay', '20', '7']);
    expect(calls.at(-1)!.args).toEqual(['mouseup', '7']);
  });

  it('負の座標、上限超過、NUL本文、長すぎるwaitを実行しない', async () => {
    const instance = input();
    await expect(instance.execute({ kind: 'mouse_move', x: -1, y: 20 })).rejects.toThrow('INPUT_INVALID_POSITION');
    await expect(instance.execute({ kind: 'mouse_move', x: 1280, y: 20 })).rejects.toThrow('INPUT_INVALID_POSITION');
    await expect(instance.execute({ kind: 'type', text: 'a\0b' })).rejects.toThrow('INPUT_INVALID_TEXT');
    await expect(instance.execute({ kind: 'type', text: 'a'.repeat(16_001) })).rejects.toThrow('INPUT_INVALID_TEXT');
    await expect(instance.execute({ kind: 'type', text: 'あ'.repeat(5334) })).rejects.toThrow('INPUT_INVALID_TEXT');
    await expect(instance.execute({ kind: 'wait', duration: 11 })).rejects.toThrow('INPUT_INVALID_DURATION');
    expect(calls).toHaveLength(0);
  });

  it('X rootをPNGで取り、1280x800以外の画像は返さない', async () => {
    stdout = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(stdout);
    stdout.write('IHDR', 12);
    stdout.writeUInt32BE(1280, 16);
    stdout.writeUInt32BE(800, 20);
    const instance = input();
    expect(await instance.screenshot()).toEqual(stdout);
    expect(calls[0]).toMatchObject({ file: '/usr/bin/import', args: ['-window', 'root', '-depth', '8', 'png:-'] });
    stdout.writeUInt32BE(640, 16);
    await expect(instance.screenshot()).rejects.toThrow('SCREENSHOT_INVALID_DIMENSIONS');
  });

  it('解放コマンド自体の失敗を成功扱いせず、次のcleanupで再試行する', async () => {
    failure = (args) => args[0] === 'keyup';
    const instance = input();
    await expect(instance.execute({ kind: 'key', text: 'ctrl' })).rejects.toThrow('INPUT_RELEASE_FAILED');
    failure = undefined;
    await instance.releaseAll();
    expect(calls.filter((call) => call.args[0] === 'keyup')).toHaveLength(2);
  });
});
