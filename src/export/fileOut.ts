// Writes an export file in chunks. No vscode, so it can be smoke-tested in plain Node.
import * as fs from 'fs';

/** A file written in chunks, respecting back-pressure. `discard()` removes a partial file. */
export class FileOut {
  private readonly stream: fs.WriteStream;
  private failed?: Error;

  constructor(private readonly file: string) {
    this.stream = fs.createWriteStream(file, { encoding: 'utf8' });
    this.stream.on('error', (err) => (this.failed = err));
  }

  async write(text: string): Promise<void> {
    if (this.failed) throw this.failed;
    if (!text) return;
    if (!this.stream.write(text)) {
      // Remove whichever listener didn't fire, or a long export would pile them up.
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          this.stream.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          this.stream.off('drain', onDrain);
          reject(err);
        };
        this.stream.once('drain', onDrain);
        this.stream.once('error', onError);
      });
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failed) return reject(this.failed);
      this.stream.end(() => (this.failed ? reject(this.failed) : resolve()));
    });
  }

  async discard(): Promise<void> {
    // Listen before destroying, so the 'close' event can't be missed.
    await new Promise<void>((resolve) => {
      if (this.stream.closed) return resolve();
      this.stream.once('close', () => resolve());
      this.stream.destroy();
    });
    await fs.promises.rm(this.file, { force: true });
  }
}
