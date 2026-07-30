/**
 * Jump-to-last-input (spec F4): every Enter pressed into a pane drops an
 * xterm marker at the buffer line it was typed on; Ctrl+Shift+J walks the
 * viewport back through those markers. Keyed off the user's keystrokes, not
 * shell output, so it works identically in a plain prompt and inside a
 * streaming TUI like Claude Code.
 *
 * Pure over an injected marker factory; xterm specifics live in the pane's
 * presentation layer.
 */

export interface InputMark {
  /** Absolute buffer line (xterm IMarker.line). */
  readonly line: number;
  /** True once the line scrolled out of the scrollback ring. */
  readonly isDisposed: boolean;
  dispose(): void;
}

export class InputMarks {
  private marks: InputMark[] = [];
  private walkMark: InputMark | null = null;

  constructor(private readonly cap = 100) {}

  /** Feed every chunk of user keystrokes; Enter (\r) drops a mark. */
  onUserInput(data: string, register: () => InputMark | undefined): void {
    this.walkMark = null; // typing resumes normal scrolling behavior
    if (!data.includes("\r")) {
      return;
    }
    const mark = register(); // undefined in the alternate screen buffer
    if (!mark) {
      return;
    }
    const last = this.marks[this.marks.length - 1];
    if (last && !last.isDisposed && last.line === mark.line) {
      mark.dispose(); // several Enters on one prompt line = one mark
      return;
    }
    this.marks.push(mark);
    while (this.marks.length > this.cap) {
      this.marks.shift()?.dispose();
    }
  }

  /**
   * The line to scroll to, or null when there is nothing to jump to.
   * First press (or a press after scrolling back down past the last jump)
   * targets the most recent mark above the viewport; repeated presses walk
   * to older marks.
   */
  jumpPrevious(viewportTop: number): number | null {
    this.marks = this.marks.filter((mark) => !mark.isDisposed);
    if (this.marks.length === 0) {
      this.walkMark = null;
      return null;
    }
    const walkIndex = this.walkMark ? this.marks.indexOf(this.walkMark) : -1;
    let index: number;
    if (walkIndex === -1 || viewportTop > this.marks[walkIndex]!.line + 1) {
      index = this.marks.length - 1;
      while (index > 0 && this.marks[index]!.line >= viewportTop) {
        index -= 1;
      }
    } else {
      index = Math.max(0, walkIndex - 1);
    }
    this.walkMark = this.marks[index]!;
    return this.walkMark.line;
  }

  dispose(): void {
    for (const mark of this.marks.splice(0)) {
      try {
        mark.dispose();
      } catch {
        // xterm already disposed it with the buffer; nothing to release.
      }
    }
    this.walkMark = null;
  }
}
