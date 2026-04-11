import { create, timeAgoFromUnix } from "../utils/dom.js";
import { pluralise } from "../utils/helpers.js";

/**
 * CommentSlider — time-based comment highlighting slider.
 * Lets users scrub through comments chronologically and highlight
 * all comments newer than the selected position.
 *
 * Extracted from ItemView._buildSlider(), _updateSliderLabel(), and
 * _maybeShowSlider() to improve modularity.
 */
export default class CommentSlider {
  /**
   * @param {Object} options
   * @param {Object} options.threadStore - StoryCommentThreadStore instance
   * @param {Function} [options.onHighlight] - Callback when slider value changes
   *   (e.g. to reapply comment states after highlighting)
   * @param {Function} [options.getCommentCount] - Returns current loaded comment count
   */
  constructor(options = {}) {
    this.threadStore = options.threadStore;
    this.onHighlight = options.onHighlight || null;
    this.getCommentCount = options.getCommentCount || (() => 0);
    this.el = null;
    this._sliderEl = null;
    this._labelEl = null;
    this._sliderValue = null;
    this._userHasInteracted = false;
    this._labelTimer = null;
  }

  /**
   * Render the slider container. Returns a <div>.
   * Initially hidden (opacity: 0) — call show() when ready.
   * @returns {HTMLElement}
   */
  render() {
    this.el = create("div", {
      attrs: {
        class: "slider-container",
        "aria-label": "Highlight comments by position",
      },
      style: { opacity: "0", transition: "opacity .33s ease-out" },
    });

    this._build();

    return this.el;
  }

  /**
   * Build (or rebuild) the slider internals inside this.el.
   *
   * The slider lets the user choose a position in the chronologically-sorted
   * comment list; comments after that position are visually highlighted.
   * It is only rendered once the thread contains at least 2 comments.
   *
   * @returns {void}
   */
  _build() {
    const container = this.el;
    if (!container) return;

    // Clear any previous content.
    while (container.firstChild) container.removeChild(container.firstChild);

    // Clear any existing label tick timer.
    if (this._labelTimer) {
      clearInterval(this._labelTimer);
      this._labelTimer = null;
    }

    if (!this.threadStore) return;

    const commentCount = this.getCommentCount();
    if (commentCount < 2) return;

    // Show the slider section
    container.style.opacity = "1";
    container.setAttribute("aria-hidden", "false");

    // Default slider to max (rightmost = no highlight) unless the user has
    // explicitly moved it. Matches react-hn: value={showNewCommentsAfter || commentCount - 1}
    if (!this._userHasInteracted || this._sliderValue === null || this._sliderValue > commentCount - 1) {
      this._sliderValue = commentCount - 1;
    }

    this._sliderEl = create("input", {
      attrs: {
        type: "range",
        class: "slider",
        min: "1",
        max: String(commentCount - 1),
        value: String(this._sliderValue),
        "aria-label": "Highlight comments after this position",
      },
      style: { margin: "0", verticalAlign: "middle" },
    });

    // Label showing "highlight N comments from <time>"
    this._labelEl = create("span", { attrs: { class: "label" } });
    this.updateLabel(this._sliderValue);

    // Button to apply the slider selection
    const applyBtn = create(
      "button",
      {
        attrs: {
          type: "button",
          class: "btn",
        },
        events: {
          click: () => {
            const val = parseInt(this._sliderEl.value, 10);
            this._sliderValue = val;
            if (
              this.threadStore &&
              typeof this.threadStore.highlightNewCommentsSince === "function"
            ) {
              try {
                this.threadStore.highlightNewCommentsSince(val);
              } catch (e) {
                /* ignore */
              }
            }
            this.updateLabel(val);
            if (typeof this.onHighlight === "function") {
              this.onHighlight();
            }
          },
        },
      },
      this._labelEl,
    );

    this._sliderEl.addEventListener("input", () => {
      const val = parseInt(this._sliderEl.value, 10);
      this._sliderValue = val;
      this._userHasInteracted = true;
      this.updateLabel(val);
    });

    container.appendChild(this._sliderEl);
    container.appendChild(applyBtn);

    // Start a live-ticking timer so the "from X seconds ago" label updates
    // automatically, matching react-hn's <TimeAgo> behaviour.
    this._startLabelTick();
  }

  _startLabelTick() {
    if (this._labelTimer) {
      clearInterval(this._labelTimer);
      this._labelTimer = null;
    }
    const tick = () => {
      if (!this._sliderEl || !this._labelEl) return;
      this.updateLabel(this._sliderValue);
      // Reschedule at the right interval for the current age.
      clearInterval(this._labelTimer);
      this._labelTimer = setInterval(tick, this._labelTickInterval());
    };
    this._labelTimer = setInterval(tick, this._labelTickInterval());
  }

  _labelTickInterval() {
    // Determine the unix time of the reference comment.
    if (
      this.threadStore &&
      typeof this.threadStore.getCommentByTimeIndex === "function" &&
      this._sliderValue !== null
    ) {
      try {
        const ref = this.threadStore.getCommentByTimeIndex(this._sliderValue + 1);
        if (ref && ref.time) {
          const diffMs = Date.now() - ref.time * 1000;
          if (diffMs < 60_000) return 1_000;
          if (diffMs < 3_600_000) return 60_000;
          return 3_600_000;
        }
      } catch (e) { /* ignore */ }
    }
    return 60_000; // fallback: update every minute
  }

  /**
   * Show the slider (rebuild and set opacity to 1) if there are enough comments.
   * Called when new comments arrive or when the thread load completes.
   */
  show() {
    const commentCount = this.getCommentCount();
    if (!this.el) return;

    if (commentCount >= 2) {
      this._build();
    } else {
      this.el.style.opacity = "0";
    }
  }

  /**
   * Hide the slider.
   */
  hide() {
    if (this.el) {
      this.el.style.opacity = "0";
    }
  }

  /**
   * Update the label text based on current slider value.
   *
   * Shows how many comments would be highlighted and from when, e.g.
   * "highlight 5 comments from 3 hours ago".
   *
   * @param {number} sliderVal  1-based index into sorted comment list
   */
  updateLabel(sliderVal) {
    const labelEl = this._labelEl;
    if (!labelEl) return;

    while (labelEl.firstChild) labelEl.removeChild(labelEl.firstChild);

    const commentCount = this.getCommentCount();
    const howMany = Math.max(0, commentCount - sliderVal);

    let timeStr = "";
    if (
      this.threadStore &&
      typeof this.threadStore.getCommentByTimeIndex === "function"
    ) {
      try {
        const refComment = this.threadStore.getCommentByTimeIndex(
          sliderVal + 1,
        );
        if (refComment && refComment.time) {
          timeStr = timeAgoFromUnix(refComment.time);
        }
      } catch (e) {
        /* ignore */
      }
    }

    labelEl.appendChild(
      document.createTextNode(
        `highlight ${howMany} ${pluralise(howMany, "comment")}${timeStr ? " from " : ""}`,
      ),
    );

    if (timeStr) {
      labelEl.appendChild(
        create("span", { attrs: { class: "time" } }, timeStr),
      );
    }
  }

  /**
   * Get the current slider value.
   * @returns {number|null}
   */
  get value() {
    return this._sliderValue;
  }

  /**
   * Clean up references.
   */
  cleanup() {
    if (this._labelTimer) {
      clearInterval(this._labelTimer);
      this._labelTimer = null;
    }
    this.threadStore = null;
    this.onHighlight = null;
    this.getCommentCount = null;
    this._sliderEl = null;
    this._labelEl = null;
    this.el = null;
  }
}
