import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReadPageOutput, chromiumArguments, ChromiumBrowser, isSandboxFailure } from './browser.ts';
import { CdpError } from './cdp.ts';
import type { CdpEvent } from './cdp.ts';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), fromChild: vi.fn(), open: vi.fn(), readlink: vi.fn(), unlink: vi.fn(),
  inputExecute: vi.fn(), release: vi.fn(), screenshot: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ open: mocks.open, readlink: mocks.readlink, unlink: mocks.unlink }));
vi.mock('./cdp.ts', async (original) => ({
  ...await original<typeof import('./cdp.ts')>(), CdpPipe: class { static fromChild = mocks.fromChild; },
}));
vi.mock('./input.ts', async (original) => ({
  ...await original<typeof import('./input.ts')>(),
  XInput: class extends EventEmitter {
    execute = mocks.inputExecute;
    releaseAll = mocks.release;
    screenshot = mocks.screenshot;
  },
}));

interface Item {
  tag?: string;
  role?: string;
  name?: string;
  attributes?: string[];
  value?: string;
  axValue?: string;
  protected?: boolean;
  rect?: number[];
  styles?: string[];
  parent?: number;
  nodeType?: number;
  client?: number[];
  css?: Record<string, string>;
  layout?: boolean;
}

const computedStyles = ['display', 'visibility', 'opacity', 'overflow-x', 'overflow-y',
  'transform', 'clip-path', 'clip', 'contain', 'content-visibility', 'border-radius', 'mask-image', 'filter'];
const defaultStyles = ['block', 'visible', '1', 'visible', 'visible', 'none', 'none', 'auto', 'none', 'visible', '0px', 'none', 'none'];

function pageFixture(items: Item[]) {
  const strings: string[] = [];
  // Chromium156 AddStringと同じ空文字sentinel。通常Elementだけの架空schemaにしない。
  const index = (text: string): number => { if (text === '') return -1; strings.push(text); return strings.length - 1; };
  const inputValue = { index: [] as number[], value: [] as number[] };
  const textValue = { index: [] as number[], value: [] as number[] };
  items.forEach((item, i) => {
    if (item.value !== undefined) {
      const values = item.tag === 'TEXTAREA' ? textValue : inputValue;
      values.index.push(i); values.value.push(index(item.value));
    }
  });
  const laidOut = items.map((item, index) => ({ item, index })).filter(({ item }) => item.layout !== false);
  return {
    ax: { nodes: items.map((item, i) => ({
      ignored: false, backendDOMNodeId: i + 1, role: { value: item.role ?? 'button' }, name: { value: item.name ?? `要素${i}` },
      ...(item.axValue !== undefined ? { value: { value: item.axValue } } : {}),
      ...(item.protected ? { properties: [{ name: 'protected', value: { value: true } }] } : {}),
    })) },
    snapshot: {
      strings,
      documents: [{ scrollOffsetX: 0, scrollOffsetY: 0, nodes: {
        backendNodeId: items.map((_, i) => i + 1), nodeType: items.map((item) => item.nodeType ?? 1),
        nodeValue: items.map(() => -1),
        nodeName: items.map((item) => index(item.tag ?? 'BUTTON')),
        attributes: items.map((item) => (item.attributes ?? []).map(index)),
        parentIndex: items.map((item) => item.parent ?? -1), inputValue, textValue,
      }, layout: {
        nodeIndex: laidOut.map(({ index }) => index), bounds: laidOut.map(({ item }) => item.rect ?? [10, 20, 100, 30]),
        clientRects: laidOut.map(({ item }) => item.nodeType === 9 ? [] : item.client ?? [0, 0, item.rect?.[2] ?? 100, item.rect?.[3] ?? 30]),
        styles: laidOut.map(({ item }) => item.nodeType === 9 ? []
          : computedStyles.map((name, i) => index(item.css?.[name] ?? item.styles?.[i] ?? defaultStyles[i]!))),
      } }],
    },
  };
}

describe('read_pageの秘密除外と境界', () => {
  it('Documentのlayout.styles=[]と空input/空属性のStringIndex=-1を受け付ける', () => {
    const { ax, snapshot } = pageFixture([
      { nodeType: 9, tag: '#document', role: 'RootWebArea' },
      { tag: 'INPUT', role: 'textbox', parent: 0, name: '空入力', value: '', attributes: ['placeholder', ''] },
    ]);
    expect(snapshot.documents[0]!.layout.styles[0]).toEqual([]);
    expect(snapshot.documents[0]!.nodes.inputValue.value).toEqual([-1]);
    expect(buildReadPageOutput(ax, snapshot).page).toEqual([{ role: 'textbox', name: '空入力', value: '', center: { x: 60, y: 35 } }]);
    snapshot.documents[0]!.nodes.inputValue.value[0] = -2;
    expect(() => buildReadPageOutput(ax, snapshot)).toThrow('BROWSER_INVALID_CDP_DATA');
  });

  it('textareaはtextValueを取り込み、空値・秘密判定・反映先の名前・長さ制限にも共通適用する', () => {
    const { ax, snapshot } = pageFixture([
      { tag: 'TEXTAREA', role: 'textbox', name: '説明', value: '日本語の改行\n'.repeat(300), axValue: '使わないAX値' },
      { tag: 'TEXTAREA', role: 'textbox', name: '空の説明', value: '' },
      { tag: 'TEXTAREA', role: 'textbox', name: '疑似秘密の名前', value: 'textarea疑似秘密', attributes: ['autocomplete', 'current-password'] },
      { name: 'textarea疑似秘密の参照' },
    ]);
    expect(snapshot.documents[0]!.nodes.inputValue.index).toEqual([]);
    const result = buildReadPageOutput(ax, snapshot);
    expect(result.page?.[0]?.value).toBe([...('日本語の改行\n'.repeat(300))].slice(0, 1024).join(''));
    expect(result.page?.[1]?.value).toBe('');
    expect(result.page?.[2]).not.toHaveProperty('value');
    expect(result.page?.[3]?.name).toBe('[非表示]');
    expect(JSON.stringify(result)).not.toMatch(/textarea疑似秘密|疑似秘密の名前|使わないAX値/);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
  });

  it('DOMで確認した可視ボタン・入力を返し、AX.valueではなくDOM値を使う', () => {
    const { ax, snapshot } = pageFixture([
      { name: '送信' }, { tag: 'INPUT', role: 'textbox', name: '名前', value: '試験の名前', axValue: '古いAX値' },
      { role: 'heading', tag: 'H1', name: '見出し' },
    ]);
    const result = buildReadPageOutput(ax, snapshot);
    expect(result.page).toEqual([
      { role: 'button', name: '送信', center: { x: 60, y: 35 } },
      { role: 'textbox', name: '名前', value: '試験の名前', center: { x: 60, y: 35 } },
      { role: 'heading', name: '見出し', center: { x: 60, y: 35 } },
    ]);
    expect(JSON.stringify(result)).not.toContain('古いAX値');
  });

  it.each(['current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp'])('T-1 autocomplete %sはAX name/value・DOM valueを返さない', (autocomplete) => {
    const { ax, snapshot } = pageFixture([
      { tag: 'INPUT', role: 'textbox', name: 'AX内の疑似秘密', value: 'DOM内の疑似秘密', axValue: '別のAX疑似値', attributes: ['autocomplete', `section-check SHIPPING ${autocomplete.toUpperCase()}`] },
      { name: '参照 DOM内の疑似秘密' },
    ]);
    const result = buildReadPageOutput(ax, snapshot);
    const json = JSON.stringify(result);
    for (const secret of ['AX内の疑似秘密', 'DOM内の疑似秘密', '別のAX疑似値']) expect(json).not.toContain(secret);
    expect(result.page?.[0]?.name).toBe('[非表示]');
    expect(result.page?.[0]).not.toHaveProperty('value');
    expect(result.page?.[1]?.name).toBe('[非表示]');
  });

  it('password・AX protected・秘密の子孫も除外する', () => {
    const { ax, snapshot } = pageFixture([
      { tag: 'INPUT', role: 'textbox', attributes: ['type', 'PASSWORD'], name: 'password擬似値', value: 'DOM擬似値' },
      { tag: 'INPUT', role: 'textbox', protected: true, name: 'protected擬似値', value: 'protectedDOM' },
      { parent: 0, name: '子孫の疑似値' },
    ]);
    const result = buildReadPageOutput(ax, snapshot);
    expect(result.page?.map((item) => item.name)).toEqual(['[非表示]', '[非表示]', '[非表示]']);
    expect(JSON.stringify(result)).not.toMatch(/擬似値|protectedDOM/);
  });

  it('DOM属性・backend対応を確認できない要素の名前や値を返さない', () => {
    const { ax, snapshot } = pageFixture([{ tag: 'INPUT', role: 'textbox', name: '未確認の値', value: '未確認DOM' }]);
    snapshot.documents[0]!.nodes.attributes = [];
    expect(buildReadPageOutput(ax, snapshot).page).toEqual([]);
    ax.nodes[0]!.backendDOMNodeId = 999;
    expect(buildReadPageOutput(ax, snapshot).page).toEqual([]);
  });

  it('不可視・画面外・面積0を除外し、部分表示は画面内の中心にする', () => {
    const { ax, snapshot } = pageFixture([
      { styles: ['none', 'visible', '1'] }, { styles: ['block', 'hidden', '1'] },
      { styles: ['block', 'visible', '0'] }, { rect: [1300, 0, 10, 10] }, { rect: [0, 0, 0, 20] },
      { name: '部分表示', rect: [-20, 20, 40, 20] }, { name: '非表示親の子', parent: 2 },
    ]);
    expect(buildReadPageOutput(ax, snapshot).page).toEqual([{ role: 'button', name: '部分表示', center: { x: 10, y: 30 } }]);
  });

  it('overflow:hidden祖先で完全clipされた要素を除外し、部分clipはclient領域との交差の中心にする', () => {
    const { ax, snapshot } = pageFixture([
      { tag: 'DIV', role: 'generic', rect: [10, 20, 100, 80], client: [2, 3, 94, 72], css: { 'overflow-x': 'hidden', 'overflow-y': 'hidden' } },
      { name: '完全clip', parent: 0, rect: [120, 30, 30, 20] },
      { name: '部分clip', parent: 0, rect: [90, 80, 50, 40] },
    ]);
    expect(buildReadPageOutput(ax, snapshot).page).toEqual([{ role: 'button', name: '部分clip', center: { x: 98, y: 87 } }]);
    snapshot.documents[0]!.layout.clientRects[0] = [];
    expect(buildReadPageOutput(ax, snapshot).page).toEqual([]);
  });

  it('visibility:hidden親のvisible子は残し、opacity:0親の子は残さない', () => {
    const { ax, snapshot } = pageFixture([
      { tag: 'DIV', role: 'generic', css: { visibility: 'hidden' } },
      { name: 'visibleで復活', parent: 0, css: { visibility: 'visible' } },
      { tag: 'DIV', role: 'generic', css: { opacity: '0' } },
      { name: '透明な親の子', parent: 2, css: { opacity: '1' } },
    ]);
    expect(buildReadPageOutput(ax, snapshot).page?.map((item) => item.name)).toEqual(['visibleで復活']);
  });

  it('rootのoverflowはスクロール済みviewportでclipする', () => {
    const { ax, snapshot } = pageFixture([
      { tag: 'HTML', role: 'generic', rect: [0, 0, 1280, 2000], client: [0, 0, 1280, 800], css: { 'overflow-y': 'auto' } },
      { parent: 0, name: 'スクロール先', rect: [10, 900, 100, 30] },
    ]);
    snapshot.documents[0]!.scrollOffsetY = 800;
    expect(buildReadPageOutput(ax, snapshot).page).toEqual([{ role: 'button', name: 'スクロール先', center: { x: 60, y: 115 } }]);
  });

  const uncertainStyles: Record<string, string>[] = [
    { transform: 'matrix(1, 0, 0, 1, 10, 0)' }, { 'clip-path': 'circle(10px)' }, { 'mask-image': 'linear-gradient(transparent, transparent)' },
  ];
  it.each(uncertainStyles)
    ('snapshot矩形では可視領域を保証できない祖先を通さない %j', (css) => {
      const { ax, snapshot } = pageFixture([{ tag: 'DIV', role: 'generic', css }, { parent: 0 }]);
      expect(buildReadPageOutput(ax, snapshot).page).toEqual([]);
    });

  it('件数を200に制限し、上限より後にある秘密入力も先に収集する', () => {
    const { ax, snapshot } = pageFixture([
      { name: '後方の疑似秘密を参照' }, ...Array.from({ length: 230 }, () => ({ name: '' })),
      { tag: 'INPUT', role: 'textbox', value: '後方の疑似秘密', attributes: ['type', 'password'] },
    ]);
    const result = buildReadPageOutput(ax, snapshot);
    expect(result.page).toHaveLength(200);
    expect(JSON.stringify(result)).not.toContain('後方の疑似秘密');
  });

  it('日本語・JSONエスケープ・通知も含む応答全体を16KiBに制限する', () => {
    const { ax, snapshot } = pageFixture(Array.from({ length: 230 }, () => ({
      name: '\n"日本語😀'.repeat(200), tag: 'INPUT', role: 'textbox', value: '\n"入力😀'.repeat(500),
    })));
    const output = buildReadPageOutput(ax, snapshot, '新しいタブを前面にしました。');
    expect(output.page!.length).toBeGreaterThan(0);
    expect(output.page!.length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16 * 1024);
  });

  it('不正なunknownと壊れたsnapshotを受理しない', () => {
    expect(() => buildReadPageOutput(null, {})).toThrow('BROWSER_INVALID_CDP_DATA');
    const { ax, snapshot } = pageFixture([{ name: '見本' }]);
    snapshot.documents[0]!.layout.bounds[0] = [Number.NaN, 0, 20, 20];
    expect(() => buildReadPageOutput(ax, snapshot)).toThrow('BROWSER_INVALID_CDP_DATA');
  });
});

class FakeCdp extends EventEmitter<{ event: [CdpEvent]; disconnect: [Error] }> {
  closed = false;
  targets = ['page1'];
  focused = ['page1'];
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  firstFailure: (() => Promise<Record<string, unknown>>) | undefined;
  navigate: (() => void) | undefined;
  beforeFocusResponse: (() => void) | undefined;
  activated: (() => void) | undefined;
  fixture = pageFixture([{ name: '試験ボタン' }]);

  async command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    this.calls.push({ method, params, sessionId });
    if (method === 'Browser.getVersion' && this.firstFailure) return this.firstFailure();
    if (method === 'Target.setAutoAttach') {
      for (const id of this.targets) this.emit('event', { method: 'Target.attachedToTarget', params: { targetInfo: { type: 'page', targetId: id }, sessionId: `s-${id}` } });
    }
    if (method === 'Target.getTargets') return { targetInfos: this.targets.map((targetId) => ({ type: 'page', targetId })) };
    if (method === 'Target.attachToTarget') return { sessionId: `s-${String(params.targetId)}` };
    if (method === 'Browser.getWindowForTarget') return { windowId: 1, bounds: { windowState: 'normal' } };
    if (method === 'Target.activateTarget') {
      this.focused = [String(params.targetId)];
      this.activated?.();
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate') {
      const result = { result: { value: { focused: this.focused.includes(sessionId?.slice(2) ?? ''), width: 1280, height: 800, scale: 1, ratio: 1 } } };
      this.beforeFocusResponse?.();
      return result;
    }
    if (method === 'Page.navigate') this.navigate?.();
    if (method === 'Accessibility.getFullAXTree') return this.fixture.ax;
    if (method === 'DOMSnapshot.captureSnapshot') return this.fixture.snapshot;
    return {};
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('disconnect', new CdpError('CDP_DISCONNECTED'));
  }

  newTab(id: string): void {
    this.targets.push(id);
    this.emit('event', { method: 'Target.targetCreated', params: { targetInfo: { type: 'page', targetId: id } } });
  }
}

const browsers: ChromiumBrowser[] = [];
let childProcesses: ChildProcess[];
let transports: FakeCdp[];
let transportSetup: ((transport: FakeCdp, child: ChildProcess, index: number) => void) | undefined;
let closeLease: ReturnType<typeof vi.fn>;

beforeEach(() => {
  childProcesses = [];
  transports = [];
  transportSetup = undefined;
  closeLease = vi.fn().mockResolvedValue(undefined);
  mocks.open.mockResolvedValue({ fd: 42, close: closeLease });
  mocks.readlink.mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
  mocks.unlink.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.inputExecute.mockResolvedValue({ executed: true });
  mocks.screenshot.mockResolvedValue(Buffer.from('test-png'));
  mocks.spawn.mockImplementation((file: string) => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'stderr', { value: new PassThrough() });
    vi.spyOn(child, 'kill').mockImplementation(() => { queueMicrotask(() => child.emit('exit', 0, null)); return true; });
    if (file === '/usr/bin/flock') queueMicrotask(() => child.emit('exit', 0, null));
    else childProcesses.push(child);
    return child;
  });
  mocks.fromChild.mockImplementation((child: ChildProcess) => {
    const pipe = new FakeCdp();
    transports.push(pipe);
    transportSetup?.(pipe, child, transports.length);
    return pipe;
  });
  for (const mock of Object.values(mocks)) mock.mockClear();
});
afterEach(async () => { for (const browser of browsers.splice(0)) await browser.stop(); vi.unstubAllEnvs(); });

async function start(): Promise<ChromiumBrowser> {
  const browser = new ChromiumBrowser({ proxyUrl: 'http://egress:3128' });
  browsers.push(browser);
  await browser.start();
  return browser;
}

function pendingInput(): Promise<AbortSignal> {
  return new Promise((entered) => {
    mocks.inputExecute.mockImplementationOnce((_action: unknown, signal: AbortSignal) => {
      entered(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('INPUT_ABORTED')), { once: true });
      });
    });
  });
}

describe('Chromium backend', () => {
  it('固定flags・pipeのみ・秘密なし環境で起動し、排他後にSingleton3つを削除する', async () => {
    vi.stubEnv('BROWSER_TOKEN', 'test-only');
    const browser = await start();
    expect(browser.ready()).toBe(true);
    expect(browser.sandboxEnabled).toBe(true);
    const chromiumCall = mocks.spawn.mock.calls.find(([file]) => file === '/usr/lib/chromium/chromium');
    expect(chromiumCall?.[1]).toEqual(chromiumArguments('http://egress:3128'));
    expect(chromiumCall?.[2]).toMatchObject({ stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true });
    expect(chromiumCall?.[2].env).not.toHaveProperty('BROWSER_TOKEN');
    expect(mocks.unlink.mock.calls).toEqual(['SingletonLock', 'SingletonSocket', 'SingletonCookie'].map((name) => [`/home/browser/${name}`]));
    expect(mocks.spawn.mock.invocationCallOrder[0]).toBeLessThan(mocks.unlink.mock.invocationCallOrder[0]!);
    await browser.stop();
    expect(closeLease).toHaveBeenCalledOnce();
    expect(browser.ready()).toBe(false);
  });

  it('proxyは固定のegressだけ、空だけがローカル検証用でloopback自動bypassを無効にする', () => {
    expect(chromiumArguments('http://egress:3128')).toContain('--proxy-bypass-list=shell;<-loopback>');
    expect(chromiumArguments('').some((arg) => arg.startsWith('--proxy-'))).toBe(false);
    expect(chromiumArguments('').some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(false);
    expect(() => chromiumArguments('http://localhost:3128')).toThrow('BROWSER_INVALID_PROXY');
    expect(() => chromiumArguments(' http://egress:3128')).toThrow('BROWSER_INVALID_PROXY');
  });

  it('sandbox起動エラーで自然終了したときだけ1回no-sandboxでretryする', async () => {
    transportSetup = (pipe, child, index) => {
      if (index !== 1) return;
      pipe.firstFailure = async () => {
        child.stderr?.emit('data', Buffer.from('[123:123:1026/123456.000:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] No usable sandbox!\n'));
        child.emit('exit', 1, null);
        throw new CdpError('CDP_CHILD_EXIT');
      };
    };
    const browser = await start();
    expect(browser.sandboxEnabled).toBe(false);
    expect(childProcesses).toHaveLength(2);
    expect(mocks.spawn.mock.calls.filter(([file]) => file === '/usr/lib/chromium/chromium').map((call) => call[1].includes('--no-sandbox'))).toEqual([false, true]);
  });

  it.each(['SIGTRAP', 'SIGILL', 'SIGABRT', 'SIGBUS'])('sandbox FATALのcode=null/signal=%sを自然異常終了として1回retryする', async (signal) => {
    transportSetup = (pipe, child, index) => {
      if (index !== 1) return;
      pipe.firstFailure = async () => {
        child.stderr?.emit('data', Buffer.from('[123:123:1026/123456.000:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] No usable sandbox!\n'));
        child.emit('exit', null, signal);
        throw new CdpError('CDP_CHILD_EXIT');
      };
    };
    expect((await start()).sandboxEnabled).toBe(false);
    expect(childProcesses).toHaveLength(2);
  });

  it.each(['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGHUP', 'SIGSEGV'])('sandbox診断があっても外部停止/未知のcrash signal %sではretryしない', async (signal) => {
    transportSetup = (pipe, child) => {
      pipe.firstFailure = async () => {
        child.stderr?.emit('data', Buffer.from('Failed to move to new namespace: errno = Operation not permitted\n'));
        child.emit('exit', null, signal);
        throw new CdpError('CDP_CHILD_EXIT');
      };
    };
    await expect(start()).rejects.toThrow('BROWSER_START_FAILED');
    expect(childProcesses).toHaveLength(1);
  });

  it('stop中はsandbox診断とFATAL終了が競合してもretryしない', async () => {
    const browser = new ChromiumBrowser();
    browsers.push(browser);
    transportSetup = (pipe, child) => {
      pipe.firstFailure = async () => {
        child.stderr?.emit('data', Buffer.from('Failed to move to new namespace: errno = Operation not permitted\n'));
        void browser.stop();
        child.emit('exit', null, 'SIGTRAP');
        throw new CdpError('CDP_DISCONNECTED');
      };
    };
    await expect(browser.start()).rejects.toThrow('BROWSER_START_FAILED');
    expect(childProcesses).toHaveLength(1);
  });

  it('sandbox FATALがあってもCDPの一般エラーはretry根拠にしない', async () => {
    transportSetup = (pipe, child) => {
      pipe.firstFailure = async () => {
        child.stderr?.emit('data', Buffer.from('Failed to move to new namespace: errno = Operation not permitted\n'));
        child.emit('exit', null, 'SIGTRAP');
        throw new CdpError('CDP_COMMAND_FAILED');
      };
    };
    await expect(start()).rejects.toThrow('BROWSER_START_FAILED');
    expect(childProcesses).toHaveLength(1);
  });

  it.each(['CDP_TIMEOUT', 'CDP_COMMAND_FAILED', 'CDP_INVALID_JSON', 'CDP_CHILD_EXIT'])('policy/CDPエラー %sではsandboxを無効にしない', async (code) => {
    transportSetup = (pipe, child) => {
      pipe.firstFailure = async () => {
        child.stderr?.emit('data', Buffer.from('DevTools remote debugging is disallowed by policy.\n'));
        child.emit('exit', 1, null);
        throw new CdpError(code);
      };
    };
    await expect(start()).rejects.toThrow('BROWSER_START_FAILED');
    expect(childProcesses).toHaveLength(1);
    expect(mocks.spawn.mock.calls.some((call) => Array.isArray(call[1]) && call[1].includes('--no-sandbox'))).toBe(false);
    expect(closeLease).toHaveBeenCalledOnce();
  });

  it('sandboxの一般的な文字列や権限エラーだけをfallback根拠にしない', () => {
    expect(isSandboxFailure('console: No usable sandbox!')).toBe(false);
    expect(isSandboxFailure('Operation not permitted')).toBe(false);
    expect(isSandboxFailure('Failed to move to new namespace: PID namespaces supported, errno = Operation not permitted')).toBe(true);
    expect(isSandboxFailure('Failed to move to new namespace: errno = Operation not permitted\nRemote debugging is disallowed by policy')).toBe(false);
  });

  it('sandbox retryも失敗したら3回目を起動しない', async () => {
    transportSetup = (pipe, child) => {
      pipe.firstFailure = async () => {
        child.stderr?.emit('data', Buffer.from('Failed to move to new namespace: errno = Operation not permitted\n'));
        child.emit('exit', 1, null);
        throw new CdpError('CDP_CHILD_EXIT');
      };
    };
    await expect(start()).rejects.toThrow('BROWSER_START_FAILED');
    expect(childProcesses).toHaveLength(2);
  });

  it('ローカルで生存しているSingletonの持ち主がいれば消さない', async () => {
    mocks.readlink.mockResolvedValue(`${hostname()}-${process.pid}`);
    await expect(start()).rejects.toThrow('BROWSER_PROFILE_IN_USE');
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.fromChild).not.toHaveBeenCalled();
  });

  it('同じprofileのlockが取得できなければSingletonを触らずChromiumを起動しない', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new ChildProcess();
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    await expect(start()).rejects.toThrow('BROWSER_PROFILE_IN_USE');
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.fromChild).not.toHaveBeenCalled();
    expect(closeLease).toHaveBeenCalledOnce();
  });

  it('異常終了をfailureとして1回通知しreadyを落とす', async () => {
    const browser = await start();
    const failure = vi.fn();
    browser.on('failure', failure);
    childProcesses[0]!.emit('exit', 1, null);
    transports[0]!.close();
    expect(failure).toHaveBeenCalledOnce();
    expect(browser.ready()).toBe(false);
    await expect(browser.execute({ kind: 'wait', duration: 0 })).rejects.toThrow('BROWSER_NOT_READY');
  });

  it('navigate成功後の旧document破棄を遷移失敗にしない', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    pipe.navigate = () => {
      pipe.beforeFocusResponse = () => {
        pipe.emit('event', { method: 'Runtime.executionContextsCleared', sessionId: 's-page1', params: {} });
      };
    };
    await expect(browser.execute({ kind: 'open_url', url: 'http://shell:8000/next' })).resolves.toEqual({ executed: true });
    expect(pipe.calls.at(-1)?.method).toBe('Page.navigate');
  });

  it('HTTP(S)だけPage.navigateし、read_pageはAX+DOMSnapshotから作る', async () => {
    const browser = await start();
    await browser.execute({ kind: 'open_url', url: 'http://shell:8000/test' });
    expect(transports[0]!.calls).toContainEqual({ method: 'Page.navigate', params: { url: 'http://shell:8000/test' }, sessionId: 's-page1' });
    await expect(browser.execute({ kind: 'open_url', url: 'file:///etc/passwd' })).rejects.toThrow('BROWSER_INVALID_URL');
    expect((await browser.execute({ kind: 'read_page' })).page?.[0]?.name).toBe('試験ボタン');
    expect(transports[0]!.calls).toContainEqual({ method: 'DOMSnapshot.captureSnapshot',
      params: { computedStyles, includeDOMRects: true }, sessionId: 's-page1' });
    expect(transports[0]!.calls.some((call) => call.method === 'Page.captureScreenshot')).toBe(false);
  });

  it('新しいtab/windowをactivateして操作結果の文で通知する', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    pipe.navigate = () => pipe.newTab('page2');
    const output = await browser.execute({ kind: 'open_url', url: 'http://shell:8000/newtab' });
    expect(output.text).toContain('新しいタブまたはウィンドウ');
    expect(pipe.calls).toContainEqual({ method: 'Target.activateTarget', params: { targetId: 'page2' }, sessionId: undefined });
    expect(pipe.calls).toContainEqual({ method: 'Browser.setWindowBounds', params: { windowId: 1, bounds: { windowState: 'fullscreen' } }, sessionId: undefined });
    expect(pipe.focused).toEqual(['page2']);
  });

  it.each(['read_page', 'left_click'] as const)('%sで停止中の新tabを待ち詰まらせず、再開直後のdialogも通知する', async (kind) => {
    const browser = await start();
    const pipe = transports[0]!;
    const command = pipe.command.bind(pipe);
    let pageEnabled = false;
    let resumed = false;
    let releaseEnable!: () => void;
    const enabledResponse = new Promise<Record<string, unknown>>((resolve) => { releaseEnable = () => resolve({}); });
    vi.spyOn(pipe, 'command').mockImplementation(async (method, params = {}, sessionId) => {
      if (sessionId === 's-page2' && method === 'Runtime.enable' && resumed) {
        throw new CdpError('CDP_TIMEOUT'); // 再開後のalertはrenderer側初期化を止める。
      }
      if (sessionId === 's-page2' && method === 'Page.enable') {
        pageEnabled = true;
        if (resumed) releaseEnable();
        return enabledResponse;
      }
      if (sessionId === 's-page2' && method === 'Runtime.runIfWaitingForDebugger') {
        resumed = true;
        releaseEnable();
        const observed = pageEnabled;
        queueMicrotask(() => {
          if (observed) pipe.emit('event', { method: 'Page.javascriptDialogOpening', sessionId,
            params: { type: 'alert' } });
        });
      }
      return command(method, params, sessionId);
    });
    if (kind === 'read_page') {
      pipe.newTab('page2');
      await expect(browser.execute({ kind })).rejects.toThrow('JavaScript alert');
      expect(mocks.inputExecute).not.toHaveBeenCalled();
    } else {
      mocks.inputExecute.mockImplementationOnce(async () => {
        pipe.newTab('page2');
        throw new Error('INPUT_ABORTED');
      });
      const result = await browser.execute({ kind, x: 20, y: 20 });
      expect(result.executed).toBe(true);
      expect(result.text).toContain('JavaScript alert');
      expect(mocks.inputExecute).toHaveBeenCalledTimes(1);
    }
    expect((await browser.execute({ kind: 'screenshot' })).text).toContain('JavaScript alert');
  }, 1500);

  it('前面が曖昧・新しいタブが複数なら入力を実行しない', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    pipe.targets.push('page2');
    pipe.focused.push('page2');
    await expect(browser.execute({ kind: 'type', text: '試験' })).rejects.toThrow('BROWSER_AMBIGUOUS_FRONT_TAB');
    expect(mocks.inputExecute).not.toHaveBeenCalled();
    pipe.newTab('page3');
    pipe.newTab('page4');
    await expect(browser.execute({ kind: 'type', text: '試験' })).rejects.toThrow('BROWSER_AMBIGUOUS_NEW_TABS');
    expect(mocks.inputExecute).not.toHaveBeenCalled();
  });

  it.each(['new-target', 'focus-loss'])('取得済みfocused:trueの返却直前に%sが来たら入力を開始しない', async (change) => {
    const browser = await start();
    const pipe = transports[0]!;
    pipe.beforeFocusResponse = () => {
      pipe.beforeFocusResponse = undefined;
      if (change === 'new-target') pipe.newTab('page2');
      else {
        pipe.focused = [];
        pipe.emit('event', { method: 'Runtime.bindingCalled', sessionId: 's-page1',
          params: { name: '__boxAgentFocusChanged', payload: 'unfocused', executionContextId: 1 } });
      }
    };
    await expect(browser.execute({ kind: 'type', text: 'テスト専用入力' })).rejects.toThrow('BROWSER_INPUT_TARGET_CHANGED');
    expect(mocks.inputExecute).not.toHaveBeenCalled();
  });

  it('前面確認がreturnした直後のイベントも入力直前の世代検証で止める', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    pipe.beforeFocusResponse = () => {
      pipe.beforeFocusResponse = undefined;
      // focusを評価するawait継続の後、executeのawait継続の前に配送する。
      queueMicrotask(() => queueMicrotask(() => pipe.newTab('page2')));
    };
    await expect(browser.execute({ kind: 'type', text: 'テスト専用入力' })).rejects.toThrow('BROWSER_INPUT_TARGET_CHANGED');
    expect(mocks.inputExecute).not.toHaveBeenCalled();
  });

  it('意図した新tab前面化による旧tabのblur後はfocusを取り直して入力できる', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    await browser.execute({ kind: 'read_page' }); // 旧tabのfocus contextを確認済みにする。
    pipe.newTab('page2');
    pipe.activated = () => pipe.emit('event', { method: 'Runtime.bindingCalled', sessionId: 's-page1',
      params: { name: '__boxAgentFocusChanged', payload: 'unfocused', executionContextId: 1 } });
    const result = await browser.execute({ kind: 'type', text: 'テスト専用入力' });
    expect(result.text).toContain('新しいタブまたはウィンドウを前面');
    expect(mocks.inputExecute).toHaveBeenCalledOnce();
    expect(pipe.focused).toEqual(['page2']);
  });

  it('意図した新tab前面化の途中で別のtargetが作られた場合は入力を開始しない', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    pipe.newTab('page2');
    pipe.activated = () => pipe.newTab('page3');
    await expect(browser.execute({ kind: 'type', text: 'テスト専用入力' })).rejects.toThrow('BROWSER_INPUT_TARGET_CHANGED');
    expect(mocks.inputExecute).not.toHaveBeenCalled();
  });

  it.each(['destroy', 'detach', 'replace-session', 'new-target', 'attach-new-target', 'context-destroy', 'focus-loss'])
    ('left_mouse_down後、操作間の%sで解放する', async (change) => {
      const browser = await start();
      const pipe = transports[0]!;
      await browser.execute({ kind: 'left_mouse_down' });
      mocks.release.mockClear();
      if (change === 'destroy') {
        pipe.targets = [];
        pipe.emit('event', { method: 'Target.targetDestroyed', params: { targetId: 'page1' } });
      } else if (change === 'detach') {
        pipe.emit('event', { method: 'Target.detachedFromTarget', params: { sessionId: 's-page1' } });
      } else if (change === 'replace-session' || change === 'attach-new-target') {
        pipe.emit('event', { method: 'Target.attachedToTarget', params: { sessionId: 's-replacement',
          targetInfo: { type: 'page', targetId: change === 'replace-session' ? 'page1' : 'page2' } } });
      } else if (change === 'new-target') pipe.newTab('page2');
      else if (change === 'context-destroy') {
        pipe.emit('event', { method: 'Runtime.executionContextDestroyed', sessionId: 's-page1', params: { executionContextId: 1 } });
      } else {
        pipe.focused = [];
        pipe.emit('event', { method: 'Runtime.bindingCalled', sessionId: 's-page1',
          params: { name: '__boxAgentFocusChanged', payload: 'unfocused', executionContextId: 1 } });
      }
      expect(mocks.release).toHaveBeenCalledOnce();
    });

  it('操作間の対象変更による解放が終わるまで次のmouse_moveを開始しない', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    await browser.execute({ kind: 'left_mouse_down' });
    let complete!: () => void;
    const released = new Promise<void>((resolve) => { complete = resolve; });
    mocks.release.mockReturnValueOnce(released);
    pipe.newTab('page2');
    const move = browser.execute({ kind: 'mouse_move', x: 20, y: 30 });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mocks.release).toHaveBeenCalledOnce();
      expect(mocks.inputExecute).toHaveBeenCalledTimes(1); // downのみ。moveをまだXへ渡さない。
      expect(pipe.calls.some((call) => call.method === 'Target.activateTarget')).toBe(false);
    } finally { complete(); }
    expect((await move).text).toContain('新しいタブまたはウィンドウを前面');
    expect(mocks.inputExecute).toHaveBeenCalledTimes(2);
  });

  it('同じtargetのmove/wait/read_page/screenshotを挟んでも押下保持targetを追跡する', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    await browser.execute({ kind: 'left_mouse_down' });
    await browser.execute({ kind: 'mouse_move', x: 20, y: 30 });
    await browser.execute({ kind: 'wait', duration: 0 });
    await browser.execute({ kind: 'read_page' });
    await browser.execute({ kind: 'screenshot' });
    expect(mocks.release).not.toHaveBeenCalled();
    pipe.emit('event', { method: 'Target.targetDestroyed', params: { targetId: 'page1' } });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('left_mouse_up成功後は押下保持targetの追跡を終了する', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    await browser.execute({ kind: 'left_mouse_down' });
    await browser.execute({ kind: 'left_mouse_up' }); // XInput側がmouseup/解放を完了して返る契約。
    pipe.emit('event', { method: 'Target.targetDestroyed', params: { targetId: 'page1' } });
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('イベント欠落で別targetのfocusが見つかった場合もread_page時点で押下保持を解放する', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    await browser.execute({ kind: 'left_mouse_down' });
    pipe.targets.push('page2');
    pipe.focused = ['page2'];
    await browser.execute({ kind: 'read_page' });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('押下保持の10秒期限切れでも、解放完了まで次入力を待たせる', async () => {
    const browser = await start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let complete!: () => void;
    const released = new Promise<void>((resolve) => { complete = resolve; });
    try {
      await browser.execute({ kind: 'left_mouse_down' });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(mocks.release).not.toHaveBeenCalled();
      mocks.release.mockReturnValueOnce(released);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.release).toHaveBeenCalledOnce();
      const move = browser.execute({ kind: 'mouse_move', x: 20, y: 30 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mocks.inputExecute).toHaveBeenCalledTimes(1);
      complete();
      await move;
      expect(mocks.inputExecute).toHaveBeenCalledTimes(2);
      transports[0]!.emit('event', { method: 'Target.targetDestroyed', params: { targetId: 'page1' } });
      expect(mocks.release).toHaveBeenCalledOnce();
    } finally { complete(); vi.useRealTimers(); }
  });

  it.each(['destroy', 'detach', 'replace-session', 'new-target', 'attach-new-target'])('type待機中の%sで即座にabort/解放し、後続入力を止める', async (change) => {
    const browser = await start();
    const pipe = transports[0]!;
    const entered = pendingInput();
    const operation = browser.execute({ kind: 'type', text: 'テスト専用入力' });
    const signal = await entered;
    const rejected = expect(operation).rejects.toThrow('BROWSER_INPUT_TARGET_CHANGED');
    if (change === 'destroy') {
      pipe.targets = [];
      pipe.emit('event', { method: 'Target.targetDestroyed', params: { targetId: 'page1' } });
    } else if (change === 'detach') {
      pipe.targets = [];
      pipe.emit('event', { method: 'Target.detachedFromTarget', params: { sessionId: 's-page1' } });
    } else if (change === 'replace-session') {
      pipe.emit('event', { method: 'Target.attachedToTarget', params: {
        targetInfo: { type: 'page', targetId: 'page1' }, sessionId: 's-replacement',
      } });
    } else if (change === 'new-target') pipe.newTab('page2');
    else {
      pipe.targets.push('page2');
      pipe.emit('event', { method: 'Target.attachedToTarget', params: {
        targetInfo: { type: 'page', targetId: 'page2' }, sessionId: 's-page2',
      } });
    }
    expect(signal.aborted).toBe(true); // inputのPromiseが解決する前、イベント受信直後。
    expect(mocks.release).toHaveBeenCalled();
    await rejected;
    expect(mocks.inputExecute).toHaveBeenCalledOnce();
    if (change === 'new-target' || change === 'attach-new-target') {
      expect((await browser.execute({ kind: 'read_page' })).text).toContain('新しいタブまたはウィンドウを前面');
      expect(pipe.focused).toEqual(['page2']);
    }
  });

  it('対象外tabのdestroyでは入力を止めず、対象sessionのfocus bindingだけで中断する', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    const entered = pendingInput();
    const operation = browser.execute({ kind: 'type', text: 'テスト専用入力' });
    const signal = await entered;
    const rejected = expect(operation).rejects.toThrow('BROWSER_INPUT_TARGET_CHANGED');
    pipe.emit('event', { method: 'Target.targetDestroyed', params: { targetId: 'another' } });
    pipe.emit('event', { method: 'Runtime.bindingCalled', sessionId: 's-page1',
      params: { name: '__boxAgentFocusChanged', payload: 'unfocused', executionContextId: 999 } });
    expect(signal.aborted).toBe(false);
    pipe.emit('event', { method: 'Runtime.bindingCalled', sessionId: 's-page1',
      params: { name: '__boxAgentFocusChanged', payload: 'unfocused', executionContextId: 1 } });
    expect(signal.aborted).toBe(true);
    await rejected;
    expect(pipe.calls).toContainEqual({ method: 'Runtime.addBinding',
      params: { name: '__boxAgentFocusChanged', executionContextName: 'box-agent-focus' }, sessionId: 's-page1' });
    expect(pipe.calls.some((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument'
      && call.params.worldName === 'box-agent-focus' && call.params.runImmediately === true)).toBe(true);
  });

  it('入力中のisolated context破棄でも後続入力を止める', async () => {
    const browser = await start();
    const entered = pendingInput();
    const operation = browser.execute({ kind: 'hold_key', text: 'Control_L', duration: 10 });
    const signal = await entered;
    const rejected = expect(operation).rejects.toThrow('BROWSER_INPUT_TARGET_CHANGED');
    transports[0]!.emit('event', { method: 'Runtime.executionContextsCleared', sessionId: 's-page1', params: {} });
    expect(signal.aborted).toBe(true);
    await rejected;
  });

  it('mousedownで新タブを作った単発クリックは解放して前面化を通知し、再クリックしない', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    const entered = pendingInput();
    const operation = browser.execute({ kind: 'left_click', x: 20, y: 30 });
    const signal = await entered;
    pipe.newTab('page2');
    expect(signal.aborted).toBe(true);
    const result = await operation;
    expect(result.executed).toBe(true);
    expect(result.text).toContain('新しいタブまたはウィンドウを前面');
    expect(result.text).toContain('残りの入力は停止');
    expect(mocks.inputExecute).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalled();
    expect(pipe.focused).toEqual(['page2']);
  });

  it('JS dialogを通知し本文は漏らさず、次の操作は止めるがXスクショは撮れる', async () => {
    const browser = await start();
    const pipe = transports[0]!;
    pipe.navigate = () => pipe.emit('event', { method: 'Page.javascriptDialogOpening', sessionId: 's-page1',
      params: { type: 'alert', message: 'ダイアログ内の疑似秘密', url: 'http://shell/sensitive' } });
    const output = await browser.execute({ kind: 'open_url', url: 'http://shell:8000/dialog' });
    expect(output.text).toContain('JavaScript alert');
    expect(JSON.stringify(output)).not.toMatch(/疑似秘密|sensitive/);
    await expect(browser.execute({ kind: 'key', text: 'Return' })).rejects.toThrow('応答操作は未実装');
    expect(mocks.inputExecute).not.toHaveBeenCalled();
    expect((await browser.execute({ kind: 'screenshot' })).screenshot?.mimeType).toBe('image/png');
    expect(mocks.screenshot).toHaveBeenCalledOnce();
    expect(pipe.calls.some((call) => call.method === 'Page.handleJavaScriptDialog')).toBe(false);
    pipe.emit('event', { method: 'Page.javascriptDialogClosed', sessionId: 'unknown-session', params: {} });
    await expect(browser.execute({ kind: 'wait', duration: 0 })).rejects.toThrow('応答操作は未実装');
    pipe.emit('event', { method: 'Page.javascriptDialogClosed', sessionId: 's-page1', params: {} });
    await expect(browser.execute({ kind: 'wait', duration: 0 })).resolves.toEqual({ executed: true });
  });

  it.each(['detach-then-destroy', 'destroy-then-detach', 'snapshot-prune'])('DialogOpening後の%sで消えたsessionのdialogを残さない', async (order) => {
    const browser = await start();
    const pipe = transports[0]!;
    pipe.emit('event', { method: 'Page.javascriptDialogOpening', sessionId: 's-page1', params: { type: 'alert' } });
    pipe.targets = ['page2'];
    pipe.focused = ['page2'];
    const detach = () => pipe.emit('event', { method: 'Target.detachedFromTarget', params: { sessionId: 's-page1' } });
    const destroy = () => pipe.emit('event', { method: 'Target.targetDestroyed', params: { targetId: 'page1' } });
    if (order === 'detach-then-destroy') { detach(); destroy(); }
    if (order === 'destroy-then-detach') { destroy(); detach(); }
    const output = await browser.execute({ kind: 'read_page' });
    expect(output.page?.[0]?.name).toBe('試験ボタン');
    expect(output.text).not.toContain('JavaScript alert');
    expect(pipe.calls.some((call) => call.method === 'Page.handleJavaScriptDialog')).toBe(false);
  });

  it('親が保持するfdのflockはhelper終了後も別openを排他し、closeで解放する', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const processes = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const directory = await fs.mkdtemp('/tmp/opencode/box-agent-flock-');
    const first = await fs.open(`${directory}/profile.lock`, 'a', 0o600);
    const second = await fs.open(`${directory}/profile.lock`, 'a', 0o600);
    const lock = (fd: number) => new Promise<number | null>((resolve, reject) => {
      const child = processes.spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin' },
      });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    try {
      expect(await lock(first.fd)).toBe(0);
      expect(await lock(second.fd)).toBe(1);
      await first.close();
      expect(await lock(second.fd)).toBe(0);
    } finally {
      await first.close();
      await second.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
