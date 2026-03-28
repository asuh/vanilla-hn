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
     *
     * @param {string|number} storyId  - The HN story id to scope the store to.
     * @param {Object}        [options] - Extra options forwarded to the
     *                                    StoryCommentThreadStore constructor.
     * @returns {StoryCommentThreadStore} A new per-story thread store instance.
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
     * Returns an async view factory that lazy-imports a view module and
     * constructs it with the shared application context.
     *
     * The view module is expected to export a default class or factory
     * function which accepts an options object:
     *
     *   new ListView({ params, services, stores })
     *
     * @param {string} viewPath - Relative path to the view module.
     * @param {Object} [opts]   - Extra options merged into the view context.
     * @returns {(params: Object) => Promise<View>} Async factory function.
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
    router.register(
      /^#?\/read$/,
      lazyView("./views/ListView.js", { listType: "read" }),
    );

    // New comments feed
    router.register(
      /^#?\/newcomments$/,
      lazyView("./views/NewCommentsView.js"),
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

    // ── Settings panel wiring ──────────────────────────────────────────────
    // The panel markup lives in index.html; we just toggle visibility and
    // keep the form inputs in sync with the SettingsStore.
    try {
      const settingsBtn = document.querySelector(".site-header__settings");
      const settingsPanel = document.getElementById("settings-panel");

      if (settingsBtn && settingsPanel) {
        const form = settingsPanel.querySelector("form");

        // Sync every form control to the current store state.
        const syncForm = (state) => {
          if (!form) return;
          for (const name of [
            "autoCollapse",
            "replyLinks",
            "showDead",
            "showDeleted",
          ]) {
            const input = form.querySelector(`[name="${name}"]`);
            if (input) input.checked = Boolean(state[name]);
          }
          for (const name of ["titleFontSize"]) {
            const input = form.querySelector(`[name="${name}"]`);
            if (input) input.value = state[name];
          }
          for (const name of ["listSpacing", "theme"]) {
            const input = form.querySelector(`[name="${name}"]`);
            if (input) input.value = state[name];
          }
        };

        // Subscribe — also fires immediately with current state to seed the form.
        settingsStore.addListener(syncForm);

        // Open / close helpers.
        const openPanel = () => {
          settingsPanel.hidden = false;
          settingsBtn.textContent = "hide settings";
          settingsBtn.setAttribute("aria-expanded", "true");
          try {
            settingsPanel.focus();
          } catch (e) {
            /* ignore */
          }
        };

        const closePanel = () => {
          settingsPanel.hidden = true;
          settingsBtn.textContent = "settings";
          settingsBtn.setAttribute("aria-expanded", "false");
        };

        // Toggle on button click / keyboard activation.
        settingsBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          settingsPanel.hidden ? openPanel() : closePanel();
        });

        settingsBtn.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            settingsBtn.click();
          }
        });

        // Close when clicking anywhere outside the panel.
        document.addEventListener("click", (e) => {
          if (
            !settingsPanel.hidden &&
            !settingsPanel.contains(e.target) &&
            e.target !== settingsBtn
          ) {
            closePanel();
          }
        });

        // Prevent panel-internal clicks from bubbling to the document listener.
        settingsPanel.addEventListener("click", (e) => e.stopPropagation());

        // Close on Escape.
        settingsPanel.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            closePanel();
            try {
              settingsBtn.focus();
            } catch (ex) {
              /* ignore */
            }
          }
        });

        // Propagate form changes to the store.
        if (form) {
          form.addEventListener("change", (e) => {
            const el = e.target;
            if (!el.name) return;
            let value;
            if (el.type === "checkbox") {
              value = el.checked;
            } else if (el.type === "number") {
              value = Number(el.value);
            } else {
              value = el.value;
            }
            settingsStore.update({ [el.name]: value });
          });
        }
      }
    } catch (err) {
      console.warn("Settings panel wiring failed:", err);
    }

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
