import { describe, expect, it } from "vitest";
import { InputMarks, type InputMark } from "../inputMarks";

class FakeMark implements InputMark {
  disposed = false;

  constructor(readonly line: number) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function factoryAt(line: number): () => InputMark {
  return () => new FakeMark(line);
}

describe("InputMarks", () => {
  it("drops a mark only for input containing Enter", () => {
    const marks = new InputMarks();
    marks.onUserInput("ls", factoryAt(5));
    expect(marks.jumpPrevious(100)).toBeNull();

    marks.onUserInput("\r", factoryAt(5));
    expect(marks.jumpPrevious(100)).toBe(5);
  });

  it("skips marks when the register returns undefined (alt buffer)", () => {
    const marks = new InputMarks();
    marks.onUserInput("\r", () => undefined);
    expect(marks.jumpPrevious(100)).toBeNull();
  });

  it("dedupes repeated Enters on the same line", () => {
    const marks = new InputMarks();
    const first = new FakeMark(5);
    const second = new FakeMark(5);
    marks.onUserInput("\r", () => first);
    marks.onUserInput("\r", () => second);
    expect(second.disposed).toBe(true);
    expect(marks.jumpPrevious(100)).toBe(5);
    // Walking further stays on the only mark.
    expect(marks.jumpPrevious(5)).toBe(5);
  });

  it("first press targets the most recent mark above the viewport, then walks older", () => {
    const marks = new InputMarks();
    marks.onUserInput("\r", factoryAt(10));
    marks.onUserInput("\r", factoryAt(40));
    marks.onUserInput("\r", factoryAt(70));

    // Viewport at line 55: mark 70 is below/inside, most recent above is 40.
    expect(marks.jumpPrevious(55)).toBe(40);
    expect(marks.jumpPrevious(40)).toBe(10);
    expect(marks.jumpPrevious(10)).toBe(10);
  });

  it("scrolling back down past the last jump restarts the walk", () => {
    const marks = new InputMarks();
    marks.onUserInput("\r", factoryAt(10));
    marks.onUserInput("\r", factoryAt(40));
    marks.onUserInput("\r", factoryAt(70));

    expect(marks.jumpPrevious(90)).toBe(70);
    expect(marks.jumpPrevious(70)).toBe(40);
    // User scrolls back to the bottom (viewport far below the walk point).
    expect(marks.jumpPrevious(90)).toBe(70);
  });

  it("typing resets the walk", () => {
    const marks = new InputMarks();
    marks.onUserInput("\r", factoryAt(10));
    marks.onUserInput("\r", factoryAt(40));

    expect(marks.jumpPrevious(90)).toBe(40);
    marks.onUserInput("x", factoryAt(41));
    expect(marks.jumpPrevious(90)).toBe(40);
  });

  it("prunes disposed marks and caps the list", () => {
    const marks = new InputMarks(3);
    const first = new FakeMark(1);
    marks.onUserInput("\r", () => first);
    marks.onUserInput("\r", factoryAt(2));
    marks.onUserInput("\r", factoryAt(3));
    marks.onUserInput("\r", factoryAt(4));
    expect(first.disposed).toBe(true); // evicted by the cap

    const middle = new FakeMark(5);
    marks.onUserInput("\r", () => middle);
    middle.dispose(); // simulates scrolling out of the ring
    expect(marks.jumpPrevious(100)).toBe(4);
  });

  it("dispose releases every mark", () => {
    const marks = new InputMarks();
    const first = new FakeMark(1);
    const second = new FakeMark(2);
    marks.onUserInput("\r", () => first);
    marks.onUserInput("\r", () => second);
    marks.dispose();
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(true);
    expect(marks.jumpPrevious(100)).toBeNull();
  });
});
