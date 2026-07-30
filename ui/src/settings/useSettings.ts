import { useSyncExternalStore } from "react";
import type { SettingsStore } from "./SettingsStore";
import type { TermxSettings } from "./settings";

export function useSettings(store: SettingsStore): TermxSettings {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
