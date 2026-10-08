/**
 * Fragmented MP4 -> ordinary MP4, without re-encoding.
 *
 * MediaRecorder writes fragmented MP4: an empty index up front and the real
 * one scattered across a moof per second, with no total duration anywhere.
 * Browsers and VLC cope; some desktop players show no length and refuse to
 * seek. This rebuilds one sample table per track from the fragments, puts the
 * index first ("faststart") and copies the media bytes over untouched.
 *
 * Handles what MediaRecorder emits: default-base-is-moof fragments, no
 * composition offsets (no B-frames). Anything else is refused rather than
 * remuxed wrongly.
 */

import { readFileSync, writeFileSync } from 'node:fs';

function children(buf, start, end) {
  const out = [];
  for (let o = start; o < end; ) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(o + 8));
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    out.push({ type, start: o, body: o + header, end: o + size });
    o += size;
  }
  return out;
}
const find = (list, type) => list.find((b) => b.type === type);
const kids = (buf, box) => children(buf, box.body, box.end);

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}
const full = (type, version, flags, ...parts) => {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, vf, ...parts);
};
const u32 = (...values) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
  return b;
};

export function defragment(inputPath, outputPath) {
  const buf = readFileSync(inputPath);
  const top = children(buf, 0, buf.length);
  const moov = find(top, 'moov');
  if (!moov) throw new Error('no moov');
  const moovKids = kids(buf, moov);

  const tracks = new Map();
  for (const trak of moovKids.filter((b) => b.type === 'trak')) {
    const t = kids(buf, trak);
    const tkhd = find(t, 'tkhd');
    const id = buf.readUInt32BE(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12));
    const mdia = kids(buf, find(t, 'mdia'));
    const mdhd = find(mdia, 'mdhd');
    const timescale = buf.readUInt32BE(mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12));
    const minf = kids(buf, find(mdia, 'minf'));
    const stbl = kids(buf, find(minf, 'stbl'));
    tracks.set(id, {
      id, trak, tkhd, mdhd, timescale,
      hdlr: find(mdia, 'hdlr'),
      header: find(minf, 'vmhd') ?? find(minf, 'smhd'),
      dinf: find(minf, 'dinf'),
      stsd: find(stbl, 'stsd'),
      isVideo: !!find(minf, 'vmhd'),
      chunks: [],
      firstTime: null,
    });
  }

  // Walk the fragments, collecting each run of samples as one chunk.
  for (const moof of top.filter((b) => b.type === 'moof')) {
    for (const traf of kids(buf, moof).filter((b) => b.type === 'traf')) {
      const parts = kids(buf, traf);
      const tfhd = find(parts, 'tfhd');
      const flags = buf.readUInt32BE(tfhd.body) & 0xffffff;
      const track = tracks.get(buf.readUInt32BE(tfhd.body + 4));
      if (!(flags & 0x20000)) throw new Error('expected default-base-is-moof');
      let p = tfhd.body + 8;
      if (flags & 0x1) throw new Error('explicit base data offset not supported');
      if (flags & 0x2) p += 4;
      const defaultDuration = flags & 0x8 ? buf.readUInt32BE(p) : 0;
      if (flags & 0x8) p += 4;
      const defaultSize = flags & 0x10 ? buf.readUInt32BE(p) : 0;
      if (flags & 0x10) p += 4;
      const defaultFlags = flags & 0x20 ? buf.readUInt32BE(p) : 0;

      const tfdt = find(parts, 'tfdt');
      if (tfdt && track.firstTime === null) {
        track.firstTime = buf[tfdt.body] === 1
          ? Number(buf.readBigUInt64BE(tfdt.body + 4))
          : buf.readUInt32BE(tfdt.body + 4);
      }

      for (const trun of parts.filter((b) => b.type === 'trun')) {
        const tf = buf.readUInt32BE(trun.body) & 0xffffff;
        if (tf & 0x800) throw new Error('composition offsets (B-frames) not supported');
        const count = buf.readUInt32BE(trun.body + 4);
        let q = trun.body + 8;
        let offset = moof.start;
        if (tf & 0x1) { offset += buf.readInt32BE(q); q += 4; }
        let firstFlags = null;
        if (tf & 0x4) { firstFlags = buf.readUInt32BE(q); q += 4; }
        const samples = [];
        for (let i = 0; i < count; i++) {
          const duration = tf & 0x100 ? buf.readUInt32BE((q += 4) - 4) : defaultDuration;
          const size = tf & 0x200 ? buf.readUInt32BE((q += 4) - 4) : defaultSize;
          let sflags = tf & 0x400 ? buf.readUInt32BE((q += 4) - 4) : defaultFlags;
          if (i === 0 && firstFlags !== null) sflags = firstFlags;
          samples.push({ duration, size, sync: (sflags & 0x10000) === 0 });
        }
        const bytes = samples.reduce((n, s) => n + s.size, 0);
        track.chunks.push({ source: offset, bytes, samples });
      }
    }
  }

  const ordered = [...tracks.values()].sort((a, b) => a.id - b.id);
  const MOVIE_TS = 1000;
  const lengths = new Map(ordered.map((t) => [
    t.id,
    t.chunks.reduce((n, c) => n + c.samples.reduce((m, s) => m + s.duration, 0), 0),
  ]));
  const startOf = (t) => (t.firstTime ?? 0) / t.timescale;
  const movieDuration = Math.ceil(
    Math.max(...ordered.map((t) => (startOf(t) + lengths.get(t.id) / t.timescale) * MOVIE_TS)),
  );

  // Interleave chunks in their original file order, so playback reads the
  // file front to back exactly as the recorder laid it out.
  const all = ordered.flatMap((t) => t.chunks.map((c) => ({ t, c }))).sort((a, b) => a.c.source - b.c.source);

  const build = (mdatStart) => {
    let cursor = mdatStart + 8;
    for (const { c } of all) {
      c.target = cursor;
      cursor += c.bytes;
    }
    const traks = ordered.map((t) => {
      const samples = t.chunks.flatMap((c) => c.samples);
      // stts: run-length encoded sample durations
      const stts = [];
      for (const s of samples) {
        const last = stts[stts.length - 1];
        if (last && last[1] === s.duration) last[0]++;
        else stts.push([1, s.duration]);
      }
      // stsc: runs of chunks with the same sample count
      const stsc = [];
      t.chunks.forEach((c, i) => {
        const last = stsc[stsc.length - 1];
        if (!last || last[1] !== c.samples.length) stsc.push([i + 1, c.samples.length, 1]);
      });
      const syncs = [];
      samples.forEach((s, i) => s.sync && syncs.push(i + 1));

      const stblParts = [
        buf.subarray(t.stsd.start, t.stsd.end),
        full('stts', 0, 0, u32(stts.length), ...stts.map(([n, d]) => u32(n, d))),
        full('stsc', 0, 0, u32(stsc.length), ...stsc.map((e) => u32(...e))),
        full('stsz', 0, 0, u32(0, samples.length), ...samples.map((s) => u32(s.size))),
        full('stco', 0, 0, u32(t.chunks.length), ...t.chunks.map((c) => u32(c.target))),
      ];
      if (t.isVideo && syncs.length < samples.length) {
        stblParts.splice(2, 0, full('stss', 0, 0, u32(syncs.length), ...syncs.map((n) => u32(n))));
      }

      const trackDur = lengths.get(t.id);
      const mdhd = Buffer.from(buf.subarray(t.mdhd.start, t.mdhd.end));
      if (mdhd[8] === 1) mdhd.writeBigUInt64BE(BigInt(trackDur), 32);
      else mdhd.writeUInt32BE(trackDur, 24);
      const tkhd = Buffer.from(buf.subarray(t.tkhd.start, t.tkhd.end));
      const tkDur = Math.ceil((startOf(t) * t.timescale + trackDur) / t.timescale * MOVIE_TS);
      if (tkhd[8] === 1) tkhd.writeBigUInt64BE(BigInt(tkDur), 36);
      else tkhd.writeUInt32BE(tkDur, 28);

      // Preserve a late start (audio beginning after video, say) with an
      // empty edit, so the tracks stay in sync after the remux.
      const edits = [];
      const lead = Math.round(startOf(t) * MOVIE_TS);
      if (lead > 0) edits.push(u32(lead, 0xffffffff, 0x10000));
      edits.push(u32(Math.round(trackDur / t.timescale * MOVIE_TS), 0, 0x10000));
      const edts = box('edts', full('elst', 0, 0, u32(edits.length), ...edits));

      return box('trak',
        tkhd,
        edts,
        box('mdia',
          mdhd,
          buf.subarray(t.hdlr.start, t.hdlr.end),
          box('minf',
            buf.subarray(t.header.start, t.header.end),
            buf.subarray(t.dinf.start, t.dinf.end),
            box('stbl', ...stblParts))));
    });

    const mvhdSrc = find(moovKids, 'mvhd');
    const mvhd = Buffer.from(buf.subarray(mvhdSrc.start, mvhdSrc.end));
    const v1 = mvhd[8] === 1;
    mvhd.writeUInt32BE(MOVIE_TS, v1 ? 28 : 20);
    if (v1) mvhd.writeBigUInt64BE(BigInt(movieDuration), 32);
    else mvhd.writeUInt32BE(movieDuration, 24);
    return box('moov', mvhd, ...traks);
  };

  const ftyp = box('ftyp', Buffer.from('isom'), u32(0x200), Buffer.from('isomiso2avc1mp41'));
  // Two passes: the index's size does not depend on the offsets inside it.
  const moovOut = build(ftyp.length + build(0).length);
  const mdatBytes = all.reduce((n, { c }) => n + c.bytes, 0);
  const mdatHead = Buffer.alloc(8);
  mdatHead.writeUInt32BE(8 + mdatBytes);
  mdatHead.write('mdat', 4, 'ascii');
  const media = all.map(({ c }) => buf.subarray(c.source, c.source + c.bytes));
  writeFileSync(outputPath, Buffer.concat([ftyp, moovOut, mdatHead, ...media]));
  return {
    seconds: movieDuration / MOVIE_TS,
    tracks: ordered.map((t) => ({
      kind: t.isVideo ? 'video' : 'audio',
      samples: t.chunks.reduce((n, c) => n + c.samples.length, 0),
      startsAt: startOf(t),
    })),
  };
}

if (process.argv[1]?.endsWith('defrag.mjs')) {
  const [input, output] = process.argv.slice(2);
  console.log(defragment(input, output ?? input));
}
