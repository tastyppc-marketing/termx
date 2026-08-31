/**
 * The on/off control shared by the settings field list and the Plugins panel.
 *
 * It lives in its own module rather than in `SettingsSurface` because both of
 * those import it and `SettingsSurface` also imports `PluginsPanel`: the cycle
 * resolves by load order today, but it breaks the moment a test mocks either
 * side. A leaf module has no such ordering to get wrong.
 *
 * Markup is deliberately `.settings-check` reusing `.settings-radio__text` —
 * the checkbox and the radio ladder are the same row, one control apart.
 */
export function Toggle({
  name,
  label,
  hint,
  checked,
  disabled = false,
  ariaLabel,
  onToggle,
}: {
  name: string;
  label: string;
  /**
   * Optional, and only optional for the Plugins panel: in a dense plugin row
   * the label carries the meaning and a second line would push the row off its
   * rhythm. Every settings field passes one.
   */
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  /**
   * Overrides the visible label for assistive tech. Needed where the same
   * word ("Enabled") repeats down a list and the row, not the label, says
   * which thing is being switched.
   */
  ariaLabel?: string;
  onToggle(checked: boolean): void;
}) {
  return (
    <label className="settings-check">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        disabled={disabled}
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
        onChange={(event) => onToggle(event.currentTarget.checked)}
      />
      <span className="settings-radio__text">
        <span className="settings-radio__label">{label}</span>
        {hint === undefined ? null : (
          <span className="settings-radio__hint">{hint}</span>
        )}
      </span>
    </label>
  );
}
