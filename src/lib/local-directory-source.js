const DB_NAME = "bds-linked-dirs";
const DB_VERSION = 1;
const STORE_NAME = "handles";

const fileCache = new Map();
const CACHE_TTL_MS = 5000;

const ALWAYS_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  ".theos",
  "packages",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
]);

const BUILD_OUTPUT_DIRS = new Set([
  "dist",
  "build",
  "out",
  "target",
  "obj",
  "bin",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".nyc_output",
  "dist-chrome",
  "dist-firefox",
]);

export const SKIP_DIRS = new Set(ALWAYS_SKIP_DIRS);

const TEXT_EXTS = new Set([
  // JS / web
  "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx", "svelte", "vue",
  "astro", "mdx", "html", "htm", "css", "scss", "sass", "less", "styl",

  // data / config
  "json", "jsonc", "json5", "jsonl", "ndjson", "geojson", "csv", "tsv",
  "xml", "xsl", "xslt", "yml", "yaml", "toml", "ini", "cfg", "conf",
  "config", "properties", "env", "local", "example",
  "gitignore", "gitattributes", "editorconfig", "npmrc", "nvmrc",
  "babelrc", "eslintrc", "prettierrc", "stylelintrc", "htaccess", "htpasswd",

  // docs
  "md", "markdown", "txt", "rst", "adoc", "asciidoc", "org", "tex",
  "bib", "man",

  // shell / build / infra
  "sh", "bash", "zsh", "fish", "ksh", "ps1", "psm1", "bat", "cmd",
  "makefile", "mk", "mak", "cmake", "gradle", "kts", "bzl", "bazel",
  "bazelrc", "workspace", "build", "sbt", "cabal", "dockerfile",
  "containerfile", "justfile", "procfile", "vagrantfile", "gemfile",
  "rakefile", "podfile", "cartfile", "brewfile", "tf", "tfvars", "hcl",
  "nix",

  // C / C++ / Objective-C / Apple / iOS tweaks
  "c", "h", "cc", "cpp", "cxx", "c++", "hh", "hpp", "hxx", "h++",
  "m", "mm", "pch", "x", "xm", "xi", "xmi", "xsm", "swift",
  "plist", "strings", "entitlements", "pbxproj", "xcconfig",
  "modulemap", "storyboard", "xib", "metal", "tbd", "xcscheme",
  "xcworkspacedata", "xctestplan",

  // JVM / Android / other languages
  "java", "kt", "groovy", "scala", "sc", "clj", "cljs", "cljc", "edn",
  "py", "pyi", "rb", "php", "pl", "pm", "go", "rs", "lua", "zig",
  "dart", "jl", "cs", "csproj", "sln", "fs", "fsx", "fsproj", "vb",
  "vbproj", "razor", "cshtml", "ex", "exs", "erl", "hrl", "pas", "pp",
  "lisp", "el", "scm", "rkt", "sol", "move", "proto", "graphql", "gql",
  "ipynb",

  // low level
  "s", "asm", "inc", "ld", "lds", "dts", "dtsi", "overlay", "v", "sv",
  "vhd", "vhdl",

  // misc
  "log", "diff", "patch", "sql",
]);

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "projectId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function closeDb(db) {
  try { db.close(); } catch { /* ignore */ }
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function idbPut(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function supportsLocalDirectoryLinking() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function linkDirectory(projectId) {
  if (!supportsLocalDirectoryLinking()) {
    throw new Error(
      "Local directory linking requires File System Access API (Chromium 86+)."
    );
  }

  const handle = await window.showDirectoryPicker();
  const rootName = handle.name;

  const data = await readAllFilesFromHandle(handle);

  const db = await openDb();
  try {
    await idbPut(db, { projectId, handle, rootName, linkedAt: Date.now() });
  } finally {
    closeDb(db);
  }

  fileCache.set(projectId, {
    files: data.files,
    paths: data.paths,
    rootName,
    cachedAt: Date.now(),
  });

  return { rootName, fileCount: data.files.length };
}

export async function unlinkDirectory(projectId) {
  const db = await openDb();
  try {
    await idbDelete(db, projectId);
  } finally {
    closeDb(db);
  }
  fileCache.delete(projectId);
}

/**
 * Move a linked directory handle (and its file cache) from one project id to
 * another. Used to promote a pending pick to the active project on commit.
 * No-op when no record exists under the source id.
 * @param {string} fromProjectId 
 * @param {string} toProjectId 
 */
export async function adoptDirectoryHandle(fromProjectId, toProjectId) {
  if (fromProjectId === toProjectId) return;
  const db = await openDb();
  try {
    const record = await idbGet(db, fromProjectId);
    if (!record) return;
    await idbPut(db, { ...record, projectId: toProjectId });
    await idbDelete(db, fromProjectId);
  } finally {
    closeDb(db);
  }
  const cached = fileCache.get(fromProjectId);
  if (cached) {
    fileCache.set(toProjectId, cached);
    fileCache.delete(fromProjectId);
  }
}

export async function getLinkedDirectoryInfo(projectId) {
  const db = await openDb();
  let record;
  try {
    record = await idbGet(db, projectId);
  } finally {
    closeDb(db);
  }
  if (!record) return null;

  let hasPermission = false;
  try {
    const result = await record.handle.queryPermission({ mode: "read" });
    hasPermission = result === "granted";
  } catch {
    hasPermission = false;
  }

  const cached = fileCache.get(projectId);
  return {
    rootName: record.rootName,
    linkedAt: record.linkedAt,
    fileCount: cached ? cached.files.length : 0,
    hasPermission,
    files: cached ? cached.files : [],
  };
}

export async function getDirectoryFiles(projectId) {
  const data = await getLinkedData(projectId);
  return data ? data.files : null;
}

export async function getDirectoryPaths(projectId) {
  const data = await getLinkedData(projectId);
  return data ? data.paths : null;
}

async function getLinkedData(projectId) {
  const cached = fileCache.get(projectId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  const db = await openDb();
  let record;
  try {
    record = await idbGet(db, projectId);
  } finally {
    closeDb(db);
  }
  if (!record) return null;

  let permission;
  try {
    permission = await record.handle.queryPermission({ mode: "read" });
  } catch {
    fileCache.delete(projectId);
    return null;
  }

  if (permission !== "granted") {
    try {
      permission = await record.handle.requestPermission({ mode: "read" });
    } catch {
      fileCache.delete(projectId);
      return null;
    }
    if (permission !== "granted") {
      return null;
    }
  }

  const data = await readAllFilesFromHandle(record.handle);
  const result = {
    files: data.files,
    paths: data.paths,
    rootName: record.rootName,
    cachedAt: Date.now(),
  };
  fileCache.set(projectId, result);
  return result;
}

export async function refreshDirectoryCache(projectId) {
  fileCache.delete(projectId);
  return getDirectoryFiles(projectId);
}

export function clearAllCaches() {
  fileCache.clear();
}

async function readAllFilesFromHandle(dirHandle) {
  const files = [];
  const paths = [];
  await readDirectoryHandle(dirHandle, "", files, paths);
  return { files, paths };
}

async function readDirectoryHandle(dirHandle, path, outFiles, outPaths) {
  for await (const entry of dirHandle.values()) {
    const entryPath = path ? `${path}/${entry.name}` : entry.name;

    if (!shouldKeepPath(entryPath)) continue;

    if (entry.kind === "file") {
      if (!isTextFile(entry.name)) continue;
      outPaths.push(entryPath);
      try {
        const file = await entry.getFile();
        if (file.size > 2 * 1024 * 1024) continue;
        const content = await file.text();
        if (content.indexOf("\0") !== -1) continue;
        outFiles.push({ name: entryPath, content });
      } catch (err) {
        console.warn(`[BDS:LocalDir] Skipping ${entryPath}:`, err);
      }
    } else if (entry.kind === "directory") {
      outPaths.push(`${entryPath}/`);
      await readDirectoryHandle(entry, entryPath, outFiles, outPaths);
    }
  }
}

function shouldKeepPath(path) {
  const segments = String(path || "").split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (ALWAYS_SKIP_DIRS.has(segment)) {
      return false;
    }
    if (i <= 1 && BUILD_OUTPUT_DIRS.has(segment)) {
      return false;
    }
  }
  return true;
}

function isTextFile(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  return TEXT_EXTS.has(ext);
}
