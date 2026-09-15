/** 16-bit PCM WAV serialisation for exporting a rendered mix. */

export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  // Interleave in chunks so a long mix does not need a second full-size copy
  // of itself in memory all at once.
  const chunkFrames = 1 << 16;
  const parts: BlobPart[] = [header];
  const source: Float32Array[] = [];
  for (let c = 0; c < channels; c++) source.push(buffer.getChannelData(c));

  for (let start = 0; start < frames; start += chunkFrames) {
    const count = Math.min(chunkFrames, frames - start);
    const chunk = new Int16Array(count * channels);
    let w = 0;
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < channels; c++) {
        const v = source[c][start + i];
        const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
        chunk[w++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
    }
    parts.push(chunk.buffer);
  }

  return new Blob(parts, { type: "audio/wav" });
}
