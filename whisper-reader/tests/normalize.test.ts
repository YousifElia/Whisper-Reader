import { describe, it, expect, beforeEach } from 'vitest';
import { SpokenTextBuilder } from '../lib/extract/offsets';
import { appendTextNode, normalizeElement } from '../lib/extract/normalize';

/** Run one text node through the normaliser and return both halves of the
 *  join, so every assertion can check the string AND the mapping. */
function run(raw: string) {
  const p = document.createElement('p');
  p.textContent = raw;
  document.body.appendChild(p);

  const node = p.firstChild as Text;
  const builder = new SpokenTextBuilder();
  appendTextNode(node, builder);
  const { text, map } = builder.build();

  return {
    text,
    map,
    /** What the DOM shows for a spoken span. */
    domFor: (start: number, end: number) =>
      map.rangeFor(start, end)?.toString() ?? null,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('whitespace', () => {
  it('collapses runs and drops leading space', () => {
    expect(run('   one   two  ').text).toBe('one two ');
  });

  it('keeps a plain single space as a real DOM character', () => {
    const { domFor } = run('one two');
    expect(domFor(0, 7)).toBe('one two');
  });

  it('collapses newlines and tabs to one space', () => {
    expect(run('one\n\t  two').text).toBe('one two');
  });
});

describe('invisible characters', () => {
  it('drops zero-width and soft-hyphen characters', () => {
    const { text } = run('re­sume​now');
    expect(text).toBe('resumenow');
  });
});

describe('footnote markers', () => {
  it('strips numeric references and keeps offsets straight', () => {
    const { text, domFor } = run('Water boils[1] at 100 degrees.');
    expect(text).toBe('Water boils at 100 degrees.');
    // "at" sits at spoken 12 but DOM 15; the mapping absorbs the gap.
    expect(domFor(12, 14)).toBe('at');
  });

  it('strips editorial markers', () => {
    expect(run('Section[edit] follows').text).toBe('Section follows');
    expect(run('Claimed[citation needed] here').text).toBe('Claimed here');
  });

  it('leaves ordinary bracketed text alone', () => {
    expect(run('an array[index] lookup').text).toBe('an array[index] lookup');
  });
});

describe('urls', () => {
  it('says "link" instead of spelling out the address', () => {
    const { text, domFor } = run('See https://example.com/a/b?c=1 today');
    expect(text).toBe('See link today');
    // The spoken word maps back onto the whole URL, so highlighting the word
    // "link" lights up the address the listener is hearing about.
    expect(domFor(4, 8)).toBe('https://example.com/a/b?c=1');
  });

  it('can read the address verbatim when asked', () => {
    const p = document.createElement('p');
    p.textContent = 'at https://ex.com now';
    document.body.appendChild(p);
    const b = new SpokenTextBuilder();
    appendTextNode(p.firstChild as Text, b, {
      expandAbbreviations: true,
      stripFootnoteMarkers: true,
      urls: 'read',
    });
    expect(b.build().text).toBe('at https://ex.com now');
  });
});

describe('abbreviations', () => {
  it('expands titles and removes the false sentence break', () => {
    const { text } = run('Dr. Chen arrived.');
    expect(text).toBe('Doctor Chen arrived.');
  });

  it('maps an expansion back onto its source span', () => {
    const { text, domFor } = run('Use e.g. this');
    expect(text).toBe('Use for example this');
    expect(domFor(4, 15)).toBe('e.g.');
    expect(domFor(16, 20)).toBe('this');
  });

  it('keeps the period when the abbreviation ended the sentence', () => {
    // "etc." before a capital was doing double duty; dropping the period
    // would silently merge two sentences into one.
    expect(run('Apples, pears, etc. Then we left.').text).toBe(
      'Apples, pears, et cetera. Then we left.',
    );
  });

  it('drops the period mid-sentence', () => {
    expect(run('Apples, pears, etc. and more').text).toBe(
      'Apples, pears, et cetera and more',
    );
  });

  it('does not match inside a longer word', () => {
    expect(run('Drive to Mrs. Patel').text).toBe('Drive to Missus Patel');
  });

  it('can be turned off', () => {
    const p = document.createElement('p');
    p.textContent = 'Dr. Chen';
    document.body.appendChild(p);
    const b = new SpokenTextBuilder();
    appendTextNode(p.firstChild as Text, b, {
      expandAbbreviations: false,
      stripFootnoteMarkers: true,
      urls: 'link',
    });
    expect(b.build().text).toBe('Dr. Chen');
  });
});

describe('normalizeElement', () => {
  it('collapses whitespace across element boundaries', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Hello <em>brave</em>   world';
    document.body.appendChild(p);

    const nodes: Text[] = [];
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) nodes.push(n as Text);

    const { text, map } = normalizeElement(nodes);
    expect(text).toBe('Hello brave world');
    expect(map.rangeFor(6, 11)!.toString()).toBe('brave');
  });

  it('trims the trailing space a block would otherwise end on', () => {
    const p = document.createElement('p');
    p.textContent = 'trailing   ';
    document.body.appendChild(p);
    expect(normalizeElement([p.firstChild as Text]).text).toBe('trailing');
  });
});
