import { PluginsStore } from "../plugins/registry";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";

/**
 * The stores App dereferences WITHOUT a guard, so every fixture must carry a
 * real one. Typed against the real interface on purpose: when App starts
 * reading another store unconditionally, naming it here fails to compile until
 * `fixtureWorkspace` actually builds one.
 */
type RequiredStores = Pick<BootstrappedWorkspace, "plugins" | "subscribeManifests">;

/**
 * A controllable stand-in for bootstrap's "the manifest cache moved" feed.
 *
 * Bootstrap resolves folder manifests asynchronously — after the boot budget,
 * or a debounce past a registry change — so a test has to be able to say WHEN
 * that lands, and to check that App let go of the feed on unmount.
 */
export interface ManifestFeed {
  subscribeManifests: (listener: () => void) => () => void;
  /** Announce a cache landing to every attached listener. */
  emit(): void;
  /** Listeners still attached — 0 once the App that subscribed has unmounted. */
  listenerCount(): number;
}

export function manifestFeed(): ManifestFeed {
  const listeners = new Set<() => void>();
  return {
    subscribeManifests: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

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
  const required: RequiredStores = {
    plugins: new PluginsStore(),
    // A feed nothing ever fires: a fixture that does not care about manifest
    // timing still has to hand App something real to subscribe to.
    subscribeManifests: manifestFeed().subscribeManifests,
  };
  // `parts` last: a test that wants to watch the registry passes its own store.
  return { ...required, ...parts } as unknown as BootstrappedWorkspace;
}
