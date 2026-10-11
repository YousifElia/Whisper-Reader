/**
 * The join between the text we SPEAK and the DOM we HIGHLIGHT.
 *
 * These two strings diverge the moment we normalise anything: collapsing
 * whitespace deletes characters, stripping footnote markers deletes more, and
 * expanding "e.g." into "for example" *inserts* eleven characters that exist
 * in no text node at all. A naive `indexOf` back into the DOM is wrong the
 * first time a page says "e.g." twice.
 *
 * So we never search. While building the spoken string we record a piece
 * table: an ordered, contiguous, gap-free list of spans, each of which knows
 * exactly which text node it came from.
 *
 *   copy      - verbatim run of DOM text; maps character-for-character
 *   synthetic - text we invented; maps to a whole source span as one unit,
 *               because there is no sane way to point at the 7th character of
 *               "for example" inside the source text "e.g."
 *
 * Every highlight in the product resolves through `rangeFor`.
 */

export type Piece =
  | {
      readonly kind: 'copy';
      readonly spokenStart: number;
      readonly length: number;
      readonly node: Text;
      readonly nodeOffset: number;
    }
  | {
      readonly kind: 'synthetic';
      readonly spokenStart: number;
      readonly length: number;
      readonly node: Text;
      readonly nodeOffset: number;
      readonly nodeLength: number;
    };

export interface DomPoint {
  readonly node: Text;
  readonly offset: number;
}

/**
 * Accumulates spoken text and its piece table together, so the two can never
 * drift apart. Callers emit through copy/replace/skip; nothing else writes.
 */
export class SpokenTextBuilder {
  private readonly chunks: string[] = [];
  private readonly pieces: Piece[] = [];
  private length = 0;
  private last = '';

  /** Characters emitted so far. */
  get spokenLength(): number {
    return this.length;
  }

  /** Last character emitted, or '' at the start. Lets callers collapse
   *  whitespace across text-node boundaries without re-reading the buffer. */
  get lastChar(): string {
    return this.last;
  }

  /** Verbatim DOM text. Maps character-for-character. */
  copy(node: Text, nodeOffset: number, text: string): void {
    if (text.length === 0) return;
    this.chunks.push(text);
    this.pieces.push({
      kind: 'copy',
      spokenStart: this.length,
      length: text.length,
      node,
      nodeOffset,
    });
    this.length += text.length;
    this.last = text[text.length - 1]!;
  }

  /**
   * Text we invented, standing in for `nodeLength` characters of source.
   * An empty `spoken` is a pure deletion and emits no piece at all, which is
   * exactly what we want for footnote markers and zero-width characters.
   */
  replace(
    node: Text,
    nodeOffset: number,
    nodeLength: number,
    spoken: string,
  ): void {
    if (spoken.length === 0) return;
    this.chunks.push(spoken);
    this.pieces.push({
      kind: 'synthetic',
      spokenStart: this.length,
      length: spoken.length,
      node,
      nodeOffset,
      nodeLength,
    });
    this.length += spoken.length;
    this.last = spoken[spoken.length - 1]!;
  }

  /** Source text that contributes nothing to speech. Recorded for clarity at
   *  call sites; deliberately a no-op. */
  skip(_node: Text, _nodeOffset: number, _nodeLength: number): void {}

  build(): { text: string; map: OffsetMap } {
    return {
      text: this.chunks.join(''),
      map: new OffsetMap(this.pieces),
    };
  }
}

export class OffsetMap {
  constructor(private readonly pieces: readonly Piece[]) {}

  get isEmpty(): boolean {
    return this.pieces.length === 0;
  }

  /** The piece covering spoken index `i`. Pieces are contiguous and sorted,
   *  so this is a plain binary search with no gap handling. */
  private pieceAt(i: number): Piece | null {
    let lo = 0;
    let hi = this.pieces.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = this.pieces[mid]!;
      if (i < p.spokenStart) hi = mid - 1;
      else if (i >= p.spokenStart + p.length) lo = mid + 1;
      else return p;
    }
    return null;
  }

  /** DOM point immediately before spoken character `i`. */
  startPoint(i: number): DomPoint | null {
    const p = this.pieceAt(i);
    if (!p) return null;
    return p.kind === 'copy'
      ? { node: p.node, offset: p.nodeOffset + (i - p.spokenStart) }
      : { node: p.node, offset: p.nodeOffset };
  }

  /** DOM point immediately after spoken character `i - 1`. Synthetic pieces
   *  expand to their whole source span rather than a fraction of it. */
  endPoint(i: number): DomPoint | null {
    const p = this.pieceAt(i - 1);
    if (!p) return null;
    return p.kind === 'copy'
      ? { node: p.node, offset: p.nodeOffset + (i - 1 - p.spokenStart) + 1 }
      : { node: p.node, offset: p.nodeOffset + p.nodeLength };
  }

  /**
   * A live DOM Range for the half-open spoken span [start, end).
   *
   * Returns null rather than throwing when the span is empty or its nodes have
   * been detached — pages mutate underneath us constantly, and a stale
   * highlight request is routine, not exceptional.
   */
  rangeFor(start: number, end: number): Range | null {
    if (end <= start) return null;

    const s = this.startPoint(start);
    const e = this.endPoint(end);
    if (!s || !e) return null;
    if (!s.node.isConnected || !e.node.isConnected) return null;

    const doc = s.node.ownerDocument;
    if (!doc) return null;

    const range = doc.createRange();
    try {
      range.setStart(s.node, Math.min(s.offset, s.node.length));
      range.setEnd(e.node, Math.min(e.offset, e.node.length));
    } catch {
      // setEnd throws if the end lands before the start, which can happen if
      // the page reordered nodes between build and highlight.
      return null;
    }
    return range;
  }

  /**
   * The reverse of `rangeFor`: a DOM position back to a spoken index.
   *
   * Needed for "start reading from the word I clicked". `rangeFor` can afford
   * a binary search because pieces are ordered by spoken index; this direction
   * has no such ordering (one text node can back several pieces, and pieces
   * from different nodes interleave), so it scans. Blocks hold tens of pieces
   * at most, and this runs once per click, so that is fine.
   *
   * Returns null when the position is not covered — a click on whitespace we
   * dropped, or on a node belonging to a different block.
   */
  spokenIndexAt(node: Text, nodeOffset: number): number | null {
    let fallback: number | null = null;

    for (const piece of this.pieces) {
      if (piece.node !== node) continue;

      if (piece.kind === 'copy') {
        const end = piece.nodeOffset + piece.length;
        if (nodeOffset >= piece.nodeOffset && nodeOffset < end) {
          return piece.spokenStart + (nodeOffset - piece.nodeOffset);
        }
        // Clicking just past the last character of a run still means that run.
        if (nodeOffset === end) fallback = piece.spokenStart + piece.length - 1;
      } else {
        const end = piece.nodeOffset + piece.nodeLength;
        // Synthetic text has no interior mapping, so any position inside the
        // source span resolves to where its replacement begins.
        if (nodeOffset >= piece.nodeOffset && nodeOffset <= end) {
          return piece.spokenStart;
        }
      }
    }

    return fallback;
  }

  /** Every distinct text node this map touches. Used to detect detachment. */
  nodes(): Text[] {
    const seen = new Set<Text>();
    for (const p of this.pieces) seen.add(p.node);
    return [...seen];
  }
}
