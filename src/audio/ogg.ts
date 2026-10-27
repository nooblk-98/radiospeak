/**
 * Minimal streaming Ogg demuxer: feed it bytes, get back complete packets.
 * Only handles a single logical stream (what ffmpeg's ogg muxer writes for one
 * audio track), which is all the audio pipeline needs.
 */
export class OggPacketReader {
  #buf: Buffer = Buffer.alloc(0);
  #partial: Buffer[] = [];

  push(chunk: Buffer): Buffer[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const packets: Buffer[] = [];

    for (;;) {
      // Resync to the next capture pattern if we are not on one.
      const start = this.#buf.indexOf("OggS");
      if (start < 0) {
        this.#buf = this.#buf.subarray(Math.max(0, this.#buf.length - 3));
        break;
      }
      if (start > 0) this.#buf = this.#buf.subarray(start);
      if (this.#buf.length < 27) break;

      const segCount = this.#buf[26]!;
      const headerLen = 27 + segCount;
      if (this.#buf.length < headerLen) break;

      const segments = this.#buf.subarray(27, headerLen);
      let bodyLen = 0;
      for (const s of segments) bodyLen += s;
      if (this.#buf.length < headerLen + bodyLen) break;

      // A fresh page that is not a continuation drops any half-built packet.
      const continued = (this.#buf[5]! & 0x01) !== 0;
      if (!continued) this.#partial = [];

      let offset = headerLen;
      for (const len of segments) {
        this.#partial.push(this.#buf.subarray(offset, offset + len));
        offset += len;
        if (len < 255) {
          packets.push(Buffer.concat(this.#partial));
          this.#partial = [];
        }
      }
      this.#buf = this.#buf.subarray(headerLen + bodyLen);
    }
    return packets;
  }

  reset(): void {
    this.#buf = Buffer.alloc(0);
    this.#partial = [];
  }
}

/** True for the OpusHead / OpusTags header packets, which are not audio. */
export function isOpusHeader(packet: Buffer): boolean {
  if (packet.length < 8) return false;
  const tag = packet.toString("latin1", 0, 8);
  return tag === "OpusHead" || tag === "OpusTags";
}
