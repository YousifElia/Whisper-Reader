/**
 * Keep the sentence being spoken on screen -- without fighting the reader.
 *
 * The rule that makes this feel right rather than annoying: if the user
 * scrolls, we back off entirely for a few seconds. Someone glancing up at an
 * earlier paragraph should not be yanked back down mid-glance.
 */

/** Don't scroll while the sentence sits comfortably inside this band. */
const COMFORT_MARGIN = 0.18;

/** How long a manual scroll suspends following. */
const SUSPEND_MS = 4000;

export class AutoScroller {
  private suspendUntil = 0;
  private enabled = true;

  constructor(private readonly win: Window = window) {
    // Listen for the *inputs* that scroll rather than the scroll event
    // itself: our own smooth scrolling fires scroll events too, and telling
    // the two apart afterwards is guesswork.
    win.addEventListener('wheel', this.onUserInput, { passive: true });
    win.addEventListener('touchmove', this.onUserInput, { passive: true });
    win.addEventListener('keydown', this.onKeyDown, { passive: true });
  }

  private onUserInput = (): void => {
    this.suspendUntil = Date.now() + SUSPEND_MS;
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'PageUp':
      case 'PageDown':
      case 'Home':
      case 'End':
      case 'ArrowUp':
      case 'ArrowDown':
        this.onUserInput();
        break;
      default:
        break;
    }
  };

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Called when the active sentence changes. */
  follow(range: Range | null): void {
    if (!this.enabled || !range) return;
    if (Date.now() < this.suspendUntil) return;

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const height = this.win.innerHeight;
    const margin = height * COMFORT_MARGIN;

    // Already comfortably in view: leave the page where the reader put it.
    if (rect.top >= margin && rect.bottom <= height - margin) return;

    const reduceMotion = this.win.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    const target = this.win.scrollY + rect.top - (height - rect.height) / 2;
    this.win.scrollTo({
      top: Math.max(0, target),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }

  destroy(): void {
    this.win.removeEventListener('wheel', this.onUserInput);
    this.win.removeEventListener('touchmove', this.onUserInput);
    this.win.removeEventListener('keydown', this.onKeyDown);
  }
}
