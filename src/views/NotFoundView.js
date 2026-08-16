import { create } from "../utils/dom.js";
import View from "./View.js";

export default class NotFoundView extends View {
  render() {
    document.title = "Not found | vanilla-hn";

    const wrapper = create("div", {
      attrs: { class: "view not-found-view container" },
    });
    wrapper.appendChild(create("h2", {}, "Not found"));

    this.root = wrapper;
    return wrapper;
  }
}
