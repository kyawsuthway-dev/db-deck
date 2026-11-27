// SSH tunnel for server connections. No `vscode` import, so it can be smoke-tested in plain Node
// (architecture.md). The service supplies the secret and the host-key check.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Duplex } from 'stream';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import type { SshConfig } from '../types';

/** OpenSSH-style fingerprint of a raw host key: `SHA256:` + unpadded base64. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Decides whether to trust an SSH host key. Resolves true to connect. It may take as long as it needs
 * (it can ask the user); the handshake timeout waits for it.
 */
export type HostKeyCheck = (host: string, port: number, fingerprint: string) => Promise<boolean>;

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * One SSH session, opened on first use and shared by every database connection of a saved connection
 * (the editor's and the short-lived edit connections). Each database connection gets its own forwarded
 * channel, so no local port is opened. If the session drops, the next use opens a new one.
 */
export class SshTunnel {
  private client?: Client;
  private connecting?: Promise<Client>;
  private closed = false;

  constructor(
    private readonly ssh: SshConfig,
    /** The SSH password (auth `password`) or the key's passphrase (auth `key`). */
    private readonly secret: string | undefined,
    private readonly checkHostKey: HostKeyCheck,
  ) {}

  /** A stream to host:port as seen from the SSH host, shaped like a socket for `pg` and `mysql2`. */
  async openStream(host: string, port: number): Promise<Duplex> {
    const client = await this.getClient();
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      let settled = false;
      // The SSH host may take long to give up (a slow DNS lookup, a firewall), so give up after the usual timeout.
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`SSH tunnel: the SSH host didn’t reach ${host}:${port} in time.`));
      }, CONNECT_TIMEOUT_MS);
      client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => {
        clearTimeout(timer);
        if (settled) {
          ch?.close();
          return;
        }
        if (err) reject(new Error(`SSH tunnel: the SSH host couldn’t reach ${host}:${port} (${err.message}).`));
        else resolve(ch);
      });
    });
    return socketLike(channel);
  }

  close(): void {
    this.closed = true;
    this.client?.end();
    this.client = undefined;
  }

  private getClient(): Promise<Client> {
    if (this.closed) return Promise.reject(new Error('SSH tunnel: closed.'));
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const { host, port } = this.ssh;
    const auth = await this.auth();
    // The TCP connection gets the usual 10 s timeout. The SSH handshake can't have one: it may be waiting
    // for the user to look at an unknown host key.
    const sock = await connectTcp(host, port);
    // Loaded on first use (faster activation; most connections have no tunnel).
    const ssh2 = await import('ssh2');
    const client = new ssh2.Client();
    let rejectedKey: string | undefined;
    let asking = false;
    let timedOut = false;
    const failure = (err?: Error & { level?: string }) =>
      rejectedKey
        ? `SSH tunnel: the host key of ${host}:${port} (${rejectedKey}) isn’t trusted, so DB Deck didn’t connect.`
        : timedOut
          ? `SSH tunnel: ${host}:${port} didn’t complete the SSH handshake in time.`
          : err
            ? sshError(err)
            : `SSH tunnel: ${host}:${port} closed the connection.`;
    return new Promise<Client>((resolve, reject) => {
      let ready = false;
      const handshake = setTimeout(() => {
        if (asking) return;
        timedOut = true;
        client.end();
      }, CONNECT_TIMEOUT_MS);
      client
        .on('ready', () => {
          ready = true;
          clearTimeout(handshake);
          this.client = client;
          resolve(client);
        })
        .on('error', (err) => {
          clearTimeout(handshake);
          if (this.client === client) this.client = undefined;
          if (!ready) reject(new Error(failure(err)));
        })
        .on('close', () => {
          clearTimeout(handshake);
          if (this.client === client) this.client = undefined;
          if (!ready) reject(new Error(failure()));
        });
      const config: ConnectConfig = {
        sock,
        username: this.ssh.user,
        ...auth,
        readyTimeout: 0, // replaced by `handshake`, which pauses while the host key is being checked
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          const print = fingerprint(key);
          asking = true;
          this.checkHostKey(host, port, print).then(
            (ok) => {
              asking = false;
              if (!ok) rejectedKey = print;
              verify(ok);
            },
            () => {
              asking = false;
              rejectedKey = print;
              verify(false);
            },
          );
        },
      };
      try {
        client.connect(config);
      } catch (err) {
        // A key that can't be parsed (wrong passphrase, unsupported format) throws here.
        clearTimeout(handshake);
        sock.destroy();
        reject(new Error(`SSH tunnel: ${(err as Error).message}`));
      }
    });
  }

  private async auth(): Promise<Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase'>> {
    if (this.ssh.auth === 'password') return { password: this.secret ?? '' };
    if (!this.ssh.keyPath) throw new Error('SSH tunnel: no private key file chosen for this connection.');
    const file = expandHome(this.ssh.keyPath);
    let privateKey: Buffer;
    try {
      privateKey = await fs.promises.readFile(file);
    } catch (err) {
      throw new Error(`SSH tunnel: couldn’t read the private key file ${file} (${(err as Error).message}).`);
    }
    return { privateKey, passphrase: this.secret || undefined };
  }
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const fail = (message: string) => {
      sock.destroy();
      reject(new Error(`SSH tunnel: couldn’t connect to ${host}:${port} (${message}).`));
    };
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => fail('timed out'));
    sock.once('error', (err) => fail(err.message));
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.removeAllListeners('error');
      resolve(sock);
    });
  });
}

function sshError(err: Error & { level?: string }): string {
  if (err.level === 'client-authentication') return 'SSH tunnel: the SSH host rejected the user name, password or key.';
  return `SSH tunnel: ${err.message}`;
}

/**
 * `pg` treats its stream as a net.Socket: it calls connect(), setNoDelay() and setKeepAlive() and waits for
 * 'connect'. The channel is already open, so these are no-ops and 'connect' fires on the next tick.
 * TLS (the connection's SSL setting) still works on top: Node's tls accepts any duplex as its socket.
 */
function socketLike(channel: ClientChannel): Duplex {
  const socket = channel as ClientChannel & Record<string, unknown>;
  socket.connect = () => {
    process.nextTick(() => channel.emit('connect'));
    return channel;
  };
  socket.setNoDelay = () => channel;
  socket.setKeepAlive = () => channel;
  socket.setTimeout = () => channel;
  socket.ref = () => channel;
  socket.unref = () => channel;
  return channel;
}
