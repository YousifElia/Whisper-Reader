import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  srcDir: '.',
  outDir: '.output',

  // WXT still defaults Firefox to MV2. We want MV3 on both so there is one
  // background model, one permission model, and one set of bugs to reason
  // about rather than two.
  manifestVersion: 3,

  // Vite's module-preload polyfill calls fetch() on the extension's own
  // packaged files. Harmless, but it puts a `fetch(` in a bundle that
  // otherwise makes no requests at all, which is exactly the kind of thing a
  // store reviewer greps for. The popup is three small files; preloading buys
  // nothing here.
  vite: () => ({
    build: { modulePreload: false },
  }),

  // AMO requires the source for any minified/bundled submission, and the
  // archive should contain only what a reviewer needs to rebuild it. These are
  // generated files or disabled experiments -- shipping them makes a source
  // archive look like it contains build output, which invites questions.
  zip: {
    excludeSources: [
      'tests/harness/dist/**',
      'tests/harness/icon/**',
      'tests/harness/public/**',
      '**/*.disabled',
      '.output/**',
      // Store media and the tooling that renders it: about 8 MB that plays no
      // part in building the extension a reviewer is rebuilding.
      'assets/**',
      'scripts/media/**',
      'brag-output*/**',
    ],
  },

  manifest: ({ browser }) => ({
    name: 'Whisper Reader',
    description:
      'Reads the page aloud in a calm voice and highlights the words as it goes.',
    version: '0.1.0',

    // activeTab covers our click/hotkey invocation model. <all_urls> is
    // deliberately optional-only: it is requested at runtime for the
    // "auto-start on this site" feature, so a default install asks for nothing
    // scary and both store reviews stay simple.
    // Every one of these is exercised: storage for preferences and reading
    // positions, activeTab + scripting for the on-demand injection, and
    // contextMenus for the two right-click entries.
    //
    // <all_urls> used to sit in optional_host_permissions for a planned
    // "auto-start on this site" feature that was never built. Nothing requests
    // it, and a store listing that declares access it never uses is exactly
    // what the review guidance tells you to remove.
    permissions: ['storage', 'activeTab', 'scripting', 'contextMenus'],

    // Deliberately no 'wasm-unsafe-eval'. It was here for the on-device neural
    // voice, which was measured and abandoned (see the README), and shipping a
    // CSP relaxation nothing uses is exactly what store reviewers ask about.
    // Restore it only if WASM inference is ever revisited.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },

    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+R' },
        description: 'Open Whisper Reader',
      },
      'toggle-play': {
        suggested_key: { default: 'Alt+Shift+P' },
        description: 'Play / pause reading',
      },
      'read-selection': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Read the selected text',
      },
      // Note: hold-to-boost is deliberately NOT a command. The commands API
      // fires once with no keyup event, so press-and-hold is handled by a
      // content-script keydown/keyup listener instead.
    },

    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'whisper-reader@yousif.dev',
              strict_min_version: '115.0',
              // Required by AMO for new extensions since 3 Nov 2025. A
              // default install genuinely collects nothing: tier 1 speaks
              // entirely on-device. If the cloud tier ships, this becomes an
              // honest disclosure rather than a formality.
              data_collection_permissions: {
                required: ['none'],
              },
            },
          },
        }
      : {}),
  }),
});
