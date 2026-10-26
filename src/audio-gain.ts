import { Transform, type TransformCallback } from "node:stream";

const FRAME_BYTES = 48000 * 2 * 2 * 20 / 1000;

/** Applies live gain just before a bounded amount of PCM enters the encoder. */
export class AudioGain extends Transform {
  #target: () => number;
  #canWrite: () => boolean;
  #submitted: () => void;
  #gain: number;
  #carry: Buffer = Buffer.alloc(0);
  #pending: Buffer = Buffer.alloc(0);
  #offset = 0;
  #done: TransformCallback | undefined;
  #finishing = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(target: () => number, canWrite: () => boolean, submitted: () => void) {
    super({ highWaterMark: FRAME_BYTES * 2 });
    this.#target = target; this.#canWrite = canWrite; this.#submitted = submitted;
    this.#gain = target();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    this.#pending = this.#carry.length ? Buffer.concat([this.#carry, chunk]) : chunk;
    this.#carry = Buffer.alloc(0); this.#offset = 0; this.#done = done;
    this.#pump();
  }

  override _flush(done: TransformCallback) {
    this.#pending = this.#carry; this.#carry = Buffer.alloc(0);
    this.#offset = 0; this.#finishing = true; this.#done = done;
    this.#pump();
  }

  #pump = () => {
    this.#timer = undefined;
    if (this.destroyed || !this.#done) return;
    while (this.#pending.length - this.#offset >= (this.#finishing ? 4 : FRAME_BYTES) && this.#canWrite()) {
      const length = Math.min(FRAME_BYTES, this.#pending.length - this.#offset) & ~3;
      const frame = Buffer.from(this.#pending.subarray(this.#offset, this.#offset + length));
      this.#offset += length;
      const from = this.#gain, to = this.#target();
      if (from !== 1 || to !== 1) {
        const count = length / 2, step = (to - from) / count;
        for (let i = 0; i < count; i++) {
          const value = frame.readInt16LE(i * 2) * (from + step * i);
          frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
        }
      }
      this.#gain = to;
      this.#submitted();
      this.push(frame);
    }
    const remaining = this.#pending.length - this.#offset;
    if (remaining < (this.#finishing ? 4 : FRAME_BYTES)) {
      this.#carry = Buffer.from(this.#pending.subarray(this.#offset));
      this.#pending = Buffer.alloc(0);
      const done = this.#done; this.#done = undefined; done();
    } else this.#timer = setTimeout(this.#pump, 5).unref();
  };

  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    clearTimeout(this.#timer);
    const pending = this.#done; this.#done = undefined;
    pending?.();
    done(error);
  }
}
