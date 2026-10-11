import { describe, it, expect, beforeEach } from 'vitest';
import {
  collectDocument,
  blockBoundary,
  DEFAULT_COLLECT_OPTIONS,
  type ReaderDocument,
} from '../lib/extract/collector';

/** Collapse whitespace so DOM text and spoken text can be compared without
 *  tripping over source-code indentation. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const ARTICLE = `
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <header><h1>Site title that should not be read</h1></header>
  <main>
    <h2>The kettle</h2>
    <p>Water boils at one hundred degrees. That is a fact about pressure.</p>
    <p>A second paragraph sits here. It has two sentences.</p>
    <blockquote>
      <p>Quoted text lives inside a paragraph inside a quote.</p>
    </blockquote>
    <ul>
      <li>First item</li>
      <li>Second item
        <ul><li>Nested item</li></ul>
      </li>
    </ul>
    <p style="display:none">Hidden paragraph must never be spoken.</p>
    <p aria-hidden="true">Aria hidden paragraph.</p>
    <pre><code>const x = 1;</code></pre>
    <script>var evil = "do not read me";</script>
    <style>.a { color: red }</style>
    <figure><figcaption>A caption.</figcaption></figure>
  </main>
  <aside><p>Related links you should not hear.</p></aside>
  <footer><p>Copyright notice.</p></footer>
`;

function load(html: string): ReaderDocument {
  document.body.innerHTML = html;
  return collectDocument(document);
}

/** All spoken text joined, for coarse presence/absence assertions. */
const allText = (m: ReaderDocument) => m.blocks.map((b) => b.text).join(' | ');

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.lang = 'en';
});

describe('what gets read', () => {
  it('excludes page furniture, scripts and styles', () => {
    const text = allText(load(ARTICLE));

    expect(text).not.toContain('Home');
    expect(text).not.toContain('Site title');
    expect(text).not.toContain('Related links');
    expect(text).not.toContain('Copyright');
    expect(text).not.toContain('do not read me');
    expect(text).not.toContain('color: red');
  });

  it('excludes hidden content', () => {
    const text = allText(load(ARTICLE));
    expect(text).not.toContain('Hidden paragraph');
    expect(text).not.toContain('Aria hidden');
  });

  it('skips code by default', () => {
    expect(allText(load(ARTICLE))).not.toContain('const x');
  });

  it('reads code when asked to', () => {
    document.body.innerHTML = ARTICLE;
    const model = collectDocument(document, {
      ...DEFAULT_COLLECT_OPTIONS,
      code: 'read',
    });
    expect(allText(model)).toContain('const x');
  });

  it('includes the article prose, headings, list items and captions', () => {
    const text = allText(load(ARTICLE));
    expect(text).toContain('The kettle');
    expect(text).toContain('Water boils');
    expect(text).toContain('First item');
    expect(text).toContain('Nested item');
    expect(text).toContain('A caption.');
    expect(text).toContain('Quoted text');
  });
});

describe('block structure', () => {
  it('reads nested blocks exactly once', () => {
    const model = load(ARTICLE);
    const joined = allText(model);

    // "Quoted text" lives in a <p> inside a <blockquote>. A selector-based
    // collector would emit it twice, once per ancestor.
    expect(joined.match(/Quoted text/g)).toHaveLength(1);
    // Same trap for a <li> nested inside another <li>.
    expect(joined.match(/Nested item/g)).toHaveLength(1);

    // The outer list item keeps its own text but not its child's.
    const second = model.blocks.find((b) => b.text.startsWith('Second item'));
    expect(second?.text).toBe('Second item');
  });

  it('preserves document order', () => {
    const model = load(ARTICLE);
    const order = model.blocks.map((b) => b.text);
    expect(order.findIndex((t) => t.includes('The kettle'))).toBeLessThan(
      order.findIndex((t) => t.includes('Water boils')),
    );
    expect(order.findIndex((t) => t.includes('Water boils'))).toBeLessThan(
      order.findIndex((t) => t.includes('second paragraph')),
    );
  });

  it('tags headings with their level', () => {
    const model = load(ARTICLE);
    const heading = model.blocks.find((b) => b.text === 'The kettle');
    expect(heading?.kind).toBe('heading');
    expect(heading?.level).toBe(2);
  });

  it('flattens sentences across blocks in reading order', () => {
    const model = load(ARTICLE);
    expect(model.sentences.length).toBeGreaterThan(model.blocks.length);
    for (let i = 1; i < model.sentences.length; i++) {
      expect(model.sentences[i]!.blockId).toBeGreaterThanOrEqual(
        model.sentences[i - 1]!.blockId,
      );
    }
  });
});

describe('sentence to DOM round trip', () => {
  it('resolves every sentence in the page to a live Range', () => {
    const model = load(ARTICLE);
    expect(model.sentences.length).toBeGreaterThan(5);

    for (const ref of model.sentences) {
      const block = model.blocks[ref.blockId]!;
      const range = block.map.rangeFor(ref.span.start, ref.span.end);
      expect(range, `no range for "${block.text.slice(ref.span.start, ref.span.end)}"`).not.toBeNull();
      expect(range!.toString().length).toBeGreaterThan(0);
    }
  });

  it('lands on exactly the right characters for plain prose', () => {
    const model = load(
      '<main><p>Water boils at one hundred degrees. That is a fact.</p></main>',
    );
    const block = model.blocks[0]!;
    expect(block.sentences).toHaveLength(2);

    const [first, second] = block.sentences as [
      { start: number; end: number },
      { start: number; end: number },
    ];
    expect(norm(block.map.rangeFor(first.start, first.end)!.toString())).toBe(
      'Water boils at one hundred degrees.',
    );
    expect(norm(block.map.rangeFor(second.start, second.end)!.toString())).toBe(
      'That is a fact.',
    );
  });

  it('spans inline markup inside a sentence', () => {
    const model = load(
      '<main><p>The <em>quick</em> brown <strong>fox</strong> jumps.</p></main>',
    );
    const block = model.blocks[0]!;
    expect(block.text).toBe('The quick brown fox jumps.');

    const span = block.sentences[0]!;
    expect(norm(block.map.rangeFor(span.start, span.end)!.toString())).toBe(
      'The quick brown fox jumps.',
    );
  });
});

describe('paragraph navigation', () => {
  const model = () =>
    load(
      '<main><p>A one. A two.</p><p>B one. B two.</p><p>C one.</p></main>',
    );

  it('jumps forward to the first sentence of the next block', () => {
    const m = model();
    expect(blockBoundary(m, 0, 1)).toBe(2); // "B one."
    expect(m.sentences[2]!.blockId).toBe(1);
    expect(m.sentences[2]!.indexInBlock).toBe(0);
  });

  it('jumps back to the START of the previous block, not its end', () => {
    const m = model();
    // From "B two." (index 3), back should land on "A one.", not "A two." --
    // that is what "go back a paragraph" means to someone listening.
    expect(blockBoundary(m, 3, -1)).toBe(0);
  });

  it('clamps at both ends instead of running off', () => {
    const m = model();
    expect(blockBoundary(m, 0, -1)).toBe(0);
    expect(blockBoundary(m, m.sentences.length - 1, 1)).toBe(
      m.sentences.length - 1,
    );
  });
});

describe('degenerate pages', () => {
  it('returns an empty model for a page with no prose', () => {
    const m = load('<main><script>x()</script></main>');
    expect(m.blocks).toEqual([]);
    expect(m.sentences).toEqual([]);
  });

  it('falls back to body when there is no article or main', () => {
    const m = load('<div><p>Loose paragraph with enough words.</p></div>');
    expect(allText(m)).toContain('Loose paragraph');
  });

  it('carries the document language through to blocks', () => {
    document.documentElement.lang = 'fr';
    const m = load('<main><p>Bonjour tout le monde.</p></main>');
    expect(m.lang).toBe('fr');
    expect(m.blocks[0]!.lang).toBe('fr');
  });

  it('honours a per-element lang override', () => {
    const m = load(
      '<main><p lang="de">Guten Tag zusammen.</p></main>',
    );
    expect(m.blocks[0]!.lang).toBe('de');
  });
});

describe('display: contents must not be treated as hidden', () => {
  it('reads prose wrapped in a display:contents element', () => {
    // Tailwind's `contents` class, and the shape that silently swallowed whole
    // articles on React sites: the wrapper generates no box, its children do.
    const model = load(
      '<main><div style="display:contents">' +
        '<p>Knowing how sliding window works is one skill entirely.</p>' +
        '<p>Recognising when to reach for it is another skill.</p>' +
        '</div></main>',
    );
    const text = allText(model);
    expect(text).toContain('sliding window');
    expect(text).toContain('Recognising when to reach');
    expect(model.blocks).toHaveLength(2);
  });

  it('still drops genuinely hidden content around it', () => {
    const model = load(
      '<main>' +
        '<div style="display:contents"><p>Visible prose here.</p></div>' +
        '<div style="display:none"><p>Hidden prose here.</p></div>' +
        '<p style="visibility:hidden">Invisible prose here.</p>' +
        '</main>',
    );
    const text = allText(model);
    expect(text).toContain('Visible prose');
    expect(text).not.toContain('Hidden prose');
    expect(text).not.toContain('Invisible prose');
  });

  it('reports why text was dropped through the trace hook', () => {
    document.body.innerHTML =
      '<main><p>Kept.</p><p style="display:none">Dropped.</p></main>';
    const reasons: string[] = [];
    collectDocument(document, {
      ...DEFAULT_COLLECT_OPTIONS,
      trace: (reason) => reasons.push(reason),
    });
    expect(reasons).toContain('display-none');
  });
});

describe('inline code is prose, block code is not', () => {
  it('reads inline <code> inside a sentence', () => {
    // Dropping it left holes in the sentence on every technical page.
    const model = load(
      '<main><p>The <code>paused</code> property returns a boolean.</p></main>',
    );
    expect(allText(model)).toBe('The paused property returns a boolean.');
  });

  it('still skips a <pre> block', () => {
    const model = load(
      '<main><p>Before.</p><pre><code>const x = 1;</code></pre><p>After.</p></main>',
    );
    const text = allText(model);
    expect(text).toContain('Before.');
    expect(text).toContain('After.');
    expect(text).not.toContain('const x');
  });

  it('skips <code> nested inside <pre> via the ancestor chain', () => {
    const model = load('<main><pre><code>rm -rf node_modules</code></pre></main>');
    expect(allText(model)).not.toContain('node_modules');
  });
});

describe('root choice', () => {
  it('falls back to body when the landmark is a thin wrapper', () => {
    // App-style layouts sometimes wrap <main> around a shell of controls while
    // the prose lives elsewhere. The landmark passes findRoot's raw-text bar,
    // but everything in it is chrome, so it collects nothing.
    const shell =
      '<main><nav>Home Pricing Docs Blog Careers Support Changelog Status</nav>' +
      '<button>Open the sidebar navigation menu for this documentation site</button>' +
      '<button>Toggle the colour theme between light and dark appearance</button>' +
      '</main>';
    const prose = 'The article body sits outside the landmark entirely. '.repeat(12);
    const model = load(`${shell}<div class="content"><p>${prose}</p></div>`);
    expect(allText(model)).toContain('article body sits outside');
  });

  it('keeps using the landmark when it genuinely holds the article', () => {
    const prose = 'Real article prose lives inside the landmark here. '.repeat(12);
    const model = load(
      `<main><p>${prose}</p></main><footer><p>Copyright notice.</p></footer>`,
    );
    const text = allText(model);
    expect(text).toContain('Real article prose');
    // The fallback must not kick in and drag the footer back in with it.
    expect(text).not.toContain('Copyright notice');
  });

  it('reads a page with no landmark at all', () => {
    // The shape of the site the user reported: no article, no main, no role.
    const model = load(
      '<div><div><p>Knowing how sliding window works is one skill.</p>' +
        '<p>Recognising when to use it is another skill entirely.</p></div></div>',
    );
    expect(allText(model)).toContain('sliding window');
    expect(allText(model)).toContain('Recognising when to use it');
  });
});

describe('article titles wrapped in <header>', () => {
  it('reads an h1 inside a header when there is no landmark', () => {
    // The shape on the reported site: no <main>, so we fall back to <body>
    // and header filtering would otherwise eat the article's own title.
    const model = load(
      '<header><h1>How to Identify Which Pattern to Use</h1></header>' +
        '<div><p>Knowing how sliding window works is one skill entirely.</p></div>',
    );
    expect(allText(model)).toContain('How to Identify Which Pattern');
  });

  it('still drops a header that is only navigation', () => {
    const model = load(
      '<header><a href="/">Home</a><a href="/pricing">Pricing</a></header>' +
        '<div><p>Real prose that should be read aloud by the reader.</p></div>',
    );
    const text = allText(model);
    expect(text).not.toContain('Pricing');
    expect(text).toContain('Real prose');
  });

  it('never exempts a footer', () => {
    const model = load(
      '<div><p>Real prose that should be read aloud by the reader.</p></div>' +
        '<footer><h1>Site Name</h1><p>Copyright notice.</p></footer>',
    );
    expect(allText(model)).not.toContain('Copyright notice');
  });
});

describe('trustEverything (selection reading)', () => {
  it('reads text the normal filters would reject', () => {
    // A selection is the user telling us exactly what they want read, so it
    // must survive every heuristic -- including ones that got the site wrong.
    document.body.innerHTML =
      '<nav><p>Text inside navigation that a page read would skip.</p></nav>';
    const nav = document.querySelector('nav')!;

    const normal = collectDocument(document, {
      ...DEFAULT_COLLECT_OPTIONS,
      root: nav,
    });
    expect(normal.blocks.map((b) => b.text).join(' ')).not.toContain(
      'inside navigation',
    );

    const trusted = collectDocument(document, {
      ...DEFAULT_COLLECT_OPTIONS,
      root: nav,
      trustEverything: true,
    });
    expect(trusted.blocks.map((b) => b.text).join(' ')).toContain(
      'inside navigation',
    );
  });

  it('reads a hidden-by-CSS selection too', () => {
    document.body.innerHTML =
      '<div id="t" aria-hidden="true"><p>Aria hidden but explicitly selected.</p></div>';
    const root = document.getElementById('t')!;
    const trusted = collectDocument(document, {
      ...DEFAULT_COLLECT_OPTIONS,
      root,
      trustEverything: true,
    });
    expect(trusted.blocks.map((b) => b.text).join(' ')).toContain(
      'explicitly selected',
    );
  });

  it('never reads our own UI, even when trusting everything', () => {
    // The one exemption that must survive: the reader must not read itself.
    document.body.innerHTML =
      '<div id="t"><p>Real prose.</p>' +
      '<div data-whisper-reader="panel"><p>Hold to fast forward</p></div></div>';
    const root = document.getElementById('t')!;
    const trusted = collectDocument(document, {
      ...DEFAULT_COLLECT_OPTIONS,
      root,
      trustEverything: true,
    });
    const text = trusted.blocks.map((b) => b.text).join(' ');
    expect(text).toContain('Real prose');
    expect(text).not.toContain('fast forward');
  });

  it('never reads scripts, even when trusting everything', () => {
    document.body.innerHTML =
      '<div id="t"><p>Real prose here.</p><script>var x = "do not read";</script></div>';
    const root = document.getElementById('t')!;
    const trusted = collectDocument(document, {
      ...DEFAULT_COLLECT_OPTIONS,
      root,
      trustEverything: true,
    });
    expect(trusted.blocks.map((b) => b.text).join(' ')).not.toContain(
      'do not read',
    );
  });
});
