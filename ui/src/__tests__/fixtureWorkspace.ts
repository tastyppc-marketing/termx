import { PluginsStore } from "../plugins/registry";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";

/**
 * The stores App dereferences WITHOUT a guard, so every fixture must carry a
 * real one. Typed against the real interface on purpose: when App starts
 * reading another store unconditionally, naming it here fails to compile until
 * `fixtureWorkspace` actually builds one.
 */
type RequiredStores = Pick<BootstrappedWorkspace, "plugins">;

/**
 * The workspace an App test hands `<App bootstrap={…} />`.
 *
 * App fakes are partial by nature — a test about SSH hosts has no business
 * standing up a conversations index — so the cast is unavoidable. It lives
 * HERE, once, with the unconditional stores filled in, because the alternative
 * failed silently: App used to paper over a missing registry with a fallback
 * `new PluginsStore()`, which is a store with no `save` behind it AND a
 * different instance from the one the plugin lifecycle gates on, so Settings
 * would have written nothing and reported nothing.
 */
export function fixtureWorkspace(
  parts: Record<string, unknown> & { controller: unknown },
): BootstrappedWorkspace {
  const required: RequiredStores = { plugins: new PluginsStore() };
  // `parts` last: a test that wants to watch the registry passes its own store.
  return { ...required, ...parts } as unknown as BootstrappedWorkspace;
}
