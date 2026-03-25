/**
 * StoryListItem.js
 *
 * Thin alias module that re-exports `createStoryListItem` from CommentElement.
 * This file exists to provide a clearer import path when using story list item
 * factory in other parts of the app:
 *
 *   import createStoryListItem from '../components/StoryListItem.js'
 *
 * or
 *
 *   import { createStoryListItem } from '../components/StoryListItem.js'
 *
 * It also exports a small `StoryListItem` wrapper for semantic usage.
 */

import { createStoryListItem as _createStoryListItem } from './CommentElement.js';

/**
 * Named export: createStoryListItem
 * (delegates to implementation in CommentElement.js)
 *
 * @param {Object} story - story object (id, title, by, time, score, descendants, url)
 * @param {Object} [opts] - options { showHost: true, showNewBadge: false, onClick: fn }
 * @returns {HTMLElement} li element representing the story row
 */
export function createStoryListItem(story = {}, opts = {}) {
  return _createStoryListItem(story, opts);
}

/**
 * Semantic alias for consumers who prefer a constructor-style name.
 * Returns the same element as `createStoryListItem`.
 *
 * @param {Object} story
 * @param {Object} opts
 * @returns {HTMLElement}
 */
export function StoryListItem(story = {}, opts = {}) {
  return _createStoryListItem(story, opts);
}

// Default export for convenience
export default createStoryListItem;
