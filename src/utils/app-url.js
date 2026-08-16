const DEFAULT_ORIGIN = "http://localhost";

/** Normalize a deployment path to one leading and trailing slash. */
export function normalizeBasePath(value = "/") {
  const pathname = String(value || "/").split(/[?#]/, 1)[0];
  const segments = pathname.split("/").filter(Boolean);
  return segments.length ? `/${segments.join("/")}/` : "/";
}

/** Read the app's deployment path from the document's base URL. */
export function getAppBasePath() {
  const baseElement = globalThis.document?.querySelector?.("base[href]");
  const configuredBase = baseElement?.getAttribute("href") || "/";
  const origin = globalThis.location?.origin || DEFAULT_ORIGIN;

  try {
    return normalizeBasePath(new URL(configuredBase, origin).pathname);
  } catch {
    return "/";
  }
}

/** Prefix an app-owned root-relative URL with the deployment path. */
export function toAppPath(value, basePath = getAppBasePath()) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return value;
  }

  const normalizedBase = normalizeBasePath(basePath);
  if (normalizedBase === "/") return value;

  const baseWithoutSlash = normalizedBase.slice(0, -1);
  if (value === baseWithoutSlash || value.startsWith(normalizedBase)) return value;
  if (value === "/") return normalizedBase;
  return `${baseWithoutSlash}${value}`;
}

/** Return whether a URL belongs to this deployment's route space. */
export function isAppURL(url, basePath = getAppBasePath()) {
  const normalizedBase = normalizeBasePath(basePath);
  if (normalizedBase === "/") return true;

  const baseWithoutSlash = normalizedBase.slice(0, -1);
  return url.pathname === baseWithoutSlash || url.pathname.startsWith(normalizedBase);
}

/** Convert a browser URL into the prefix-free pathname used by route patterns. */
export function toRouteTarget(url, basePath = getAppBasePath()) {
  const normalizedBase = normalizeBasePath(basePath);
  let pathname = url.pathname;

  if (normalizedBase !== "/") {
    if (!isAppURL(url, normalizedBase)) return null;
    const baseWithoutSlash = normalizedBase.slice(0, -1);
    pathname = url.pathname.slice(baseWithoutSlash.length) || "/";
  }

  return pathname + (url.search || "");
}
