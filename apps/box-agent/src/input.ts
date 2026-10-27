import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ActionOutput, BrowserAction } from './protocol.ts';

const COMMAND_TIMEOUT_MS = 5_000;
const TYPE_TIMEOUT_MS = 10_000;
const MAX_TYPE_BYTES = 16_000;
const KEY_STATE_HELPER = fileURLToPath(new URL('./x11-keys.py', import.meta.url));
const PASTE_HELPER = fileURLToPath(new URL('./x11-paste.py', import.meta.url));
const HOLD_LEASE_MS = 10_000;
const WIDTH = 1280;
const HEIGHT = 800;

/** 子に親の環境を継承させない。localeはxdotoolのUTF-8入力にも必要。 */
export function browserChildEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin', HOME: '/home/browser', USER: 'browser', LOGNAME: 'browser',
    DISPLAY: ':99', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    XDG_RUNTIME_DIR: '/tmp/runtime-browser', XDG_CONFIG_HOME: '/home/browser/.config',
    XDG_CACHE_HOME: '/tmp/xdg-cache',
  };
}

const aliases: Readonly<Record<string, string>> = {
  ctrl: 'Control_L', control: 'Control_L', alt: 'Alt_L', shift: 'Shift_L', super: 'Super_L',
  enter: 'Return', return: 'Return', escape: 'Escape', esc: 'Escape', tab: 'Tab',
  backspace: 'BackSpace', delete: 'Delete', insert: 'Insert', space: 'space',
  home: 'Home', end: 'End', pageup: 'Prior', page_up: 'Prior', pagedown: 'Next', page_down: 'Next',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};
const namedKeys = new Set([
  'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Shift_L', 'Shift_R', 'Super_L', 'Super_R',
  'Return', 'Escape', 'Tab', 'BackSpace', 'Delete', 'Insert', 'Home', 'End', 'Prior', 'Next',
  'Up', 'Down', 'Left', 'Right', 'space', 'plus', 'minus', 'equal', 'comma', 'period',
  'slash', 'backslash', 'semicolon', 'apostrophe', 'bracketleft', 'bracketright', 'grave',
]);

export function parseKeyChord(text: string): string[] {
  const parts = text.split('+');
  if (parts.length > 8 || parts.length === 0) throw new Error('INPUT_INVALID_KEY');
  const keys = parts.map((part) => {
    const key = aliases[part.toLowerCase()] ?? part;
    if (!/^[a-zA-Z0-9]$/.test(key) && !/^F(?:[1-9]|1[0-2])$/.test(key) && !namedKeys.has(key)) {
      throw new Error('INPUT_INVALID_KEY');
    }
    return key;
  });
  if (new Set(keys).size !== keys.length) throw new Error('INPUT_INVALID_KEY');
  return keys;
}

function position(x: number, y: number): string[] {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
    throw new Error('INPUT_INVALID_POSITION');
  }
  return [String(x), String(y)];
}

function milliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 10) throw new Error('INPUT_INVALID_DURATION');
  return seconds * 1000;
}

/** 実行ファイル・引数を外部から受け取るAPIは作らない。 */
export class XInput extends EventEmitter<{ failure: [Error] }> {
  readonly #keys = new Set<string>();
  readonly #buttons = new Set<number>();
  readonly #commands = new Set<Promise<Buffer>>();
  #mouseLease: ReturnType<typeof setTimeout> | undefined;
  #busy = false;
  #typeKeys: Buffer | undefined;
  #typing: Promise<Buffer> | undefined;
  #releasing: Promise<void> | undefined;

  #run(file: '/usr/bin/xdotool' | '/usr/bin/import' | '/usr/bin/python3', args: string[], input?: string | Buffer,
    signal?: AbortSignal, timeout = COMMAND_TIMEOUT_MS, ready?: () => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let result: { failed: boolean; stdout: Buffer } | undefined;
      const child = execFile(file, args, {
        env: browserChildEnvironment(), encoding: 'buffer', shell: false,
        timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      }, (error, stdout) => {
        // AbortSignalのerror callbackは子の終了より先に来ることがある。
        result = { failed: error !== null, stdout };
      });
      child.once('close', (code) => {
        // 子がもうXイベントを送れないことを確認してから復旧へ進む。
        if (!result || result.failed || code !== 0 || signal?.aborted) {
          reject(new Error(signal?.aborted ? 'INPUT_ABORTED' : 'INPUT_COMMAND_FAILED'));
        } else resolve(result.stdout);
      });
      if (ready) {
        let prefix = '';
        let notified = false;
        child.stdout?.on('data', (chunk: Buffer) => {
          if (notified) return;
          prefix = (prefix + chunk.toString('ascii')).slice(0, 6);
          if (prefix === 'READY\n') { notified = true; ready(); }
        });
      }
      child.stdin?.on('error', () => { /* EPIPEはexecFileの終了結果で扱う。 */ });
      child.stdin?.end(input ?? '', 'utf8');
    });
  }

  async #xdotool(args: string[], signal?: AbortSignal, input?: string, timeout = COMMAND_TIMEOUT_MS): Promise<Buffer> {
    const command = this.#run('/usr/bin/xdotool', args, input, signal, timeout);
    this.#commands.add(command);
    try { return await command; }
    finally { this.#commands.delete(command); }
  }

  async #paste(text: string, signal: AbortSignal): Promise<Buffer> {
    const cancelled = new AbortController();
    const combined = AbortSignal.any([signal, cancelled.signal]);
    let keys: Promise<Buffer> | undefined;
    try {
      const output = await this.#run('/usr/bin/python3', ['-I', PASTE_HELPER], text, combined, TYPE_TIMEOUT_MS, () => {
        // 配列を文字ごとに書き換えるxdotool typeはChromium側のXKB更新と競合する。
        // 本文は一時selectionのUTF-8で渡し、キー操作は固定のpasteだけにする。
        keys = this.#xdotool(['key', '--clearmodifiers', 'ctrl+v'], combined);
        void keys.catch(() => cancelled.abort());
      });
      if (!keys || output.toString('ascii') !== 'READY\nPASTED\n') throw new Error('INPUT_PASTE_FAILED');
    } catch (error) {
      cancelled.abort();
      if (keys) await keys.catch(() => {});
      throw error;
    }
    // selection所有者だけでなく、固定pasteキーの子も終了してから復旧する。
    if (keys) await keys;
    return Buffer.alloc(0);
  }

  async #down(button: number, signal?: AbortSignal): Promise<void> {
    this.#buttons.add(button); // 部分実行後の失敗でもfinallyで離す。
    await this.#xdotool(['mousedown', String(button)], signal);
  }

  releaseAll(): Promise<void> {
    if (this.#releasing) return this.#releasing;
    const result = this.#releaseAll();
    this.#releasing = result;
    void result.then(() => { this.#releasing = undefined; }, () => { this.#releasing = undefined; });
    return result;
  }

  async #releaseAll(): Promise<void> {
    clearTimeout(this.#mouseLease);
    this.#mouseLease = undefined;
    // browserの終了/ダイアログ通知から同時に呼ばれても、入力の子終了が先。
    if (this.#typing) await this.#typing.catch(() => {});
    // keydown/mousedown/scrollもcloseを待つ。先にupを送ると、停止中の子が
    // その後downを送って押下が残る。ここより下の解放コマンド自身は待たない。
    while (this.#commands.size) await Promise.allSettled([...this.#commands]);
    let restoreFailed = false;
    if (this.#typeKeys) {
      try {
        // 失敗したtypeだけ復旧する。正常完了時や通常のhold/mouseでは呼ばない。
        await this.#run('/usr/bin/python3', ['-I', KEY_STATE_HELPER, 'restore'], this.#typeKeys);
        this.#typeKeys = undefined;
      } catch { restoreFailed = true; }
    }
    const results = await Promise.allSettled([
      ...[...this.#keys].reverse().map(async (key) => {
        await this.#xdotool(['keyup', key]);
        this.#keys.delete(key);
      }),
      ...[...this.#buttons].map(async (button) => {
        await this.#xdotool(['mouseup', String(button)]);
        this.#buttons.delete(button);
      }),
    ]);
    if (restoreFailed || results.some((result) => result.status === 'rejected')) {
      const error = new Error('INPUT_RELEASE_FAILED');
      this.emit('failure', error);
      throw error;
    }
  }

  async execute(action: BrowserAction, signal?: AbortSignal): Promise<ActionOutput> {
    if (this.#busy) throw new Error('INPUT_BUSY');
    this.#busy = true;
    signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
    let success = false;
    let preserveMouse = false;
    try {
      signal?.throwIfAborted();
      switch (action.kind) {
        case 'cursor_position': {
          const output = (await this.#xdotool(['getmouselocation', '--shell'], signal)).toString('utf8');
          const x = /^X=(\d+)$/m.exec(output)?.[1];
          const y = /^Y=(\d+)$/m.exec(output)?.[1];
          if (x === undefined || y === undefined) throw new Error('INPUT_CURSOR_UNAVAILABLE');
          position(Number(x), Number(y));
          success = true;
          preserveMouse = true;
          return { executed: true, cursor: { x: Number(x), y: Number(y) } };
        }
        case 'mouse_move':
          await this.#xdotool(['mousemove', '--sync', ...position(action.x, action.y)], signal);
          preserveMouse = true;
          break;
        case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click': {
          await this.#xdotool(['mousemove', '--sync', ...position(action.x, action.y)], signal);
          const button = action.kind === 'right_click' ? 3 : action.kind === 'middle_click' ? 2 : 1;
          const count = action.kind === 'triple_click' ? 3 : action.kind === 'double_click' ? 2 : 1;
          for (let i = 0; i < count; i++) {
            signal?.throwIfAborted();
            await this.#down(button, signal);
            await this.#xdotool(['mouseup', String(button)], signal);
            this.#buttons.delete(button);
            if (i + 1 < count) await delay(80, undefined, { signal });
          }
          break;
        }
        case 'left_mouse_down':
          await this.#down(1, signal);
          // 明示的down/upだけ操作間で保持する。切断したクライアントの押しっぱなしは10秒で解放。
          clearTimeout(this.#mouseLease);
          this.#mouseLease = setTimeout(() => {
            void this.releaseAll().catch(() => { /* releaseAllがfailureを通知する。 */ });
          }, HOLD_LEASE_MS);
          this.#mouseLease.unref();
          preserveMouse = true;
          break;
        case 'left_mouse_up':
          this.#buttons.add(1);
          await this.releaseAll();
          break;
        case 'left_click_drag':
          await this.#xdotool(['mousemove', '--sync', ...position(action.startX, action.startY)], signal);
          await this.#down(1, signal);
          await this.#xdotool(['mousemove', '--sync', ...position(action.x, action.y)], signal);
          break;
        case 'type': {
          if (action.text.includes('\0') || Buffer.byteLength(action.text, 'utf8') > MAX_TYPE_BYTES) throw new Error('INPUT_INVALID_TEXT');
          if (action.text === '') break;
          const keys = await this.#run('/usr/bin/python3', ['-I', KEY_STATE_HELPER, 'snapshot'], undefined, signal);
          if (keys.length !== 32) throw new Error('INPUT_KEY_STATE_FAILED');
          this.#typeKeys = keys;
          // 本文はargv/ファイルでなく固定補助のstdinへ。UnicodeとASCIIで同じ経路を使う。
          const typing = this.#paste(action.text, signal);
          this.#typing = typing;
          try {
            await typing;
            this.#typeKeys = undefined;
          } finally { this.#typing = undefined; }
          break;
        }
        case 'key': case 'hold_key': {
          const keys = parseKeyChord(action.text);
          const duration = action.kind === 'hold_key' ? milliseconds(action.duration) : 0;
          for (const key of keys) {
            signal?.throwIfAborted();
            this.#keys.add(key);
            await this.#xdotool(['keydown', key], signal);
          }
          if (duration) await delay(duration, undefined, { signal });
          break;
        }
        case 'scroll': {
          if (!Number.isInteger(action.amount) || action.amount < 1 || action.amount > 100) throw new Error('INPUT_INVALID_SCROLL');
          const buttons = { up: 4, down: 5, left: 6, right: 7 } as const;
          const button = buttons[action.direction];
          if (!button) throw new Error('INPUT_INVALID_SCROLL');
          if (action.x !== undefined || action.y !== undefined) {
            if (action.x === undefined || action.y === undefined) throw new Error('INPUT_INVALID_POSITION');
            await this.#xdotool(['mousemove', '--sync', ...position(action.x, action.y)], signal);
          }
          this.#buttons.add(button);
          await this.#xdotool(['click', '--repeat', String(action.amount), '--delay', '20', String(button)], signal);
          break;
        }
        case 'wait':
          await delay(milliseconds(action.duration), undefined, { signal });
          preserveMouse = true;
          break;
        default: throw new Error('INPUT_UNSUPPORTED_ACTION');
      }
      success = true;
      return { executed: true };
    } finally {
      try {
        if (!success || !preserveMouse) await this.releaseAll();
      } finally { this.#busy = false; }
    }
  }

  /** 試験ページ専用の未加工X root画像。IMP-003の秘密領域検証・マスクはステップ2で必須。 */
  async screenshot(): Promise<Buffer> {
    const png = await this.#run('/usr/bin/import', ['-window', 'root', '-depth', '8', 'png:-']);
    if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || png.toString('ascii', 12, 16) !== 'IHDR'
      || png.readUInt32BE(16) !== WIDTH || png.readUInt32BE(20) !== HEIGHT) {
      throw new Error('SCREENSHOT_INVALID_DIMENSIONS');
    }
    return png;
  }
}
