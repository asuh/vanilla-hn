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
      { default: UpdatesStore },
      { default: HNService },
    ] = await Promise.all([
      import("./stores/SettingsStore.js"),
      import("./stores/ReadStoriesStore.js"),
      import("./stores/StoryCommentThreadStore.js"),
      import("./stores/UpdatesStore.js"),
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
    const updatesStore = new UpdatesStore(hnService);

    window.addEventListener("beforeunload", () => {
      try {
        updatesStore.saveSession();
      } catch (_) {}
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
     * @param {Function} loadView - Function returning a dynamic import promise.
     * @param {Object} [opts]   - Extra options merged into the view context.
     * @returns {(params: Object) => Promise<View>} Async factory function.
     */
    function lazyView(loadView, opts = {}) {
      return async function viewFactory(params) {
        const module = await loadView();
        const ViewCtor = module.default;
        if (typeof ViewCtor !== "function") {
          throw new Error(
            "Lazy view module does not export a default constructor/function",
          );
        }
        // Provide commonly needed context to views
        const context = {
          params,
          services: { hnService },
          stores: {
            settingsStore,
            readStoriesStore,
            updatesStore,
            createThreadStore,
            loadThreadState,
          },
          ...opts,
        };
        return new ViewCtor(context);
      };
    }

    function pageParamsFromMatch(match) {
      const params = {};
      const query = match && match[1] ? match[1] : "";
      const page = new URLSearchParams(query).get("page");
      if (page) params.page = page;
      return params;
    }

    function listRoute(pattern, listType) {
      router.register(pattern, (match) => {
        const viewFactory = lazyView(() => import("./views/ListView.js"), {
          listType,
        });
        return viewFactory(pageParamsFromMatch(match));
      });
    }

    // Register list routes with a small param indicating list type
    listRoute(/^\/(?:\?(.+))?$/, "top");
    listRoute(/^\/news(?:\?(.+))?$/, "top");
    listRoute(/^\/newest(?:\?(.+))?$/, "newest");
    listRoute(/^\/ask(?:\?(.+))?$/, "ask");
    listRoute(/^\/show(?:\?(.+))?$/, "show");
    listRoute(/^\/jobs(?:\?(.+))?$/, "jobs");
    listRoute(/^\/read(?:\?(.+))?$/, "read");

    // New comments feed
    router.register(/^\/newcomments(?:\?(.+))?$/, (match) => {
      const viewFactory = lazyView(() => import("./views/NewCommentsView.js"));
      return viewFactory(pageParamsFromMatch(match));
    });

    // Item view — extracts id from paths like /item/12345, /story/12345, etc.
    router.register(
      /^\/(?:item|story|job|poll)\/(\d+)(?:\?.*)?$/,
      async (match) => {
        const params = { id: String(match[1]) };
        const viewFactory = lazyView(() => import("./views/ItemView.js"));
        return await viewFactory(params);
      },
    );

    router.register(/^\/comment\/(\d+)(?:\?.*)?$/, async (match) => {
      const params = { id: String(match[1]) };
      const viewFactory = lazyView(() =>
        import("./views/PermalinkedCommentView.js"),
      );
      return await viewFactory(params);
    });

    // User view route
    router.register(/^\/user\/([\w-]+)$/, async (match) => {
      const params = { id: String(match[1]) };
      const viewFactory = lazyView(() => import("./views/UserView.js"));
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
          updatesStore,
          createThreadStore,
          loadThreadState,
        },
        services: { hnService },
        listType: "top",
      });
    });

    // Basic keyboard helpers.
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

      // quick navigation: press 'g' then 'h' to go home (gh)
      // a tiny stateful example - keep it simple
    });

    // Start the router
    router.start();

    // ── Settings panel wiring ──────────────────────────────────────────────
    // The panel itself uses the native Popover API; JS only syncs form values
    // with SettingsStore and mirrors the open state in button text/ARIA.
    try {
      const settingsBtn = document.querySelector(".site-header .settings");
      const settingsPanel = document.getElementById("settings-panel");

      if (settingsBtn && settingsPanel) {
        const form = settingsPanel.querySelector("form");
        const supportsPopover =
          typeof settingsPanel.showPopover === "function" &&
          typeof settingsPanel.hidePopover === "function";
        const isPanelOpen = () =>
          supportsPopover
            ? settingsPanel.matches(":popover-open")
            : settingsPanel.classList.contains("is-open");

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

        const syncPopoverState = () => {
          const open = isPanelOpen();
          settingsBtn.textContent = open ? "hide settings" : "settings";
          settingsBtn.setAttribute("aria-expanded", String(open));
          if (open) {
            try {
              settingsPanel.focus();
            } catch (_) {
              /* ignore */
            }
          }
        };

        if (supportsPopover) {
          settingsPanel.addEventListener("toggle", syncPopoverState);
        } else {
          settingsPanel.classList.remove("is-open");
          settingsBtn.addEventListener("click", () => {
            settingsPanel.classList.toggle("is-open");
            syncPopoverState();
          });
          settingsPanel.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
              settingsPanel.classList.remove("is-open");
              syncPopoverState();
              try {
                settingsBtn.focus();
              } catch (_) {
                /* ignore */
              }
            }
          });
        }

        syncPopoverState();

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
  } catch (err) {
    // If bootstrap fails, leave the fallback content (index.html) intact and log an actionable message.
    // Avoid throwing so that the browser doesn't show a noisy stack in some dev servers.
    console.error(
      "Application bootstrap failed. See earlier logs for details.",
      err,
    );
  }
})();
