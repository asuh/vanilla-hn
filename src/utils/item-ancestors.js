const itemCache = new Map();
const commentParentLookup = new Map();
const titleCache = new Map();

function cacheItem(item) {
  if (!item || item.id == null) return item;
  itemCache.set(String(item.id), item);
  if (item.type !== "comment") {
    titleCache.set(String(item.id), {
      id: item.id,
      type: item.type,
      title: item.title,
    });
  } else if (item.parent != null) {
    commentParentLookup.set(String(item.id), item.parent);
  }
  return item;
}

export function rememberItem(item) {
  cacheItem(item);
}

export async function fetchCachedItem(hnService, id, opts = {}) {
  const key = String(id);
  if (itemCache.has(key)) return itemCache.get(key);
  const item = await hnService.fetchItem(id, opts);
  return cacheItem(item);
}

export async function fetchCommentAncestors(hnService, comment, opts = {}) {
  const result = {
    parent: null,
    op: null,
    itemCount: 0,
    cacheHits: 0,
  };

  if (!comment || comment.parent == null) return result;

  let commentId = comment.id;
  let parentId = comment.parent;

  while (parentId != null) {
    const parentKey = String(parentId);

    if (titleCache.has(parentKey)) {
      result.itemCount++;
      result.cacheHits++;
      const op = titleCache.get(parentKey);
      if (!result.parent) result.parent = op;
      result.op = op;
      return result;
    }

    if (commentParentLookup.has(parentKey)) {
      result.itemCount++;
      result.cacheHits++;
      if (!result.parent) result.parent = { id: parentId, type: "comment" };
      commentId = parentId;
      parentId = commentParentLookup.get(parentKey);
      continue;
    }

    const parent = await fetchCachedItem(hnService, parentId, opts);
    result.itemCount++;
    if (!parent) return result;

    commentParentLookup.set(String(commentId), parentId);
    if (parent.type === "comment") {
      commentParentLookup.set(String(parent.id), parent.parent);
      if (!result.parent) result.parent = parent;
      commentId = parent.id;
      parentId = parent.parent;
      continue;
    }

    const op = {
      id: parent.id,
      type: parent.type,
      title: parent.title,
    };
    titleCache.set(String(parent.id), op);
    if (!result.parent) result.parent = parent;
    result.op = op;
    return result;
  }

  return result;
}

export function itemPath(itemOrType, id) {
  const type = typeof itemOrType === "string" ? itemOrType : itemOrType?.type;
  const itemId = id != null ? id : itemOrType?.id;
  if (type === "comment") return `/comment/${itemId}`;
  if (type === "story" || type === "job" || type === "poll") {
    return `/${type}/${itemId}`;
  }
  return `/item/${itemId}`;
}
