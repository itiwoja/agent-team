import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export class CdpError extends Error {
  readonly code: string;

  constructor(code: string) {
    // CDPのerror.messageにはURL・ページ本文が入り得るので外へ出さない。
    super(code);
    this.name = 'CdpError';
    this.code = code;
  }
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
}

export interface CdpPipeOptions {
  timeoutMs?: number;
  maxMessageBytes?: number;
  maxPending?: number;
}

/** Chromiumのfd3へ書き、fd4から読む。TCPの接続口は持たない。 */
export class CdpPipe extends EventEmitter<{
  event: [CdpEvent];
  disconnect: [Error];
}> {
  readonly #writer: Writable;
  readonly #reader: Readable;
  readonly #child: Pick<ChildProcess, 'once' | 'off'> | undefined;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxPending: number;
  readonly #pending = new Map<number, Pending>();
  #buffer: Buffer = Buffer.alloc(0);
  #nextId = 1;
  #closed = false;

  constructor(writer: Writable, reader: Readable,
    child?: Pick<ChildProcess, 'once' | 'off'>, options: CdpPipeOptions = {}) {
    super();
    this.#writer = writer;
    this.#reader = reader;
    this.#child = child;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
    this.#maxPending = options.maxPending ?? 256;
    for (const limit of [this.#timeoutMs, this.#maxMessageBytes, this.#maxPending]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new CdpError('CDP_INVALID_LIMIT');
    }
    reader.on('data', this.#onData);
    reader.once('end', this.#onEnd);
    reader.once('close', this.#onEnd);
    reader.on('error', this.#onStreamError);
    writer.once('close', this.#onEnd);
    writer.on('error', this.#onStreamError);
    child?.once('exit', this.#onExit);
    child?.once('error', this.#onChildError);
  }

  static fromChild(child: ChildProcess, options?: CdpPipeOptions): CdpPipe {
    const writer = child.stdio[3];
    const reader = child.stdio[4];
    if (!(writer instanceof Writable) || !(reader instanceof Readable)) {
      throw new CdpError('CDP_PIPE_MISSING');
    }
    return new CdpPipe(writer, reader, child, options);
  }

  get closed(): boolean { return this.#closed; }

  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new CdpError('CDP_DISCONNECTED'));
    if (this.#pending.size >= this.#maxPending) return Promise.reject(new CdpError('CDP_PENDING_LIMIT'));
    if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(method) || (sessionId !== undefined && !sessionId)) {
      return Promise.reject(new CdpError('CDP_INVALID_COMMAND'));
    }
    const id = this.#nextId++;
    if (!Number.isSafeInteger(id)) return Promise.reject(new CdpError('CDP_ID_EXHAUSTED'));
    let bytes: Buffer;
    try {
      bytes = Buffer.from(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    } catch {
      return Promise.reject(new CdpError('CDP_INVALID_COMMAND'));
    }
    if (bytes.length > this.#maxMessageBytes) return Promise.reject(new CdpError('CDP_MESSAGE_LIMIT'));
    if (this.#writer.writableLength + bytes.length > this.#maxMessageBytes) return Promise.reject(new CdpError('CDP_WRITE_LIMIT'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError('CDP_TIMEOUT'));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, sessionId });
      try {
        this.#writer.write(bytes, (error) => {
          if (error) this.close(new CdpError('CDP_WRITE_FAILED'));
        });
      } catch {
        this.close(new CdpError('CDP_WRITE_FAILED'));
      }
    });
  }

  close(error: Error = new CdpError('CDP_DISCONNECTED')): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#buffer = Buffer.alloc(0);
    this.#reader.off('data', this.#onData);
    this.#reader.off('end', this.#onEnd);
    this.#reader.off('close', this.#onEnd);
    this.#writer.off('close', this.#onEnd);
    this.#child?.off('exit', this.#onExit);
    this.#child?.off('error', this.#onChildError);
    // パイプの後続errorも消費する（切断後のEPIPEを未処理例外にしない）。
    this.#writer.destroy();
    this.#reader.destroy();
    this.emit('disconnect', error);
  }

  readonly #onEnd = (): void => { this.close(new CdpError('CDP_DISCONNECTED')); };
  readonly #onExit = (): void => { this.close(new CdpError('CDP_CHILD_EXIT')); };
  readonly #onChildError = (): void => { this.close(new CdpError('CDP_CHILD_ERROR')); };
  readonly #onStreamError = (): void => { this.close(new CdpError('CDP_STREAM_ERROR')); };

  readonly #onData = (chunk: unknown): void => {
    if (!Buffer.isBuffer(chunk)) {
      this.close(new CdpError('CDP_INVALID_FRAME'));
      return;
    }
    // 連結chunk全体でなく、NULごとのメッセージに上限を適用する。
    let offset = 0;
    while (offset < chunk.length && !this.#closed) {
      const end = chunk.indexOf(0, offset);
      const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (this.#buffer.length + part.length > this.#maxMessageBytes) {
        this.close(new CdpError('CDP_MESSAGE_LIMIT'));
        return;
      }
      this.#buffer = Buffer.concat([this.#buffer, part]);
      if (end < 0) return;
      const frame = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      this.#receive(frame);
      offset = end + 1;
    }
  };

  #receive(frame: Buffer): void {
    let message: unknown;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
    catch { this.close(new CdpError('CDP_INVALID_JSON')); return; }
    if (!isRecord(message) || (message.sessionId !== undefined && typeof message.sessionId !== 'string')) {
      this.close(new CdpError('CDP_INVALID_MESSAGE'));
      return;
    }
    if ('id' in message) {
      if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id < 1
        || ('result' in message) === ('error' in message)
        || ('result' in message && !isRecord(message.result))
        || ('error' in message && (!isRecord(message.error) || typeof message.error.code !== 'number'
          || typeof message.error.message !== 'string'))) {
        this.close(new CdpError('CDP_INVALID_RESPONSE'));
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return; // timeout後の遅延応答
      if (message.sessionId !== pending.sessionId) {
        this.close(new CdpError('CDP_SESSION_MISMATCH'));
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isRecord(message.error)) pending.reject(new CdpError('CDP_COMMAND_FAILED'));
      else if (isRecord(message.result)) pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string' || (message.params !== undefined && !isRecord(message.params))) {
      this.close(new CdpError('CDP_INVALID_EVENT'));
      return;
    }
    this.emit('event', { method: message.method, params: isRecord(message.params) ? message.params : {},
      ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}) });
  }
}
