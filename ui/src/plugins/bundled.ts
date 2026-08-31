import type { PluginManifest } from "./manifest";

/**
 * Bundled metadata makes first-party plugins discoverable without writing into
 * their repositories. Machine-specific plugin paths remain registry data.
 */
export const BUNDLED_MANIFESTS: Record<string, PluginManifest> = {
  showroom: {
    manifest: 1,
    id: "showroom",
    name: "Showroom",
    icon: "🖼",
    start: { command: "node", args: ["server/showroom.js"] },
    singleton: true,
    discovery: {
      runtimeFile: "%APPDATA%\\Showroom\\runtime.json",
      healthPath: "/api/health",
    },
    panel: { path: "/" },
  },
};
