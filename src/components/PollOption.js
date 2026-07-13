import { create } from "../utils/dom.js";
import { pluralise } from "../utils/helpers.js";
import { createSpinner } from "./Spinner.js";

export default class PollOption {
  constructor({ id, services = {} } = {}) {
    this.id = id;
    this.services = services;
    this.root = null;
    this._unsub = null;
  }

  render() {
    this.root = create(
      "div",
      { attrs: { class: "poll-option poll-option--loading" } },
      createSpinner({ inline: true, label: "Loading poll option" }),
    );
    this._subscribe();
    return this.root;
  }

  cleanup() {
    if (typeof this._unsub === "function") {
      try {
        this._unsub();
      } catch (_) {}
    }
    this._unsub = null;
    this.root = null;
  }

  _subscribe() {
    const hn = this.services.hnService;
    if (!hn || typeof hn.onItemValue !== "function" || this.id == null) {
      this._renderError();
      return;
    }
    this._unsub = hn.onItemValue(this.id, (pollopt) => {
      if (!pollopt?.id) return;
      this._renderOption(pollopt);
    });
  }

  _renderOption(pollopt) {
    if (!this.root) return;
    this.root.className = "poll-option";
    this.root.replaceChildren(
      create("div", { attrs: { class: "poll-option__text" } }, pollopt.text || ""),
      create(
        "div",
        { attrs: { class: "poll-option__score" } },
        `${pollopt.score || 0} ${pluralise(pollopt.score || 0, "point")}`,
      ),
    );
  }

  _renderError() {
    if (!this.root) return;
    this.root.className = "poll-option poll-option--error";
    this.root.textContent = "Unable to load poll option.";
  }
}
