import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipe } from './cdp.ts';

const pipes: CdpPipe[] = [];
function setup(options: ConstructorParameters<typeof CdpPipe>[3] = {}) {
  const writer = new PassThrough();
  const reader = new PassThrough();
  const child = new ChildProcess();
  const sent: Buffer[] = [];
  writer.on('data', (chunk: Buffer) => sent.push(chunk));
  const pipe = new CdpPipe(writer, reader, child, options);
  pipes.push(pipe);
  const receive = (message: unknown) => reader.write(Buffer.from(`${JSON.stringify(message)}\0`));
  return { pipe, writer, reader, child, sent, receive };
}

afterEach(() => { for (const pipe of pipes.splice(0)) pipe.close(); vi.useRealTimers(); });

describe('CDP NUL pipe', () => {
  it('fd3にNUL区切りJSONを送り、UTF-8を途中で分割された応答をidで解決する', async () => {
    const { pipe, reader, sent } = setup();
    const first = pipe.command('Page.enable', {}, 's1');
    const second = pipe.command('Browser.getVersion');
    expect(JSON.parse(sent[0]!.subarray(0, -1).toString())).toEqual({ id: 1, method: 'Page.enable', params: {}, sessionId: 's1' });
    expect(sent[0]!.at(-1)).toBe(0);
    const bytes = Buffer.from(`${JSON.stringify({ id: 1, sessionId: 's1', result: { title: '日本語' } })}\0`);
    const cut = bytes.indexOf(Buffer.from('日本語')) + 1;
    reader.write(bytes.subarray(0, cut));
    reader.write(Buffer.concat([bytes.subarray(cut), Buffer.from('{"id":2,"result":{"ok":true}}\0')]));
    expect(await first).toEqual({ title: '日本語' });
    expect(await second).toEqual({ ok: true });
  });

  it('応答順不同とsessionId付きイベント、引数なしイベントを扱う', async () => {
    const { pipe, receive } = setup();
    const events = vi.fn();
    pipe.on('event', events);
    const first = pipe.command('Page.enable', {}, 'a');
    const second = pipe.command('Page.enable', {}, 'b');
    receive({ id: 2, sessionId: 'b', result: { second: true } });
    receive({ method: 'Page.javascriptDialogOpening', sessionId: 'a', params: { type: 'alert' } });
    receive({ method: 'Page.frameResized' });
    receive({ id: 1, sessionId: 'a', result: {} });
    await expect(second).resolves.toEqual({ second: true });
    await expect(first).resolves.toEqual({});
    expect(events.mock.calls).toEqual([
      [{ method: 'Page.javascriptDialogOpening', sessionId: 'a', params: { type: 'alert' } }],
      [{ method: 'Page.frameResized', params: {} }],
    ]);
  });

  it('CDP errorの本文やURLを例外へ転記しない', async () => {
    const { pipe, receive } = setup();
    const pending = pipe.command('Page.navigate');
    receive({ id: 1, error: { code: -32000, message: 'ページ本文やURLの疑似データ' } });
    await expect(pending).rejects.toThrow(/^CDP_COMMAND_FAILED$/);
    expect(pipe.closed).toBe(false);
  });

  it('timeoutを拒否し、遅れた応答で次のcommandを解決しない', async () => {
    vi.useFakeTimers();
    const { pipe, receive } = setup({ timeoutMs: 20 });
    const timeout = expect(pipe.command('Page.enable')).rejects.toThrow('CDP_TIMEOUT');
    await vi.advanceTimersByTimeAsync(20);
    await timeout;
    const next = pipe.command('Page.enable');
    receive({ id: 1, result: { stale: true } });
    receive({ id: 2, result: { fresh: true } });
    await expect(next).resolves.toEqual({ fresh: true });
  });

  it.each(['end', 'close', 'error', 'childExit', 'childError', 'writeError'] as const)('%sで全pendingを拒否する', async (kind) => {
    const { pipe, reader, writer, child } = setup();
    const pending = [pipe.command('Page.enable'), pipe.command('Browser.getVersion')];
    const assertions = pending.map((promise) => expect(promise).rejects.toThrow(/^CDP_/));
    if (kind === 'childExit') child.emit('exit', 1, null);
    else if (kind === 'childError') child.emit('error', new Error('secret'));
    else if (kind === 'writeError') writer.emit('error', new Error('secret'));
    else if (kind === 'error') reader.emit('error', new Error('secret'));
    else reader.emit(kind);
    await Promise.all(assertions);
    await expect(pipe.command('Page.enable')).rejects.toThrow('CDP_DISCONNECTED');
    expect(pipe.closed).toBe(true);
  });

  it('上限を超えたNULなしデータで切断する', async () => {
    const { pipe, reader } = setup({ maxMessageBytes: 128 });
    const pending = expect(pipe.command('Page.enable')).rejects.toThrow('CDP_MESSAGE_LIMIT');
    reader.write(Buffer.alloc(64, 120));
    reader.write(Buffer.alloc(65, 120));
    await pending;
  });

  it('連結chunk全体が上限超過でも各メッセージが上限内なら受ける', () => {
    const { pipe, reader } = setup({ maxMessageBytes: 64 });
    const event = vi.fn();
    pipe.on('event', event);
    reader.write(Buffer.from('{"method":"Page.frameResized"}\0'.repeat(20)));
    expect(event).toHaveBeenCalledTimes(20);
    expect(pipe.closed).toBe(false);
  });

  it.each([
    null, [], { id: '1', result: {} }, { id: 1, result: [] }, { id: 1 },
    { id: 1, result: {}, error: { code: 1, message: 'x' } },
    { id: 1, error: { code: '1', message: 'x' } }, { method: 12, params: {} },
    { method: 'Page.frameResized', params: null },
  ])('unknownの不正な形を拒否する: %j', async (message) => {
    const { pipe, receive } = setup();
    const pending = expect(pipe.command('Page.enable')).rejects.toThrow(/^CDP_INVALID_/);
    receive(message);
    await pending;
  });

  it('不正UTF-8とJSONを拒否する', async () => {
    for (const bytes of [Buffer.from([0xff, 0]), Buffer.from('not-json\0')]) {
      const { pipe, reader } = setup();
      const pending = expect(pipe.command('Page.enable')).rejects.toThrow('CDP_INVALID_JSON');
      reader.write(bytes);
      await pending;
    }
  });

  it('別sessionの応答を受理しない', async () => {
    const { pipe, receive } = setup();
    const pending = pipe.command('Page.enable', {}, 'expected');
    receive({ id: 1, sessionId: 'other', result: {} });
    await expect(pending).rejects.toThrow('CDP_SESSION_MISMATCH');
  });

  it('pending数を制限する', async () => {
    const { pipe, receive } = setup({ maxPending: 1 });
    const pending = pipe.command('Page.enable');
    await expect(pipe.command('Page.enable')).rejects.toThrow('CDP_PENDING_LIMIT');
    receive({ id: 1, result: {} });
    await pending;
  });

  it('childのfd3/fd4がパイプでなければ拒否する', () => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'stdio', { value: [null, null, null, null, null] });
    expect(() => CdpPipe.fromChild(child)).toThrow('CDP_PIPE_MISSING');
  });
});
