// A fake Slack for the Socket Mode client: apps.connections.open hands out a
// ws:// URL on this same server, whose upgrade speaks just enough WebSocket
// (RFC 6455, unfragmented text frames) to say hello, send envelopes and read
// acks. The bot's core is driven through a fake transport instead, which
// records what it posts. No test talks to Slack.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { SlackEvent, Transport } from '../src/slack-api.ts';

export type FakeSlack = {
  api: string;
  /** Every Web API call, as `<method> <token>`. */
  calls: string[];
  /** Every message the client sent over a socket, parsed. */
  received: Record<string, unknown>[];
  /** A command's response_url on this server; what is posted to it lands in responses. */
  responseUrl: string;
  responses: Record<string, unknown>[];
  /** How many sockets the client has opened. */
  connections(): number;
  /** Sends a message on the newest socket. */
  send(message: unknown): void;
  /** Ends the newest socket without a word, as when Slack or the network drops it. */
  drop(): void;
  close(): Promise<void>;
};

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

/** Reads the client's masked frames off a socket: text to onText, a close frame ends the socket. */
function readFrames(socket: Socket, onText: (text: string) => void): void {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0]! & 0x0f;
      let len = buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = buf.subarray(off, off + 4);
      off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len).map((b, i) => b ^ mask[i % 4]!));
      buf = buf.subarray(off + len);
      if (opcode === 0x1) onText(payload.toString());
      if (opcode === 0x8) socket.destroy();
    }
  });
}

/** A bot token in tokens makes auth.test work with it, for helix slack setup. */
export async function fakeSlack(tokens: { app: string; bot?: string } = { app: 'xapp-good' }): Promise<FakeSlack> {
  const calls: string[] = [];
  const received: Record<string, unknown>[] = [];
  const responses: Record<string, unknown>[] = [];
  const sockets: Socket[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/respond') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; });
      req.on('end', () => { responses.push(JSON.parse(body) as Record<string, unknown>); res.end('ok'); });
      return;
    }
    const method = req.url!.replace('/api/', '');
    const token = req.headers.authorization?.replace('Bearer ', '');
    calls.push(`${method} ${token}`);
    res.setHeader('content-type', 'application/json');
    const port = (server.address() as AddressInfo).port;
    res.end(JSON.stringify(method === 'apps.connections.open' && token === tokens.app
      ? { ok: true, url: `ws://127.0.0.1:${port}/link/${sockets.length + 1}` }
      : method === 'auth.test' && tokens.bot && token === tokens.bot ? { ok: true, team: 'Acme' }
      : { ok: false, error: 'invalid_auth' }));
  });
  server.on('upgrade', (req, socket: Socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.push(socket);
    socket.on('error', () => {});
    readFrames(socket, (text) => received.push(JSON.parse(text) as Record<string, unknown>));
    socket.write(frame(JSON.stringify({ type: 'hello', num_connections: 1 })));
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  return {
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    calls,
    received,
    responseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/respond`,
    responses,
    connections: () => sockets.length,
    send: (message) => sockets.at(-1)!.write(frame(JSON.stringify(message))),
    drop: () => sockets.at(-1)!.destroy(),
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => { server.close(() => r()); });
    },
  };
}

/** What the bot's core sent through the fake transport. */
export type Sent =
  | { method: 'post'; channel: string; text: string; thread?: string; blocks?: unknown[] }
  | { method: 'dm'; user: string }
  | { method: 'ephemeral'; channel: string; user: string; text: string }
  | { method: 'respond'; url: string; text: string }
  | { method: 'upload'; channel: string; thread: string; filename: string; content: string }
  | { method: 'update'; channel: string; ts: string; text: string; blocks?: unknown[] }
  | { method: 'deleteFile'; file: string };

/** A transport for the bot's core that records what it sends; deliver hands it an event as Slack would. */
export function fakeTransport() {
  let handle: ((event: SlackEvent) => Promise<void>) | undefined;
  const sent: Sent[] = [];
  const transport: Transport = {
    onEvent: (h) => { handle = h; },
    post: async (channel, text, thread, blocks) => { sent.push({ method: 'post', channel, text, ...(thread ? { thread } : {}), ...(blocks ? { blocks } : {}) }); return `ts-${sent.length}`; },
    dm: async (user) => { sent.push({ method: 'dm', user }); return `D-${user}`; },
    ephemeral: async (channel, user, text) => { sent.push({ method: 'ephemeral', channel, user, text }); },
    respond: async (url, text) => { sent.push({ method: 'respond', url, text }); },
    upload: async (channel, thread, filename, content) => { sent.push({ method: 'upload', channel, thread, filename, content }); return `F-${sent.length}`; },
    update: async (channel, ts, text, blocks) => { sent.push({ method: 'update', channel, ts, text, ...(blocks ? { blocks } : {}) }); },
    deleteFile: async (file) => { sent.push({ method: 'deleteFile', file }); },
  };
  return { transport, sent, deliver: (event: SlackEvent) => handle!(event) };
}

/** Waits for what a test expects to happen, failing after a while instead of hanging. */
export async function until(what: string, ok: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
