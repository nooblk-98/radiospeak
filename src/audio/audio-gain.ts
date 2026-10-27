import { Transform, type TransformCallback } from "node:stream";

const FRAME_BYTES = (48000 * 2 * 2 * 20) / 1000;

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
  #meter?: (rms: number, peak: number, gain: number) => void;

  constructor(
    target: () => number,
    canWrite: () => boolean,
    submitted: () => void,
    meter?: (rms: number, peak: number, gain: number) => void,
  ) {
    super({ highWaterMark: FRAME_BYTES * 2 });
    this.#target = target;
    this.#canWrite = canWrite;
    this.#submitted = submitted;
    this.#gain = target();
    this.#meter = meter;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    this.#pending = this.#carry.length ? Buffer.concat([this.#carry, chunk]) : chunk;
    this.#carry = Buffer.alloc(0);
    this.#offset = 0;
    this.#done = done;
    this.#pump();
  }

  override _flush(done: TransformCallback) {
    this.#pending = this.#carry;
    this.#carry = Buffer.alloc(0);
    this.#offset = 0;
    this.#finishing = true;
    this.#done = done;
    this.#pump();
  }

  /** The consumer returns encoder credit when an Opus frame is played. */
  grantCredit() {
    this.#pump();
  }

  #pump = () => {
    if (this.destroyed || !this.#done) return;
    while (
      this.#pending.length - this.#offset >= (this.#finishing ? 4 : FRAME_BYTES) &&
      this.#canWrite()
    ) {
      const length = Math.min(FRAME_BYTES, this.#pending.length - this.#offset) & ~3;
      const frame = Buffer.from(this.#pending.subarray(this.#offset, this.#offset + length));
      this.#offset += length;
      const from = this.#gain,
        to = this.#target();
      if (this.#meter) {
        let sum = 0,
          peak = 0;
        for (let i = 0; i < length; i += 2) {
          const sample = frame.readInt16LE(i) / 32768;
          sum += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        this.#meter(Math.sqrt(sum / (length / 2)), peak, to);
      }
      if (from !== 1 || to !== 1) {
        const count = length / 2,
          step = (to - from) / count;
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
      const done = this.#done;
      this.#done = undefined;
      done();
    }
  };

  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    const pending = this.#done;
    this.#done = undefined;
    pending?.();
    done(error);
  }
}
