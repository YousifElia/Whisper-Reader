import { describe, it, expect, beforeEach } from 'vitest';
import { SpokenTextBuilder } from '../lib/extract/offsets';

function para(html: string): Text[] {
  const p = document.createElement('p');
  p.innerHTML = html;
  document.body.appendChild(p);
  const out: Text[] = [];
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('verbatim copy', () => {
  it('maps a span inside one text node', () => {
    const [t] = para('Hello world') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, t.data);
    const { text, map } = b.build();

    expect(text).toBe('Hello world');
    expect(map.rangeFor(0, 5)!.toString()).toBe('Hello');
    expect(map.rangeFor(6, 11)!.toString()).toBe('world');
  });

  it('spans a range across sibling text nodes', () => {
    const [a, bNode, c] = para('Hello <em>brave</em> world') as [Text, Text, Text];
    const b = new SpokenTextBuilder();
    b.copy(a, 0, a.data);
    b.copy(bNode, 0, bNode.data);
    b.copy(c, 0, c.data);
    const { text, map } = b.build();

    expect(text).toBe('Hello brave world');
    expect(map.rangeFor(6, 11)!.toString()).toBe('brave');
    // A range that starts in one node and ends in another.
    expect(map.rangeFor(0, 17)!.toString()).toBe('Hello brave world');
    expect(map.rangeFor(4, 13)!.toString()).toBe('o brave w');
  });
});

describe('deletions', () => {
  it('keeps indices after a skipped run correct', () => {
    const [t] = para('Water boils[1] at 100C') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, 'Water boils');
    b.skip(t, 11, 3); // "[1]"
    b.copy(t, 14, ' at 100C');
    const { text, map } = b.build();

    expect(text).toBe('Water boils at 100C');
    // "at 100C" is at spoken 12, but DOM offset 14 - the skip must be absorbed.
    expect(map.rangeFor(12, 19)!.toString()).toBe('at 100C');
  });

  it('collapses a whitespace run to a single real character', () => {
    const [t] = para('one   \n  two') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, 'one');
    b.copy(t, 3, ' '); // first char of the run is real; rest is dropped
    b.skip(t, 4, 5);
    b.copy(t, 9, 'two');
    const { text, map } = b.build();

    expect(text).toBe('one two');
    expect(map.rangeFor(4, 7)!.toString()).toBe('two');
  });
});

describe('synthetic text', () => {
  it('expands an abbreviation and maps it back to the whole source span', () => {
    const [t] = para('Use e.g. this') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, 'Use ');
    b.replace(t, 4, 4, 'for example'); // "e.g." -> 11 chars that exist nowhere
    b.copy(t, 8, ' this');
    const { text, map } = b.build();

    expect(text).toBe('Use for example this');

    // The expansion highlights its whole source, never a fraction of it.
    expect(map.rangeFor(4, 15)!.toString()).toBe('e.g.');
    // Partial overlap still snaps out to the full source span.
    expect(map.rangeFor(8, 15)!.toString()).toBe('e.g.');
    // Text on either side is unaffected.
    expect(map.rangeFor(0, 15)!.toString()).toBe('Use e.g.');
    expect(map.rangeFor(16, 20)!.toString()).toBe('this');
  });

  it('treats an empty replacement as a deletion', () => {
    const [t] = para('a\u200Bb') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, 'a');
    b.replace(t, 1, 1, ''); // zero-width space
    b.copy(t, 2, 'b');
    const { text, map } = b.build();

    expect(text).toBe('ab');
    expect(map.rangeFor(0, 2)!.toString()).toBe('a\u200Bb');
  });
});

describe('degenerate input', () => {
  it('returns null instead of throwing', () => {
    const [t] = para('short') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, 'short');
    const { map } = b.build();

    expect(map.rangeFor(2, 2)).toBeNull(); // empty
    expect(map.rangeFor(3, 1)).toBeNull(); // inverted
    expect(map.rangeFor(0, 99)).toBeNull(); // past the end
    expect(map.rangeFor(-5, 2)).toBeNull(); // before the start
  });

  it('returns null once the page has detached the node', () => {
    const [t] = para('gone soon') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, t.data);
    const { map } = b.build();
    expect(map.rangeFor(0, 4)).not.toBeNull();

    document.body.innerHTML = ''; // an SPA re-render
    expect(map.rangeFor(0, 4)).toBeNull();
  });

  it('reports an empty map', () => {
    expect(new SpokenTextBuilder().build().map.isEmpty).toBe(true);
  });
});

describe('spokenIndexAt (DOM position -> spoken index)', () => {
  it('round-trips a verbatim run', () => {
    const [t] = para('Hello world') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, t.data);
    const { map } = b.build();

    expect(map.spokenIndexAt(t, 0)).toBe(0);
    expect(map.spokenIndexAt(t, 6)).toBe(6);
    // Every position must survive a round trip through both directions.
    for (let i = 0; i < 11; i++) {
      const back = map.spokenIndexAt(t, i)!;
      expect(map.rangeFor(back, back + 1)!.toString()).toBe(t.data[i]);
    }
  });

  it('absorbs a skipped run', () => {
    const [t] = para('Water boils[1] at 100C') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, 'Water boils');
    b.skip(t, 11, 3);
    b.copy(t, 14, ' at 100C');
    const { text, map } = b.build();

    // DOM offset 15 is "a" of "at"; spoken index 12 is the same character.
    const spoken = map.spokenIndexAt(t, 15)!;
    expect(text.slice(spoken, spoken + 2)).toBe('at');
  });

  it('maps anywhere inside an expansion to where it begins', () => {
    const [t] = para('Use e.g. this') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, 'Use ');
    b.replace(t, 4, 4, 'for example');
    b.copy(t, 8, ' this');
    const { text, map } = b.build();

    // Clicking any character of "e.g." starts at "for example", not partway in.
    for (const offset of [4, 5, 6, 7]) {
      const spoken = map.spokenIndexAt(t, offset)!;
      expect(text.slice(spoken, spoken + 11)).toBe('for example');
    }
  });

  it('handles a position in a later text node', () => {
    const [a, bNode, c] = para('Hello <em>brave</em> world') as [Text, Text, Text];
    const b = new SpokenTextBuilder();
    b.copy(a, 0, a.data);
    b.copy(bNode, 0, bNode.data);
    b.copy(c, 0, c.data);
    const { text, map } = b.build();

    const spoken = map.spokenIndexAt(bNode, 0)!;
    expect(text.slice(spoken, spoken + 5)).toBe('brave');
  });

  it('returns null for a node the map does not cover', () => {
    const [t] = para('covered') as [Text];
    const [other] = para('elsewhere') as [Text];
    const b = new SpokenTextBuilder();
    b.copy(t, 0, t.data);
    expect(b.build().map.spokenIndexAt(other, 2)).toBeNull();
  });
});
