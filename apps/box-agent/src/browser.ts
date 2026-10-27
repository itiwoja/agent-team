import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { open, readlink, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpError, CdpPipe, isRecord } from './cdp.ts';
import type { CdpEvent } from './cdp.ts';
import { browserChildEnvironment, XInput } from './input.ts';
import type { ActionOutput, BrowserAction, BrowserBackend, PageElement } from './protocol.ts';

const PROFILE = '/home/browser';
const PAGE_BYTES = 16 * 1024;
const SECRET_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp']);
const ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'spinbutton',
  'checkbox', 'radio', 'slider', 'switch', 'heading']);
const READ_PAGE_STYLES = ['display', 'visibility', 'opacity', 'overflow-x', 'overflow-y',
  'transform', 'clip-path', 'clip', 'contain', 'content-visibility', 'border-radius', 'mask-image', 'filter'];
const FOCUS_WORLD = 'box-agent-focus';
const FOCUS_BINDING = '__boxAgentFocusChanged';
// main worldやページ本文を読まない。iframeのblurは主frameの切替とは数えない。
const FOCUS_OBSERVER = `(() => {
  if (window.top !== window || globalThis.__boxAgentFocusObserver) return;
  globalThis.__boxAgentFocusObserver = true;
  const changed = () => {
    if (document.visibilityState !== 'visible' || !document.hasFocus())
      globalThis.${FOCUS_BINDING}('unfocused');
  };
  window.addEventListener('blur', changed);
  document.addEventListener('visibilitychange', changed);
})()`;
const SINGLE_CLICKS = new Set<BrowserAction['kind']>(['left_click', 'right_click', 'middle_click', 'left_mouse_down', 'left_mouse_up']);

export function chromiumArguments(proxyUrl: string, sandboxEnabled = true): string[] {
  if (proxyUrl !== '' && proxyUrl !== 'http://egress:3128') throw new Error('BROWSER_INVALID_PROXY');
  return [
    '--ozone-platform=x11', `--user-data-dir=${PROFILE}`, '--kiosk',
    '--window-size=1280,800', '--window-position=0,0', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--deny-permission-prompts',
    '--disk-cache-dir=/tmp/chromium-cache', '--disk-cache-size=536870912', '--lang=ja',
    '--remote-debugging-pipe',
    ...(proxyUrl ? ['--proxy-server=http://egress:3128', '--proxy-bypass-list=shell;<-loopback>'] : []),
    ...(sandboxEnabled ? [] : ['--no-sandbox']),
    'file:///opt/box-browser/test-page.html',
  ];
}

/** Chromium自身のsandbox起動診断だけ。policy/CDP/一般的なEPERMではfallbackしない。 */
export function isSandboxFailure(stderr: string): boolean {
  if (/remote debugging.*(?:disallowed|disabled)|DeveloperToolsAvailability/i.test(stderr)) return false;
  return stderr.split('\n').some((line) =>
    /^\[[\d:./]+:(?:ERROR|FATAL):[^\]]*(?:sandbox|zygote)[^\]]*\].*(?:No usable sandbox!|Running as root without --no-sandbox is not supported)/.test(line)
    || /^Failed to move to new namespace:.*(?:errno = Operation not permitted|errno = Permission denied)/.test(line));
}

function protocolError(): never { throw new Error('BROWSER_INVALID_CDP_DATA'); }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : protocolError(); }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : protocolError(); }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : protocolError(); }
function string(value: unknown): string { return typeof value === 'string' ? value : protocolError(); }
function axText(value: unknown): string | undefined {
  return isRecord(value) && typeof value.value === 'string' ? value.value : undefined;
}

interface DomElement {
  index: number;
  backendId: number;
  tag: string;
  attributes: Map<string, string>;
  center?: { x: number; y: number };
  value?: string;
  secret: boolean;
  box?: Box;
  client?: Box;
  style?: string[];
}

interface Box { left: number; top: number; right: number; bottom: number }
function box(value: unknown): Box {
  const rect = list(value).map(number);
  if (rect.length !== 4) protocolError();
  const [x = 0, y = 0, width = 0, height = 0] = rect;
  return { left: x, top: y, right: x + width, bottom: y + height };
}

/** CDPの生のAX値は返さない。DOM属性を確認できた主frameの可視要素だけを採用する。 */
export function buildReadPageOutput(ax: unknown, snapshot: unknown, notice = ''): ActionOutput {
  const axNodes = list(record(ax).nodes);
  const snap = record(snapshot);
  const strings = list(snap.strings).map(string);
  const at = (index: unknown): string => {
    // Chromium 156 InspectorDOMSnapshotAgent::AddString: 空文字の表現は-1。
    if (index === -1) return '';
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || strings[index] === undefined) protocolError();
    return strings[index];
  };
  const doc = record(list(snap.documents)[0]);
  const nodes = record(doc.nodes);
  const layout = record(doc.layout);
  const backendIds = list(nodes.backendNodeId);
  const nodeNames = list(nodes.nodeName);
  const nodeTypes = list(nodes.nodeType);
  const attributes = list(nodes.attributes);
  const parents = list(nodes.parentIndex);
  const layoutNodes = list(layout.nodeIndex);
  const bounds = list(layout.bounds);
  const styles = list(layout.styles);
  const clients = list(layout.clientRects);
  const scrollX = number(doc.scrollOffsetX);
  const scrollY = number(doc.scrollOffsetY);
  const elements = new Map<number, DomElement>();
  const byIndex = new Map<number, DomElement>();

  for (let i = 0; i < backendIds.length; i++) {
    if (nodeTypes[i] !== 1) continue;
    const rawAttributes = attributes[i];
    // 不完全な属性なら秘密でないとは判定できない。名前も値も採用しない。
    if (!Array.isArray(rawAttributes) || rawAttributes.length % 2 !== 0) continue;
    const attrs = new Map<string, string>();
    for (let j = 0; j < rawAttributes.length; j += 2) attrs.set(at(rawAttributes[j]).toLowerCase(), at(rawAttributes[j + 1]));
    const tag = at(nodeNames[i]).toLowerCase();
    const secret = (tag === 'input' && attrs.get('type')?.toLowerCase() === 'password')
      || (attrs.get('autocomplete') ?? '').toLowerCase().split(/\s+/).some((token) => SECRET_AUTOCOMPLETE.has(token));
    const element: DomElement = { index: i, backendId: number(backendIds[i]), tag, attributes: attrs, secret };
    elements.set(element.backendId, element);
    byIndex.set(i, element);
  }
  // VisitNodeはinputをinputValue、textareaをtextValueのRareStringDataに格納する。
  for (const [field, tag] of [['inputValue', 'input'], ['textValue', 'textarea']] as const) {
    if (nodes[field] === undefined) continue;
    const values = record(nodes[field]);
    const indices = list(values.index);
    const valueIndices = list(values.value);
    if (indices.length !== valueIndices.length) protocolError();
    for (let i = 0; i < indices.length; i++) {
      const element = byIndex.get(number(indices[i]));
      if (element?.tag === tag) element.value = at(valueIndices[i]);
    }
  }
  for (let i = 0; i < layoutNodes.length; i++) {
    const index = number(layoutNodes[i]);
    // Documentには[]、Textには親のstylesが来る。Element以外を同じschemaで検査しない。
    const element = byIndex.get(index);
    if (!element) continue;
    const computed = list(styles[i]).map(at);
    if (computed.length !== 0 && computed.length !== READ_PAGE_STYLES.length) protocolError();
    element.style = computed;
    element.box = box(bounds[i]);
    // clientRectsはdocument座標ではなく[clientLeft, clientTop, clientWidth, clientHeight]。
    const client = clients[i];
    if (Array.isArray(client) && client.length === 4) element.client = box(client);
  }
  // AXのprotectedも防御的に扱う。秘密の子孫・labelledby等の反映も伏せる。
  for (const raw of axNodes) {
    const node = record(raw);
    const element = typeof node.backendDOMNodeId === 'number' ? elements.get(node.backendDOMNodeId) : undefined;
    if (element && Array.isArray(node.properties) && node.properties.some((property: unknown) =>
      isRecord(property) && property.name === 'protected' && isRecord(property.value) && property.value.value === true)) element.secret = true;
  }
  for (const element of elements.values()) {
    const ancestry = [element];
    let parent = parents[element.index];
    const visited = new Set<number>([element.index]);
    while (typeof parent === 'number' && parent >= 0) {
      if (visited.has(parent) || visited.size > 1024) protocolError();
      visited.add(parent);
      const ancestor = byIndex.get(parent);
      if (ancestor) ancestry.push(ancestor);
      else if (nodeTypes[parent] === 1) element.style = undefined; // 属性未確認の祖先を通さない。
      if (ancestor?.secret) element.secret = true;
      parent = parents[parent];
    }
    const bounds = element.box;
    if (!bounds || element.style?.[1] !== 'visible') continue;
    let left = Math.max(scrollX, bounds.left);
    let top = Math.max(scrollY, bounds.top);
    let right = Math.min(scrollX + 1280, bounds.right);
    let bottom = Math.min(scrollY + 800, bounds.bottom);
    let verified = true;
    for (const ancestor of ancestry) {
      const style = ancestor.style;
      // visibilityは子がvisibleへ上書きできる。opacity/displayだけを祖先まで検査する。
      // 変形・非矩形clip/mask/filterはsnapshotの矩形だけでは保証できないので採用しない。
      if (!style || style.length !== READ_PAGE_STYLES.length || style.some((value) => value === '')
        || style[0] === 'none' || !Number.isFinite(Number(style[2])) || Number(style[2]) <= 0
        || style[5] !== 'none' || style[6] !== 'none' || style[7] !== 'auto'
        || style[9] === 'hidden' || style[11] !== 'none' || style[12] !== 'none') {
        verified = false; break;
      }
      if (ancestor === element) continue;
      const clipValues = ['hidden', 'clip', 'scroll', 'auto'];
      if (![style[3], style[4]].every((value) => value === 'visible' || clipValues.includes(value ?? ''))) {
        verified = false; break;
      }
      const paintClip = /(?:^|\s)(paint|strict|content)(?:\s|$)/.test(style[8] ?? '');
      const clipX = paintClip || clipValues.includes(style[3] ?? '');
      const clipY = paintClip || clipValues.includes(style[4] ?? '');
      if (!clipX && !clipY) continue;
      const outer = ancestor.box;
      const client = ancestor.client;
      if (!outer || !client || !/^0(?:px|%)?(?:\s+0(?:px|%)?)*(?:\s*\/\s*0(?:px|%)?(?:\s+0(?:px|%)?)*)?$/.test(style[10] ?? '')) {
        verified = false; break;
      }
      // rootのoverflowはviewportへ伝播する。document座標のroot boundsで再clipしない。
      if (ancestor.tag === 'html') continue;
      if (clipX) { left = Math.max(left, outer.left + client.left); right = Math.min(right, outer.left + client.right); }
      if (clipY) { top = Math.max(top, outer.top + client.top); bottom = Math.min(bottom, outer.top + client.bottom); }
    }
    if (verified && right > left && bottom > top) {
      const x = Math.floor((left + right) / 2 - scrollX);
      const y = Math.floor((top + bottom) / 2 - scrollY);
      if (x + scrollX >= left && y + scrollY >= top) element.center = { x, y };
    }
  }
  const secrets = new Set<string>();
  for (const element of elements.values()) if (element.secret && element.value) secrets.add(element.value);
  for (const raw of axNodes) {
    const node = record(raw);
    const element = typeof node.backendDOMNodeId === 'number' ? elements.get(node.backendDOMNodeId) : undefined;
    const role = axText(node.role);
    if (element?.secret || (!element && role !== undefined && ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role))) {
      for (const text of [axText(node.name), axText(node.value)]) if (text) secrets.add(text);
    }
  }
  const secretValues = [...secrets];
  const containsSecret = (value: string): boolean => secretValues.some((secret) => value.includes(secret));
  const page: PageElement[] = [];
  const result: ActionOutput = { executed: true, text: `${notice}表示要素（最大200件）。`, page };
  if (Buffer.byteLength(JSON.stringify(result)) > PAGE_BYTES) throw new Error('READ_PAGE_LIMIT');
  for (const raw of axNodes) {
    if (page.length >= 200) break;
    const node = record(raw);
    if (node.ignored !== false) continue;
    const role = axText(node.role);
    if (!role || !ROLES.has(role) || typeof node.backendDOMNodeId !== 'number') continue;
    const element = elements.get(node.backendDOMNodeId);
    if (!element?.center) continue;
    const rawName = axText(node.name) ?? '';
    const name = element.secret || containsSecret(rawName) ? '[非表示]' : [...rawName].slice(0, 512).join('');
    const item: PageElement = { role, name, center: element.center };
    // AX.valueは決して使わない。属性を確認したinput/textareaのDOM値のみ。
    if (!element.secret && ['input', 'textarea'].includes(element.tag) && element.value !== undefined && !containsSecret(element.value)) {
      item.value = [...element.value].slice(0, 1024).join('');
    }
    page.push(item);
    if (Buffer.byteLength(JSON.stringify(result)) > PAGE_BYTES) { page.pop(); break; }
  }
  return result;
}

interface PageSession { id: string; generation: number; initialized: Promise<void>; focusContext?: number }
interface InputLease {
  targetId: string;
  sessionId: string;
  generation: number;
  interrupted: boolean;
  released?: Promise<void>;
}
type MouseTarget = Pick<InputLease, 'targetId' | 'sessionId' | 'generation'>;
// XInputと同じ10秒上限だが入力開始時に計時する（XInputは押下成功後）。
// 境界側を先に失効させて解放完了を追跡し、XInputの自動解放と次操作の競合を防ぐ。
const MOUSE_HOLD_MS = 10_000;
const PRESERVE_MOUSE = new Set<BrowserAction['kind']>(['mouse_move', 'cursor_position', 'wait']);
interface Attempt {
  child: ChildProcess;
  cdp: CdpPipe;
  exited: Promise<void>;
  ended: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  terminationRequested: boolean;
  stderr: string;
}

export interface ChromiumBrowserOptions {
  proxyUrl?: string;
  commandTimeoutMs?: number;
}

/** mainはstart()をawaitし、failureイベントでコンテナ全体を停止し、終了時にstop()をawaitする。 */
export class ChromiumBrowser extends EventEmitter<{ failure: [Error] }> implements BrowserBackend {
  sandboxEnabled = true;
  readonly #options: ChromiumBrowserOptions;
  readonly #input = new XInput();
  readonly #sessions = new Map<string, PageSession>();
  readonly #created = new Set<string>();
  readonly #dialogs = new Map<string, string>();
  #lease: FileHandle | undefined;
  #attempt: Attempt | undefined;
  #ready = false;
  #started = false;
  #stopping = false;
  #busy = false;
  #setupError: Error | undefined;
  #actionAbort: AbortController | undefined;
  #activeInput: InputLease | undefined;
  #heldMouse: MouseTarget | undefined;
  #mouseTimer: ReturnType<typeof setTimeout> | undefined;
  #inputRelease: Promise<void> | undefined;
  #frontGeneration = 0;
  #targetGeneration = 0;
  #sessionGeneration = 0;
  #stopPromise: Promise<void> | undefined;

  constructor(options: ChromiumBrowserOptions = {}) {
    super();
    this.#options = options;
    this.#input.on('failure', (error) => this.#fail(error));
  }
  get #dialog(): string | undefined { return this.#dialogs.values().next().value; }
  ready(): boolean { return this.#ready && !this.#attempt?.cdp.closed; }

  async start(): Promise<void> {
    if (this.#started || this.#stopping) throw new Error('BROWSER_ALREADY_STARTED');
    this.#started = true;
    const proxy = this.#options.proxyUrl ?? process.env.BROWSER_PROXY_URL ?? '';
    chromiumArguments(proxy); // 無効な設定ではロックにも触らない。
    try {
      await this.#acquireProfile();
      for (const sandboxEnabled of [true, false]) {
        if (this.#stopping) throw new Error('BROWSER_START_CANCELLED');
        this.sandboxEnabled = sandboxEnabled;
        this.#sessions.clear();
        this.#created.clear();
        this.#dialogs.clear();
        this.#setupError = undefined;
        await this.#clearSingletons();
        if (this.#stopping) throw new Error('BROWSER_START_CANCELLED');
        const attempt = this.#spawn(proxy);
        this.#attempt = attempt;
        try {
          await attempt.cdp.command('Browser.getVersion');
          await attempt.cdp.command('Target.setDiscoverTargets', { discover: true });
          await attempt.cdp.command('Target.setAutoAttach', {
            autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
            filter: [{ type: 'page', exclude: false }, { exclude: true }],
          });
          const pages = await this.#pageTargets();
          if (pages.length === 0) throw new Error('BROWSER_NO_PAGE');
          if (this.#setupError) throw this.#setupError;
          if (attempt.cdp.closed || attempt.ended || this.#stopping) throw new Error('BROWSER_START_FAILED');
          this.#created.clear();
          attempt.stderr = '';
          this.#ready = true;
          return;
        } catch (error) {
          // パイプendはexitより先に来ることがある。自然終了を短く待ち、手動killとは区別する。
          if (error instanceof CdpError && ['CDP_DISCONNECTED', 'CDP_CHILD_EXIT'].includes(error.code)) {
            await Promise.race([attempt.exited, delay(250, undefined, { ref: false })]);
          }
          // LOG(FATAL)はImmediateCrashによりSIGTRAP/SIGILL等（code=null）でも終わる。
          // 外部のTERM/KILLや自身のstopによる終了はsandbox診断があっても除外する。
          const fatalExit = (attempt.exitCode !== null && attempt.exitCode !== 0)
            || (attempt.exitCode === null && attempt.exitSignal !== null
              && ['SIGTRAP', 'SIGILL', 'SIGABRT', 'SIGBUS'].includes(attempt.exitSignal));
          const retry = sandboxEnabled && !this.#ready && !this.#stopping && !attempt.terminationRequested
            && attempt.ended && fatalExit
            && error instanceof CdpError && ['CDP_DISCONNECTED', 'CDP_CHILD_EXIT'].includes(error.code)
            && isSandboxFailure(attempt.stderr);
          await this.#terminate(attempt);
          if (!retry) throw new Error('BROWSER_START_FAILED');
        }
      }
      throw new Error('BROWSER_START_FAILED');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async #acquireProfile(): Promise<void> {
    // flockは同じvolume上の別process/containerにも効く。open file descriptionを親で保持する。
    const lease = await open(`${PROFILE}/.box-agent.lock`, 'a', 0o600);
    if (this.#stopping) {
      await lease.close();
      throw new Error('BROWSER_START_CANCELLED');
    }
    this.#lease = lease;
    const fd = this.#lease.fd;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        env: browserChildEnvironment(), stdio: ['ignore', 'ignore', 'ignore', fd],
      });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('BROWSER_PROFILE_LOCK_FAILED')); }, 2000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('BROWSER_PROFILE_LOCK_FAILED')); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(); else reject(new Error('BROWSER_PROFILE_IN_USE'));
      });
    });
  }

  async #clearSingletons(): Promise<void> {
    try {
      const target = await readlink(`${PROFILE}/SingletonLock`);
      const prefix = `${hostname()}-`;
      if (target.startsWith(prefix) && /^\d+$/.test(target.slice(prefix.length))) {
        const pid = Number(target.slice(prefix.length));
        if (Number.isSafeInteger(pid) && pid > 0) {
          let alive = true;
          try { process.kill(pid, 0); }
          catch (error) { if (isRecord(error) && error.code === 'ESRCH') alive = false; }
          if (alive) throw new Error('BROWSER_PROFILE_IN_USE');
        }
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { await unlink(`${PROFILE}/${name}`); }
      catch (error) { if (!isRecord(error) || error.code !== 'ENOENT') throw error; }
    }
  }

  #spawn(proxy: string): Attempt {
    const child = spawn('/usr/lib/chromium/chromium', chromiumArguments(proxy, this.sandboxEnabled), {
      env: browserChildEnvironment(), stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true,
    });
    const cdp = CdpPipe.fromChild(child, { timeoutMs: this.#options.commandTimeoutMs ?? 10_000 });
    let exited!: () => void;
    const attempt: Attempt = { child, cdp, ended: false, exitCode: null, exitSignal: null, terminationRequested: false, stderr: '',
      exited: new Promise<void>((resolve) => { exited = resolve; }) };
    child.stderr?.on('data', (chunk: unknown) => {
      if (!this.#ready && Buffer.isBuffer(chunk)) attempt.stderr = (attempt.stderr + chunk.toString('utf8')).slice(-64 * 1024);
    });
    child.once('exit', (code, signal) => {
      attempt.ended = true;
      attempt.exitCode = code;
      attempt.exitSignal = signal;
      exited();
      if (this.#ready && this.#attempt === attempt) this.#fail(new Error('BROWSER_CHILD_EXIT'));
    });
    child.once('error', () => {
      attempt.ended = true;
      exited();
      if (this.#ready && this.#attempt === attempt) this.#fail(new Error('BROWSER_CHILD_ERROR'));
    });
    cdp.on('event', (event) => { if (this.#attempt === attempt) this.#event(event); });
    cdp.on('disconnect', () => {
      if (this.#ready && this.#attempt === attempt) this.#fail(new Error('BROWSER_CDP_DISCONNECTED'));
    });
    return attempt;
  }

  #fail(error: Error): void {
    if (!this.#ready || this.#stopping) return;
    this.#ready = false;
    this.#actionAbort?.abort();
    void this.#releaseInput().catch(() => {});
    this.emit('failure', error);
  }

  #event(event: CdpEvent): void {
    const params = event.params;
    if (event.method === 'Target.attachedToTarget' && isRecord(params.targetInfo)
      && params.targetInfo.type === 'page' && typeof params.targetInfo.targetId === 'string' && typeof params.sessionId === 'string') {
      if (this.#ready && !this.#sessions.has(params.targetInfo.targetId)) {
        this.#created.add(params.targetInfo.targetId);
        this.#frontGeneration++;
        this.#targetGeneration++;
        this.#interruptInput();
      }
      this.#addSession(params.targetInfo.targetId, params.sessionId);
    } else if (event.method === 'Target.targetCreated' && isRecord(params.targetInfo)
      && params.targetInfo.type === 'page' && typeof params.targetInfo.targetId === 'string' && this.#ready) {
      this.#created.add(params.targetInfo.targetId);
      this.#frontGeneration++;
      this.#targetGeneration++;
      if (this.#activeInput?.targetId !== params.targetInfo.targetId) this.#interruptInput();
    } else if (event.method === 'Target.targetDestroyed' && typeof params.targetId === 'string') {
      this.#removeSession(params.targetId);
    } else if (event.method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') {
      this.#dialogs.delete(params.sessionId);
      for (const [id, session] of this.#sessions) if (session.id === params.sessionId) this.#removeSession(id);
    } else if (event.method === 'Runtime.bindingCalled' && event.sessionId) {
      const session = [...this.#sessions.values()].find((session) => session.id === event.sessionId);
      if (params.name === FOCUS_BINDING && params.payload === 'unfocused' && session?.focusContext !== undefined
        && params.executionContextId === session.focusContext) this.#focusChanged(session.id);
    } else if (['Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared'].includes(event.method) && event.sessionId) {
      const session = [...this.#sessions.values()].find((session) => session.id === event.sessionId);
      if (session && (event.method === 'Runtime.executionContextsCleared' || params.executionContextId === session.focusContext)) {
        session.focusContext = undefined;
        this.#focusChanged(session.id);
      }
    } else if (event.method === 'Page.javascriptDialogOpening'
      && [...this.#sessions.values()].some((session) => session.id === event.sessionId)) {
      if (event.sessionId) this.#dialogs.set(event.sessionId,
        ['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(params.type)) ? String(params.type) : 'dialog');
      this.#actionAbort?.abort();
      void this.#releaseInput().catch(() => {});
    } else if (event.method === 'Page.javascriptDialogClosed' && event.sessionId) {
      this.#dialogs.delete(event.sessionId);
    }
  }

  #removeSession(targetId: string): void {
    const session = this.#sessions.get(targetId);
    if (session || this.#created.has(targetId)) {
      this.#frontGeneration++;
      this.#targetGeneration++;
    }
    if (session) this.#dialogs.delete(session.id);
    if (this.#activeInput?.targetId === targetId || this.#heldMouse?.targetId === targetId) this.#interruptInput();
    this.#sessions.delete(targetId);
    this.#created.delete(targetId);
  }

  #focusChanged(sessionId: string): void {
    // 操作leaseの設定前でも、進行中の前面確認結果を失効させる。
    this.#frontGeneration++;
    if (this.#activeInput?.sessionId === sessionId || this.#heldMouse?.sessionId === sessionId) this.#interruptInput();
  }

  #forgetMouse(): void {
    clearTimeout(this.#mouseTimer);
    this.#mouseTimer = undefined;
    this.#heldMouse = undefined;
  }

  #holdMouse(target: MouseTarget): void {
    this.#forgetMouse();
    this.#heldMouse = target;
    this.#mouseTimer = setTimeout(() => { void this.#releaseInput().catch(() => {}); }, MOUSE_HOLD_MS);
    this.#mouseTimer.unref();
  }

  #releaseInput(): Promise<void> {
    this.#forgetMouse();
    if (this.#inputRelease) return this.#inputRelease;
    const released = this.#input.releaseAll().catch(() => {
      this.#fail(new Error('INPUT_RELEASE_FAILED'));
      throw new Error('INPUT_RELEASE_FAILED');
    });
    this.#inputRelease = released;
    void released.then(() => {
      if (this.#inputRelease === released) this.#inputRelease = undefined;
    }, () => {}); // 失敗時はreadyを落とし、未処理rejectionにしない。
    return released;
  }

  #interruptInput(): void {
    const lease = this.#activeInput;
    if (!this.#heldMouse && (!lease || lease.interrupted)) return;
    if (lease) {
      lease.interrupted = true;
      this.#actionAbort?.abort();
    }
    const released = this.#releaseInput();
    if (lease) lease.released = released;
  }

  #cdp(): CdpPipe {
    if (!this.#attempt || this.#attempt.cdp.closed) throw new Error('BROWSER_NOT_READY');
    return this.#attempt.cdp;
  }

  #addSession(targetId: string, id: string): PageSession {
    const existing = this.#sessions.get(targetId);
    if (existing?.id === id) return existing;
    if (existing) this.#removeSession(targetId);
    const cdp = this.#cdp();
    const initialized = (async () => {
      // 再開直後のdialogより前に全domainと監視を登録する。応答にはrendererの
      // 再開が必要なので、固定順で全要求を送り、最後に再開してからまとめて待つ。
      // initialized完了前にはX入力を開始しない。
      await Promise.all([
        cdp.command('Page.enable', {}, id),
        cdp.command('Accessibility.enable', {}, id),
        cdp.command('Runtime.enable', {}, id),
        cdp.command('Runtime.addBinding', { name: FOCUS_BINDING, executionContextName: FOCUS_WORLD }, id),
        cdp.command('Page.addScriptToEvaluateOnNewDocument', {
          source: FOCUS_OBSERVER, worldName: FOCUS_WORLD, runImmediately: true,
        }, id),
        cdp.command('Runtime.runIfWaitingForDebugger', {}, id),
      ]);
    })();
    const session: PageSession = { id, generation: ++this.#sessionGeneration, initialized };
    this.#sessions.set(targetId, session);
    void initialized.catch(() => {
      if (this.#attempt?.cdp !== cdp || this.#sessions.get(targetId) !== session) return;
      this.#setupError = new Error('BROWSER_TARGET_SETUP_FAILED');
      this.#fail(this.#setupError);
    });
    return session;
  }

  async #pageTargets(): Promise<string[]> {
    const result = await this.#cdp().command('Target.getTargets');
    const targets = list(result.targetInfos).map(record).filter((info) => info.type === 'page' && info.subtype === undefined);
    const ids = targets.map((info) => string(info.targetId));
    if (ids.length > 32 || new Set(ids).size !== ids.length) throw new Error('BROWSER_TARGET_LIMIT');
    for (const id of ids) {
      let session = this.#sessions.get(id);
      if (!session) {
        const attached = await this.#cdp().command('Target.attachToTarget', { targetId: id, flatten: true });
        session = this.#addSession(id, string(attached.sessionId));
      }
      await session.initialized;
    }
    for (const id of this.#sessions.keys()) if (!ids.includes(id)) this.#removeSession(id);
    return ids;
  }

  async #frontTarget(): Promise<{ targetId: string; session: string; generation: number; frontGeneration: number; notice: string }> {
    let frontGeneration = this.#frontGeneration;
    const targetGeneration = this.#targetGeneration;
    const ids = await this.#pageTargets();
    if (frontGeneration !== this.#frontGeneration) throw new Error('BROWSER_INPUT_TARGET_CHANGED');
    if (this.#dialog) throw new Error(this.#dialogNotice());
    const created = ids.filter((id) => this.#created.has(id));
    if (created.length > 1) throw new Error('BROWSER_AMBIGUOUS_NEW_TABS');
    let notice = '';
    if (created[0]) {
      const session = this.#sessions.get(created[0]);
      if (!session) throw new Error('BROWSER_TARGET_LOST');
      // popup windowにもX rootと同じ座標系を使う。任意サイズのまま入力しない。
      const window = await this.#cdp().command('Browser.getWindowForTarget', { targetId: created[0] });
      if (record(window.bounds).windowState !== 'fullscreen') {
        await this.#cdp().command('Browser.setWindowBounds', { windowId: number(window.windowId), bounds: { windowState: 'fullscreen' } });
      }
      await this.#cdp().command('Target.activateTarget', { targetId: created[0] });
      await this.#cdp().command('Page.bringToFront', {}, session.id);
      if (targetGeneration !== this.#targetGeneration) throw new Error('BROWSER_INPUT_TARGET_CHANGED');
      // 意図した前面化に伴う旧tabのblurは許容し、全tabのfocusをここから取り直す。
      // activation中の追加/破棄は上のtarget世代で除外する。
      frontGeneration = this.#frontGeneration;
      notice = '新しいタブまたはウィンドウを前面にしました。';
    }
    const front: Array<{ targetId: string; session: PageSession }> = [];
    for (const id of ids) {
      if (this.#dialog) throw new Error(this.#dialogNotice());
      const session = this.#sessions.get(id);
      if (!session) throw new Error('BROWSER_TARGET_LOST');
      const tree = await this.#cdp().command('Page.getFrameTree', {}, session.id);
      const frameId = string(record(record(tree.frameTree).frame).id);
      const world = await this.#cdp().command('Page.createIsolatedWorld', { frameId, worldName: FOCUS_WORLD }, session.id);
      session.focusContext = number(world.executionContextId);
      const focus = await this.#cdp().command('Runtime.evaluate', {
        expression: '({ focused: document.visibilityState === "visible" && document.hasFocus(), width: innerWidth, height: innerHeight, scale: visualViewport.scale, ratio: devicePixelRatio })',
        contextId: number(world.executionContextId), returnByValue: true, timeout: 1000,
      }, session.id);
      if (focus.exceptionDetails !== undefined) throw new Error('BROWSER_FOCUS_UNKNOWN');
      const value = record(record(focus.result).value);
      if (typeof value.focused !== 'boolean') throw new Error('BROWSER_FOCUS_UNKNOWN');
      if (value.focused) {
        if (value.width !== 1280 || value.height !== 800 || value.scale !== 1 || value.ratio !== 1) throw new Error('BROWSER_VIEWPORT_UNSUPPORTED');
        front.push({ targetId: id, session });
      }
    }
    if (frontGeneration !== this.#frontGeneration) throw new Error('BROWSER_INPUT_TARGET_CHANGED');
    if (front.length !== 1 || !front[0]) throw new Error('BROWSER_AMBIGUOUS_FRONT_TAB');
    for (const id of created) this.#created.delete(id);
    const selected = front[0];
    if (this.#sessions.get(selected.targetId) !== selected.session) throw new Error('BROWSER_TARGET_LOST');
    // focusイベントが欠落しても、read_page等で検出した切替を押下保持へ反映する。
    const held = this.#heldMouse;
    if (held && (held.sessionId !== selected.session.id || held.generation !== selected.session.generation)) await this.#releaseInput();
    if (frontGeneration !== this.#frontGeneration) throw new Error('BROWSER_INPUT_TARGET_CHANGED');
    return { targetId: selected.targetId, session: selected.session.id, generation: selected.session.generation, frontGeneration, notice };
  }

  #dialogNotice(): string { return `JavaScript ${this.#dialog ?? 'dialog'} を検出しました。応答操作は未実装のため操作を停止します。`; }

  async execute(action: BrowserAction): Promise<ActionOutput> {
    if (!this.ready()) throw new Error('BROWSER_NOT_READY');
    if (this.#busy) throw new Error('BROWSER_BUSY');
    this.#busy = true;
    this.#actionAbort = new AbortController();
    let began = false;
    let notice = '';
    let lease: InputLease | undefined;
    try {
      await this.#inputRelease;
      if (this.#dialog && action.kind !== 'screenshot') {
        // detach/destroyイベント欠落時も、消えたsessionのdialogで永久停止しない。
        await this.#pageTargets();
        if (this.#dialog) throw new Error(this.#dialogNotice());
      }
      if (action.kind === 'screenshot') {
        return { executed: true, screenshot: { mimeType: 'image/png', data: (await this.screenshot()).toString('base64') },
          ...(this.#dialog ? { text: this.#dialogNotice() } : {}) };
      }
      const front = await this.#frontTarget();
      notice = front.notice;
      if (this.#dialog) throw new Error(this.#dialogNotice());
      let output: ActionOutput;
      if (action.kind === 'read_page') {
        const ax = await this.#cdp().command('Accessibility.getFullAXTree', {}, front.session);
        const snapshot = await this.#cdp().command('DOMSnapshot.captureSnapshot', {
          computedStyles: READ_PAGE_STYLES, includeDOMRects: true,
        }, front.session);
        if (this.#dialog) throw new Error(this.#dialogNotice());
        const after = await this.#frontTarget();
        notice += after.notice;
        if (after.session !== front.session) return { executed: true, text: `${notice}前面のページが変わったため、read_pageをやり直してください。`, page: [] };
        return buildReadPageOutput(ax, snapshot, notice);
      }
      if (front.frontGeneration !== this.#frontGeneration || this.#actionAbort.signal.aborted || !this.ready()) {
        throw new Error('BROWSER_INPUT_TARGET_CHANGED');
      }
      began = true;
      if (action.kind === 'open_url') {
        let url: URL;
        try { url = new URL(action.url); } catch { throw new Error('BROWSER_INVALID_URL'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('BROWSER_INVALID_URL');
        const navigation = await this.#cdp().command('Page.navigate', { url: url.href }, front.session);
        if (navigation.errorText !== undefined) throw new Error('BROWSER_NAVIGATION_FAILED');
        output = { executed: true };
      } else {
        await this.#inputRelease;
        // #frontTargetのreturnとこの継続の間に配送されたイベントも検査する。
        if (front.frontGeneration !== this.#frontGeneration || this.#actionAbort.signal.aborted || !this.ready()) {
          throw new Error('BROWSER_INPUT_TARGET_CHANGED');
        }
        lease = { targetId: front.targetId, sessionId: front.session, generation: front.generation, interrupted: false };
        this.#activeInput = lease;
        if (action.kind === 'left_mouse_down') this.#holdMouse(lease);
        // CDPにはOSの原子的なfocusロックはない。targetイベントとisolated worldの
        // blur/visibility/context破棄を受信した時点で進行中のX入力をabortする。
        // イベント配送前にOSへ渡った入力まで取り消せる保証ではない。
        output = await this.#input.execute(action, this.#actionAbort.signal);
        if (lease.interrupted) throw new Error('BROWSER_INPUT_TARGET_CHANGED');
        if (action.kind !== 'left_mouse_down' && !PRESERVE_MOUSE.has(action.kind)) this.#forgetMouse();
      }
      if (this.#dialog) return { executed: true, text: notice + this.#dialogNotice() };
      // Page.navigateの成功は遷移開始の受理。旧documentが破棄される最中に
      // focusを再取得して成功を500へ変えない。新ページの準備はread_pageで確認する。
      if (action.kind === 'open_url' && this.#created.size === 0) return notice ? { ...output, text: notice } : output;
      const after = await this.#frontTarget();
      notice += after.notice;
      if (lease && (after.session !== lease.sessionId || after.generation !== lease.generation || lease.interrupted)
        && !SINGLE_CLICKS.has(action.kind)) throw new Error('BROWSER_INPUT_TARGET_CHANGED');
      return notice ? { ...output, text: notice } : output;
    } catch (error) {
      if (began && this.#dialog) return { executed: true, text: notice + this.#dialogNotice() };
      try { await (lease?.released ?? this.#releaseInput()); }
      catch { this.#fail(new Error('INPUT_RELEASE_FAILED')); throw new Error('INPUT_RELEASE_FAILED'); }
      if (lease?.interrupted) {
        // mousedownで新タブを作った単発クリックは再実行せず、解放後に前面化して通知。
        // type/drag/複数クリックは部分実行なので失敗させる。次のread_pageで前面を再確認する。
        if (SINGLE_CLICKS.has(action.kind) && this.#created.size === 1 && this.ready() && !this.#stopping) {
          try {
            const after = await this.#frontTarget();
            return { executed: true, text: `${notice}${after.notice}入力先の変化を検出したため、残りの入力は停止しました。` };
          } catch (error) {
            // 新tabの初期化中にdialogが開く場合も、実行済みクリックの結果として通知する。
            if (this.#dialog) return { executed: true, text: notice + this.#dialogNotice() };
            throw error;
          }
        }
        throw new Error('BROWSER_INPUT_TARGET_CHANGED');
      }
      throw error;
    } finally {
      try { await lease?.released; }
      finally {
        this.#activeInput = undefined;
        this.#actionAbort = undefined;
        this.#busy = false;
      }
    }
  }

  async screenshot(): Promise<Buffer> {
    if (!this.ready()) throw new Error('BROWSER_NOT_READY');
    return this.#input.screenshot();
  }

  async #terminate(attempt: Attempt): Promise<void> {
    attempt.terminationRequested = true;
    attempt.cdp.close();
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (attempt.child.pid) {
        try { process.kill(-attempt.child.pid, signal); return; } catch { /* 起動失敗ではgroupがない。 */ }
      }
      attempt.child.kill(signal);
    };
    signalGroup('SIGTERM');
    if (!attempt.ended) await Promise.race([attempt.exited, delay(2000, undefined, { ref: false })]);
    // 親が先に終了していてもChromiumの孫を残さない。
    signalGroup('SIGKILL');
    if (!attempt.ended) await Promise.race([attempt.exited, delay(2000, undefined, { ref: false })]);
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopping = true;
    this.#ready = false;
    this.#actionAbort?.abort();
    try { await this.#releaseInput(); }
    finally {
      if (this.#attempt) await this.#terminate(this.#attempt);
      await this.#lease?.close();
      this.#lease = undefined;
    }
  }
}

export async function startBrowser(options: ChromiumBrowserOptions = {}): Promise<ChromiumBrowser> {
  const browser = new ChromiumBrowser(options);
  await browser.start();
  return browser;
}
