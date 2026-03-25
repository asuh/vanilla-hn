/* Entry point for vanilla-hn
 *
 * Responsibilities:
 * - Lazy-load runtime modules (router, stores, services, views) so the initial
 *   bootstrap remains small and tolerant of missing dev-only modules.
 * - Instantiate core stores and services.
 * - Register routes with the router (using lazy factories that import views).
 * - Mount and focus the app shell.
 *
 * This file assumes ES modules are supported by the target browser (type="module").
 * It intentionally uses dynamic import() for most modules so the app can still
 * show helpful fallback content in index.html if the dev server is misconfigured.
 */

(async function bootstrap() {
  // Graceful failure: if any of the dynamic imports fail, the fallback UI in index.html
  // will remain visible and an explanatory console message will be printed.
  try {
    const [{ default: Router }] = await Promise.all(
      [import("./router/Router.js")].map((p) =>
        p.catch((e) => {
          throw e;
        }),
      ),
    );

    // Lazy-load stores and services so they're not required unless main runs.
    const [
      { default: SettingsStore },
      { default: ReadStoriesStore },
      { default: StoryCommentThreadStore, loadState: loadThreadState },
      { default: HNService },
    ] = await Promise.all([
      import("./stores/SettingsStore.js"),
      import("./stores/ReadStoriesStore.js"),
      import("./stores/StoryCommentThreadStore.js"),
      import("./api/hn-service.js"),
    ]).catch((err) => {
      // Surface a clear message if one of the core files couldn't be loaded.
      console.error(
        "Failed to load core modules (stores/services). Ensure files exist under src/.",
        err,
      );
      throw err;
    });

    // Instantiate singletons
    const settingsStore = new SettingsStore();
    const readStoriesStore = new ReadStoriesStore();

    /**
     * Per-story thread store factory.
     *
     * StoryCommentThreadStore is now a per-story instance (keyed by storyId).
     * Views should call `createThreadStore(storyId)` when mounting a story page
     * and call `store.dispose()` when unmounting.
     *
     * `loadThreadState(storyId)` is also exposed so list views can read the
     * persisted commentCount / maxCommentId without creating a full store.
     */
    function createThreadStore(storyId, options = {}) {
      return new StoryCommentThreadStore(storyId, options);
    }

    const hnService = new HNService({
      // HNService should read configuration from environment or gracefully operate in a mock mode
      // For production, users must supply their Firebase config via a separate file or runtime injection.
      // We intentionally pass no secrets here.
    });

    // Apply theme immediately (in case SettingsStore reads persisted preferences).
    try {
      settingsStore.applyTheme();
    } catch (err) {
      // Non-fatal — continue
      console.warn("Applying theme failed:", err);
    }

    // Create the router and register routes with lazy-loading view factories.
    const router = new Router({
      mountPoint: "#app",
    });

    /**
     * Helper that returns a factory which lazy-imports a view module and
     * returns a view instance. The view module is expected to export a default
     * class or factory function which accepts an options object:
     *
     *   new ListView({ params, services, stores })
     *
     */
    function lazyView(viewPath, opts = {}) {
      return async function viewFactory(params) {
        const module = await import(viewPath);
        const ViewCtor = module.default;
        if (typeof ViewCtor !== "function") {
          throw new Error(
            `View at ${viewPath} does not export a default constructor/function`,
          );
        }
        // Provide commonly needed context to views
        const context = {
          params,
          services: { hnService },
          stores: {
            settingsStore,
            readStoriesStore,
            createThreadStore,
            loadThreadState,
          },
          ...opts,
        };
        return new ViewCtor(context);
      };
    }

    // Register list routes with a small param indicating list type
    router.register(
      /^#?\/?$/,
      lazyView("./views/ListView.js", { listType: "top" }),
    );
    router.register(
      /^#?\/newest$/,
      lazyView("./views/ListView.js", { listType: "newest" }),
    );
    router.register(
      /^#?\/ask$/,
      lazyView("./views/ListView.js", { listType: "ask" }),
    );
    router.register(
      /^#?\/show$/,
      lazyView("./views/ListView.js", { listType: "show" }),
    );
    router.register(
      /^#?\/jobs$/,
      lazyView("./views/ListView.js", { listType: "jobs" }),
    );

    // Item view: expects param extraction done by the Router (or viewFactory receives raw hash)
    // Here we register a simple matcher that extracts numeric id from the hash like #/item/12345
    router.register(/^#?\/item\/(\d+)$/, async (hashMatch) => {
      const params = { id: String(hashMatch[1]) };
      const viewFactory = lazyView("./views/ItemView.js");
      return await viewFactory(params);
    });

    // User view route
    router.register(/^#?\/user\/([\w-]+)$/, async (hashMatch) => {
      const params = { id: String(hashMatch[1]) };
      const viewFactory = lazyView("./views/UserView.js");
      return await viewFactory(params);
    });

    // Fallback route: show top list (or a very small not-found view)
    router.setNotFound(async () => {
      const module = await import("./views/ListView.js");
      const ViewCtor = module.default;
      return new ViewCtor({
        params: {},
        stores: {
          settingsStore,
          readStoriesStore,
          createThreadStore,
          loadThreadState,
        },
        services: { hnService },
        listType: "top",
      });
    });

    // Basic keyboard helpers: jump to main app region with 's' (for "skip")
    // and focus the search/filter input if a view exposes a `focusSearch()` method.
    document.addEventListener("keydown", (ev) => {
      // avoid typing into inputs
      const tag = (ev.target && ev.target.tagName) || "";
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        ev.metaKey ||
        ev.ctrlKey ||
        ev.altKey
      )
        return;

      if (ev.key === "s") {
        ev.preventDefault();
        const app = document.querySelector("#app");
        if (app) app.focus();
      }

      // quick navigation: press 'g' then 'h' to go home (gh)
      // a tiny stateful example - keep it simple
    });

    // Start the router
    router.start();

    // Expose the core pieces for debugging and from-browser tinkering.
    window.vanillaHN = {
      router,
      services: { hnService },
      stores: {
        settingsStore,
        readStoriesStore,
        createThreadStore,
        loadThreadState,
      },
    };

    console.info("vanilla-hn booted — router started.");

    // Announce app readiness for assistive tech
    const appElement = document.querySelector("#app");
    if (appElement) {
      // Focus the app container so keyboard users are positioned to interact.
      appElement.setAttribute("tabindex", "-1");
      // small delay to not steal focus during initial load if the user expects it elsewhere
      setTimeout(() => {
        try {
          appElement.focus();
        } catch (e) {
          /* no-op */
        }
      }, 120);
    }
  } catch (err) {
    // If bootstrap fails, leave the fallback content (index.html) intact and log an actionable message.
    // Avoid throwing so that the browser doesn't show a noisy stack in some dev servers.
    console.error(
      "Application bootstrap failed. See earlier logs for details.",
      err,
    );
  }
})();
