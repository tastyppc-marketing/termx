/**
 * Deciding when a background TermX window should flash its taskbar button.
 *
 * The naive rule — "any tab is in attention, and it was not a moment ago" —
 * latches. An attention mark is sticky until the user actually visits that
 * tab, so one finished-but-never-visited tab holds the global flag high
 * forever, and every later finish looks like "no change at all". The user then
 * sees exactly one flash ever, which reads as the feature being dead.
 *
 * So the decision is per tab: flash when a tab the user has not already been
 * told about becomes attentive. Time spent looking at the window counts as
 * being told, which keeps a tab that finished under the user's nose from
 * flashing the moment they alt-tab away.
 */
export interface AttentionFlashDecision {
  /** Ask the OS for attention now. */
  readonly flash: boolean;
  /** The tabs already announced — pass back on the next decision. */
  readonly announced: ReadonlySet<string>;
}

export function decideAttentionFlash(
  attentionTabIds: readonly string[],
  windowFocused: boolean,
  announced: ReadonlySet<string>,
): AttentionFlashDecision {
  const current = new Set(attentionTabIds);
  if (windowFocused) {
    // The window is on screen: the pulsing rail dot is the notification, and
    // whatever is marked now must not flash later just because focus moved.
    return { flash: false, announced: current };
  }
  // Dropping ids that are no longer attentive is deliberate: a tab that gets
  // visited and then finishes a second job is news again.
  return {
    flash: attentionTabIds.some((id) => !announced.has(id)),
    announced: current,
  };
}
