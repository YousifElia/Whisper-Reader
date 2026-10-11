/**
 * Panel styling, as design tokens plus one stylesheet that consumes them.
 *
 * Theme has three states, and they are not the same as two. "System" must
 * follow the OS live, while an explicit Light or Dark has to win in *both*
 * directions -- forcing light on a dark OS is just as valid as the reverse.
 * That is why the dark tokens appear twice: once behind the media query
 * (guarded so an explicit light choice overrides it) and once behind the
 * attribute. They are generated from one object so the two copies cannot
 * drift apart.
 */

import { COMPACT_HEIGHT } from './geometry';

export type ThemeChoice = 'system' | 'light' | 'dark';

const LIGHT = {
  '--fg': '#1b1b1f',
  '--bg': 'rgba(252, 251, 249, 0.97)',
  '--border': 'rgba(0, 0, 0, 0.10)',
  '--divider': 'rgba(0, 0, 0, 0.07)',
  '--hover': 'rgba(0, 0, 0, 0.07)',
  '--track': 'rgba(0, 0, 0, 0.10)',
  '--field-bg': '#ffffff',
  '--field-fg': '#1b1b1f',
  '--field-border': 'rgba(0, 0, 0, 0.18)',
  '--warn-fg': '#8a5600',
  '--warn-bg': 'rgba(240, 165, 0, 0.15)',
  '--advice-fg': '#1b1b1f',
  '--advice-bg': 'rgba(60, 130, 246, 0.10)',
  '--advice-border': 'rgba(60, 130, 246, 0.24)',
  '--shadow': '0 8px 32px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08)',
};

const DARK: typeof LIGHT = {
  '--fg': '#ececf1',
  '--bg': 'rgba(28, 28, 32, 0.97)',
  '--border': 'rgba(255, 255, 255, 0.12)',
  '--divider': 'rgba(255, 255, 255, 0.09)',
  '--hover': 'rgba(255, 255, 255, 0.10)',
  '--track': 'rgba(255, 255, 255, 0.14)',
  '--field-bg': '#2b2b31',
  '--field-fg': '#ececf1',
  '--field-border': 'rgba(255, 255, 255, 0.20)',
  '--warn-fg': '#ffce5c',
  '--warn-bg': 'rgba(240, 165, 0, 0.15)',
  '--advice-fg': '#ececf1',
  '--advice-bg': 'rgba(96, 160, 255, 0.13)',
  '--advice-border': 'rgba(96, 160, 255, 0.28)',
  '--shadow': '0 8px 32px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.30)',
};

const tokens = (set: typeof LIGHT): string =>
  Object.entries(set)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

export const PANEL_STYLES = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }

.panel {
${tokens(LIGHT)}
  --accent: #f0a500;
  --accent-hover: #ffb61a;
  --accent-ink: #21160a;
  /* Tells the platform which native widget colours to paint, which is what
     stops the <select> dropdown rendering white-on-white. */
  color-scheme: light;
}

/* System setting: follow the OS, unless light was explicitly chosen. */
@media (prefers-color-scheme: dark) {
  .panel:not([data-theme="light"]) {
${tokens(DARK)}
    color-scheme: dark;
  }
}

/* An explicit choice wins over the OS in both directions. */
.panel[data-theme="dark"] {
${tokens(DARK)}
  color-scheme: dark;
}
.panel[data-theme="light"] {
${tokens(LIGHT)}
  color-scheme: light;
}

.panel {
  position: fixed;
  display: flex;
  flex-direction: column;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(12px);
  overflow: hidden;
  z-index: 2147483647;
}

.bar {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 0 8px;
  height: ${COMPACT_HEIGHT - 2}px;
  flex: 0 0 auto;
}

.grip {
  cursor: grab;
  padding: 0 6px;
  align-self: stretch;
  display: flex;
  align-items: center;
  color: currentColor;
  opacity: 0.35;
  touch-action: none;
}
.grip:active { cursor: grabbing; }
.grip span {
  display: block;
  width: 3px; height: 3px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 5px currentColor, 0 10px currentColor,
              5px 0 currentColor, 5px 5px currentColor, 5px 10px currentColor;
  margin: 5px 0 10px;
}

button {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 8px;
  padding: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 120ms ease;
}
button:hover:not(:disabled) { background: var(--hover); }
button:disabled { opacity: 0.35; cursor: default; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button svg { width: 18px; height: 18px; display: block; }

.play { background: var(--accent); color: var(--accent-ink); }
.play:hover:not(:disabled) { background: var(--accent-hover); }
.play svg { width: 20px; height: 20px; }

/* The only flexible item, and the first to give way: at narrow widths the
   bar shrinks to nothing rather than pushing Close off the panel. */
.progress {
  flex: 1 1 auto;
  height: 4px;
  min-width: 0;
  border-radius: 2px;
  background: var(--track);
  overflow: hidden;
}
.progress > i {
  display: block;
  height: 100%;
  width: 0%;
  background: var(--accent);
  transition: width 200ms ease;
}

.readout {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  flex: none;
  min-width: 34px;
  padding: 0 3px 0 2px;
  line-height: 1.2;
}

.rate {
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  opacity: 0.75;
  text-align: right;
  white-space: nowrap;
}
.rate.remaining:empty { display: none; }

.body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 14px 14px;
  border-top: 1px solid var(--divider);
}

.field { margin-top: 14px; }
/* :not(.check) matters -- the checkbox row is also a <label>, and without the
   exclusion it inherits the uppercase section-heading treatment. */
.field > label:not(.check) {
  display: block;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.55;
  margin-bottom: 5px;
}

select, input[type="range"] { width: 100%; font: inherit; }

/*
 * The dropdown list is painted by the OS and ignores a translucent background
 * on the closed control, so both it and its options need opaque, explicitly
 * paired colours -- otherwise a light text colour lands on the system's white
 * popup and disappears.
 */
select {
  color: var(--field-fg);
  background-color: var(--field-bg);
  border: 1px solid var(--field-border);
  border-radius: 8px;
  padding: 6px 8px;
}
select option {
  color: var(--field-fg);
  background-color: var(--field-bg);
}
input[type="range"] { accent-color: var(--accent); }

.row { display: flex; align-items: center; gap: 8px; }
.row .value {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  opacity: 0.7;
  min-width: 40px;
  text-align: right;
}

.segmented {
  display: flex;
  gap: 4px;
  background: var(--track);
  border-radius: 9px;
  padding: 3px;
}
.segmented button {
  flex: 1;
  padding: 5px 6px;
  border-radius: 6px;
  font-size: 12px;
  gap: 5px;
  opacity: 0.75;
}
.segmented button[aria-pressed="true"] {
  background: var(--bg);
  opacity: 1;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
}
.segmented button svg { width: 14px; height: 14px; }

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 0;
}
.check input {
  accent-color: var(--accent);
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  margin: 0;
}

.note {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.4;
  opacity: 0.62;
}
.note.warn {
  opacity: 1;
  color: var(--warn-fg);
  background: var(--warn-bg);
  border-radius: 7px;
  padding: 6px 8px;
}

.advice {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--advice-fg);
  background: var(--advice-bg);
  border: 1px solid var(--advice-border);
  border-radius: 8px;
  padding: 9px 10px;
}
.advice strong { display: block; margin-bottom: 5px; }
.advice ol { margin: 0; padding-left: 1.15em; }
.advice li { margin: 2px 0; }

.resize {
  position: absolute;
  right: 0; bottom: 0;
  width: 16px; height: 16px;
  cursor: nwse-resize;
  touch-action: none;
}
.resize::after {
  content: "";
  position: absolute;
  right: 3px; bottom: 3px;
  width: 7px; height: 7px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  opacity: 0.3;
  border-radius: 0 0 2px 0;
}

.sr {
  position: absolute; width: 1px; height: 1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
`;
