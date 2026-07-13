/**
 * Spinner.js
 *
 * A tiny, reusable loading spinner component (SpinKit bounce-dot style).
 * Returns a plain DOM element — no framework needed.
 *
 * The corresponding CSS lives in `styles.css` under `.spinner` (three bounce
 * dots with staggered animation delays).
 *
 * @module components/Spinner
 */

import { create } from "../utils/dom.js";

/**
 * Create a spinner DOM element with three animated bounce dots.
 *
 * @param {Object}  [options]
 * @param {string}  [options.className]  - Extra CSS class(es) to add (space-separated).
 * @param {string}  [options.size]       - Dot size override, e.g. `'12px'`. Applied to
 *                                         each dot via inline `width`/`height`.
 * @param {string}  [options.color]      - Dot color override, e.g. `'#ff6600'`. Applied
 *                                         via inline `background-color`.
 * @param {string}  [options.label]      - Accessible label for screen readers
 *                                         (default `'Loading…'`).
 * @param {boolean} [options.inline]     - If `true`, renders as `<span>` instead of
 *                                         `<div>` for inline layout contexts.
 * @returns {HTMLElement} The spinner element, ready to append to the DOM.
 *
 * @example
 *   import { createSpinner } from '../components/Spinner.js';
 *
 *   container.appendChild(createSpinner());
 *   container.appendChild(createSpinner({ size: '6px', label: 'Fetching comments…' }));
 */
export function createSpinner(options = {}) {
  const {
    className = "",
    size = null,
    color = null,
    label = "Loading\u2026",
    inline = false,
  } = options;

  const tag = inline ? "span" : "div";
  const classes = ["spinner", className].filter(Boolean).join(" ");

  const spinner = create(tag, {
    attrs: {
      class: classes,
      role: "status",
      "aria-label": label,
    },
  });

  // Three bounce dots — CSS animation handles the rest.
  for (let i = 1; i <= 3; i++) {
    const dotAttrs = { class: `bounce${i}` };
    const dot = create("div", { attrs: dotAttrs });

    if (size) {
      dot.style.width = size;
      dot.style.height = size;
    }
    if (color) {
      dot.style.backgroundColor = color;
    }

    spinner.appendChild(dot);
  }

  return spinner;
}

/**
 * Convenience wrapper: create a spinner inside a container element.
 *
 * Useful when you need a block-level wrapper with extra styling
 * (e.g. centering, padding) around the spinner.
 *
 * @param {Object}  [options]
 * @param {string}  [options.wrapperClass] - CSS class for the outer container
 *                                           (default `'spinner-container'`).
 * @param {Object}  [options.spinner]      - Options forwarded to `createSpinner()`.
 * @returns {HTMLElement} A wrapper `<div>` containing the spinner.
 */
export function createSpinnerContainer(options = {}) {
  const { wrapperClass = "spinner-container", spinner: spinnerOpts = {} } =
    options;

  const container = create("div", {
    attrs: { class: wrapperClass },
  });

  container.appendChild(createSpinner(spinnerOpts));
  return container;
}

// Default export for convenience
export default createSpinner;
