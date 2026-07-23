/**
 * Native OS folder picker via tauri-plugin-dialog.
 *
 * Production uses `@tauri-apps/plugin-dialog`; tests inject a stub picker so
 * Vitest never touches the real OS dialog.
 */

export interface PickFolderOptions {
  /** Dialog title (platform-dependent; may be ignored on some hosts). */
  title?: string;
  /** Initial directory when the platform supports it. */
  defaultPath?: string;
}

/** Returns an absolute folder path, or null if the user cancelled. */
export type FolderPicker = (
  options?: PickFolderOptions,
) => Promise<string | null>;

/**
 * Open a single-folder picker. Returns null on cancel.
 * Inject `picker` in tests; omit in the app to use the Tauri dialog plugin.
 */
export async function pickFolder(
  options: PickFolderOptions = {},
  picker: FolderPicker = defaultFolderPicker,
): Promise<string | null> {
  return picker(options);
}

async function defaultFolderPicker(
  options: PickFolderOptions = {},
): Promise<string | null> {
  // Dynamic import keeps the module importable under Vitest/jsdom without a
  // live Tauri IPC bridge (tests always inject their own picker).
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: options.title,
    defaultPath: options.defaultPath,
  });

  if (selected === null) {
    return null;
  }
  if (Array.isArray(selected)) {
    // multiple:false should never yield an array; treat empty as cancel.
    return selected[0] ?? null;
  }
  if (typeof selected !== "string" || selected.length === 0) {
    return null;
  }
  return selected;
}
