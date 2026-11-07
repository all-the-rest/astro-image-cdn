import { readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_ASSET_PREFIX } from "./dev-server.js";
import { processRequestedImages } from "./processor.js";

const manifestCache = new Map();
const requestBatches = new Map();
const TRANSFORM_OPTIONS = new Set([
  "src", "width", "height", "format", "quality", "widths", "densities", "layout", "priority",
  "fit", "position", "background", "inferSize", "formats",
]);
const ASTRO_SOURCE_FORMATS = new Set(["avif", "webp", "jpeg", "jpg", "png", "tiff", "gif", "svg"]);
const CONFIGURED_OUTPUT_FORMATS = new Set(["avif", "webp", "jpeg", "png"]);
const EXCLUDED_DIRS = new Set([".astro", ".cache", ".git", "dist", "node_modules"]);

function normalizeFormat(format) {
  return format === "jpg" ? "jpeg" : format;
}

function isImportedImage(source) {
  return (typeof source === "object" && source !== null) || (typeof source === "function" && "src" in source);
}

function defaultOutputFormat(options) {
  return isImportedImage(options.src) && normalizeFormat(options.src.format) === "svg" ? "svg" : "webp";
}

function rejectRemoteUrlCredentials(source) {
  if (typeof source !== "string") return;

  const trimmedSource = source.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(trimmedSource)) return;
  if (/\s|[\u0000-\u001f\u007f]/u.test(source)) {
    throw new TypeError("Remote image URLs must not contain whitespace or control characters.");
  }

  const rawAuthority = source.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "";
  let parsedUrl;
  try {
    parsedUrl = new URL(source);
  } catch {
    if (!rawAuthority.includes("@")) return;
  }

  if (parsedUrl?.username || parsedUrl?.password || rawAuthority.includes("@")) {
    throw new TypeError("Remote image URLs must not include username or password credentials.");
  }
}

function readManifest(imageConfig) {
  const manifestPath = manifestPathFor(imageConfig);
  let mtime;
  try {
    mtime = statSync(manifestPath).mtimeMs;
  } catch (error) {
    throw new Error(`astro-image-cdn manifest not found at ${manifestPath}. Run an Astro build or start its dev server with the integration enabled.`, { cause: error });
  }

  const cached = manifestCache.get(manifestPath);
  if (cached?.mtime === mtime) return cached.manifest;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifestCache.set(manifestPath, { mtime, manifest });
  return manifest;
}

function manifestPathFor(imageConfig) {
  const cacheDir = path.resolve(imageConfig.service.config.rootDir, imageConfig.service.config.cacheDir);
  return path.join(cacheDir, "manifest.json");
}

function requestBatchKey(config) {
  return [config.rootDir, config.outputDir, config.cacheDir].map((directory) => path.resolve(directory))
    .concat(config.requestSessionId ?? "")
    .join("\0");
}

function scheduleRequestBatch(state, config, logger) {
  if (state.scheduled || state.flushing || state.pending.size === 0) return;
  state.scheduled = true;
  queueMicrotask(async () => {
    state.scheduled = false;
    state.flushing = true;
    const batch = [...state.pending.entries()];
    state.pending.clear();
    try {
      const result = await processRequestedImages(config, batch.map(([sourcePath]) => sourcePath));
      manifestCache.delete(path.join(path.resolve(config.rootDir, config.cacheDir), "manifest.json"));
      logger?.info(`astro-image-cdn: ${result.processed} processed, ${result.skipped} reused; private state at ${result.manifestPath}`);
      if (result.legacyPublicManifestPath && !state.warnedAboutLegacyManifest) {
        state.warnedAboutLegacyManifest = true;
        logger?.warn(`astro-image-cdn found a pre-existing manifest at ${result.legacyPublicManifestPath} and left it untouched. Verify that it belongs to astro-image-cdn, then manually remove it from the public output (or move it outside outputDir) before publishing. The current private manifest is at ${result.manifestPath}.`);
      }
      for (const [, request] of batch) request.resolve();
    } catch (error) {
      for (const [sourcePath, request] of batch) {
        if (state.requests.get(sourcePath) === request) state.requests.delete(sourcePath);
        request.reject(error);
      }
    } finally {
      state.flushing = false;
      scheduleRequestBatch(state, config, logger);
    }
  });
}

async function ensureRequestedImage(options, imageConfig, logger) {
  if (typeof options.src === "string") return Promise.resolve();
  const sourcePath = await requestedSourcePath(options.src, imageConfig.service.config);
  if (typeof sourcePath !== "string") {
    throw new Error(`astro-image-cdn cannot identify the source file for imported image ${JSON.stringify(options.src?.src)}; import the image from a configured source directory.`);
  }

  const config = imageConfig.service.config;
  const absoluteSourcePath = path.resolve(sourcePath);
  const key = requestBatchKey(config);
  const fileInfo = statSync(absoluteSourcePath, { bigint: true });
  const fingerprint = [fileInfo.dev, fileInfo.ino, fileInfo.size, fileInfo.mtimeNs, fileInfo.ctimeNs].join(":");
  let state = requestBatches.get(key);
  if (!state) {
    state = {
      requests: new Map(),
      pending: new Map(),
      scheduled: false,
      flushing: false,
      warnedAboutLegacyManifest: false,
    };
    requestBatches.set(key, state);
  }
  const existing = state.requests.get(absoluteSourcePath);
  if (existing?.fingerprint === fingerprint) return existing.promise;
  if (existing && state.pending.get(absoluteSourcePath) === existing) {
    // A queued request will read the latest source contents when its batch runs.
    existing.fingerprint = fingerprint;
    return existing.promise;
  }

  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const request = { fingerprint, promise, resolve, reject };
  state.requests.set(absoluteSourcePath, request);
  state.pending.set(absoluteSourcePath, request);
  scheduleRequestBatch(state, config, logger);
  return promise;
}

function sourceCandidates(value, rootDir) {
  if (!value || typeof value !== "string") return [];
  const candidates = new Set();
  let decoded = value;
  try {
    if (decoded.startsWith("file:")) decoded = fileURLToPath(decoded);
    else decoded = decodeURIComponent(decoded);
  } catch {}

  if (decoded.startsWith("/@fs/")) decoded = decoded.slice("/@fs".length);
  if (path.isAbsolute(decoded)) {
    candidates.add(path.resolve(decoded));
    let canonicalPath = path.resolve(decoded);
    try {
      canonicalPath = realpathSync(canonicalPath);
      candidates.add(canonicalPath);
    } catch {}
    const relative = path.relative(rootDir, canonicalPath);
    if (!relative.startsWith(`..${path.sep}`) && relative !== "..") candidates.add(relative.split(path.sep).join("/"));
  } else {
    const cleaned = decoded.replace(/^\/+/, "");
    candidates.add(cleaned.split(path.sep).join("/"));
    candidates.add(path.resolve(rootDir, cleaned));
  }
  return [...candidates];
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isConfiguredSourcePath(sourcePath, config) {
  const rootDir = path.resolve(config.rootDir);
  const relative = path.relative(rootDir, sourcePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const sourceDirectories = (config.sources ?? ["src"]).map((source) => path.resolve(rootDir, source));
  return sourceDirectories.some((directory) => isInside(directory, sourcePath));
}

async function findFilesByName(directory, fileName, matches) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) await findFilesByName(path.join(directory, entry.name), fileName, matches);
    } else if (entry.isFile() && entry.name === fileName) {
      matches.push(path.join(directory, entry.name));
    }
  }
}

async function requestedSourcePath(source, config) {
  if (typeof source?.fsPath === "string") return path.resolve(source.fsPath);

  const sourceName = typeof source?.src === "string" ? source.src : undefined;
  if (!sourceName) return undefined;
  const rootDir = path.resolve(config.rootDir);
  const sourceNameWithoutQuery = sourceName.split(/[?#]/, 1)[0];
  for (const candidate of sourceCandidates(sourceNameWithoutQuery, rootDir)) {
    const absoluteCandidate = path.resolve(rootDir, candidate);
    if (!isConfiguredSourcePath(absoluteCandidate, config)) continue;
    try {
      if ((await stat(absoluteCandidate)).isFile()) return absoluteCandidate;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }

  // Astro's SVG component wrapper serializes image metadata without its private fsPath.
  // Resolve that requested import by its emitted basename, but reject ambiguous matches.
  const basename = path.posix.basename(sourceNameWithoutQuery)
    .replace(/\.[a-z0-9_-]{8,}(?=\.[^.]+$)/i, "");
  const matches = [];
  for (const directory of (config.sources ?? ["src"]).map((sourceDirectory) => path.resolve(rootDir, sourceDirectory))) {
    await findFilesByName(directory, basename, matches);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`astro-image-cdn cannot uniquely match requested image ${JSON.stringify(basename)} to a source file. Use a unique filename or import from a dedicated source directory.`);
  }
  return undefined;
}

function validateAstroOptions(options) {
  if (!options?.src || (typeof options.src !== "string" && !isImportedImage(options.src))) {
    throw new TypeError("Astro image options require an imported image or a remote image source.");
  }

  if (typeof options.src === "string") {
    const isUrl = /^[a-z][a-z\d+.-]*:/i.test(options.src);
    if (options.src.startsWith("/@fs/") || (!isUrl && !options.src.startsWith("/"))) {
      throw new TypeError(`Local image source ${JSON.stringify(options.src)} must be imported instead of passed as a string.`);
    }
    if (!options.width || !options.height) {
      const missingDimension = !options.width && !options.height ? "width and height" : !options.width ? "width" : "height";
      throw new TypeError(`Remote image sources require ${missingDimension}; provide explicit dimensions for ${JSON.stringify(options.src)}.`);
    }
    return;
  }

  if (!ASTRO_SOURCE_FORMATS.has(options.src.format)) {
    throw new TypeError(`Astro image service does not support source format ${JSON.stringify(options.src.format)}.`);
  }
  if (options.widths && options.densities) {
    throw new TypeError("Astro image options cannot specify both widths and densities.");
  }
  if (options.src.format !== "svg" && options.format === "svg") {
    throw new TypeError("Astro image service cannot convert a non-SVG source to SVG.");
  }
}

function resolveImage(options, imageConfig) {
  const manifest = readManifest(imageConfig);
  const rootDir = path.resolve(imageConfig.service.config.rootDir);
  const source = options.src;
  const possibleSources = [];
  if (isImportedImage(source)) {
    if (typeof source.fsPath === "string") possibleSources.push(...sourceCandidates(source.fsPath, rootDir));
    possibleSources.push(...sourceCandidates(source.src, rootDir));
  } else {
    possibleSources.push(...sourceCandidates(source, rootDir));
  }

  for (const candidate of possibleSources) {
    const entry = manifest.images[candidate];
    if (entry) return entry;
  }

  const sourceName = typeof source === "string" ? source : source?.src;
  if (typeof sourceName === "string") {
    const builtAssetName = path.basename(sourceName).replace(/\.[a-z0-9_-]{8,}(?=\.[^.]+$)/i, "");
    const sameName = Object.values(manifest.images).filter((entry) => path.posix.basename(entry.source) === builtAssetName);
    const sameDimensions = sameName.filter((entry) => entry.width === source?.width && entry.height === source?.height);
    const candidates = sameDimensions.length > 0 ? sameDimensions : sameName;
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1 && candidates.every((entry) => entry.fingerprint === candidates[0].fingerprint)) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      throw new Error(
        `astro-image-cdn found multiple files named ${JSON.stringify(builtAssetName)} with matching dimensions. ` +
        `Use unique source filenames or import one file from a dedicated source directory.`
      );
    }
  }

  throw new Error(
    `astro-image-cdn cannot match Astro image source ${JSON.stringify(sourceName)} to a scanned file. ` +
    `Ensure the imported image is inside one of the configured source directories.`
  );
}

function targetWidth(options, image) {
  if (options.width) return Math.min(image.width, Math.max(1, Math.round(Number(options.width))));
  if (options.height) {
    return Math.min(image.width, Math.max(1, Math.round(Number(options.height) * image.width / image.height)));
  }
  return image.width;
}

function validateStaticTransform(options, config) {
  if (typeof options.src === "string") return;

  if (options.background != null) {
    throw new Error("astro-image-cdn does not support per-image background flattening; use a pre-flattened source image.");
  }
  if (options.fit != null && !["cover", "contain"].includes(options.fit)) {
    throw new Error(`astro-image-cdn does not support fit="${options.fit}".`);
  }

  const width = Number(options.width ?? options.src.width);
  const height = Number(options.height ?? (width * options.src.height / options.src.width));
  const targetRatio = width / height;
  const sourceRatio = options.src.width / options.src.height;
  if (Number.isFinite(targetRatio) && Math.abs(targetRatio - sourceRatio) > 0.005) {
    throw new Error("astro-image-cdn generates aspect-preserving variants only; per-image cropping is not supported.");
  }

  if (options.quality != null) {
    const presets = { low: 25, mid: 50, high: 80, max: 100 };
    const requestedQuality = typeof options.quality === "number"
      ? options.quality
      : presets[options.quality] ?? Number(options.quality);
    if (requestedQuality !== config.quality) {
      throw new Error(`astro-image-cdn uses build-wide quality ${config.quality}; requested per-image quality ${options.quality} (${requestedQuality}) is not available.`);
    }
  }
}

function findVariant(image, width, format) {
  const variants = image.variants.filter((variant) => variant.format === format);
  if (variants.length === 0) return undefined;
  return variants.find((variant) => variant.width >= width) ?? variants.at(-1);
}

function imageUrl(options, imageConfig, width) {
  const config = imageConfig.service.config;
  const image = resolveImage(options, imageConfig);
  const format = normalizeFormat(options.format ?? defaultOutputFormat(options));
  const variant = findVariant(image, width, format);
  if (!variant) {
    throw new Error(`astro-image-cdn has no ${format} variant for ${image.source}. Add the format to the integration's formats option.`);
  }
  const variantPath = variant.file.split("/").map(encodeURIComponent).join("/");
  return config.devMode ? `${DEV_ASSET_PREFIX}${variantPath}` : `${config.baseUrl}/${variantPath}`;
}

const service = {
  validateOptions(options, imageConfig) {
    rejectRemoteUrlCredentials(options?.src);
    const config = imageConfig.service.config;
    validateAstroOptions(options);
    const sourceFormat = isImportedImage(options.src) ? normalizeFormat(options.src.format) : undefined;
    const configuredFormats = config.formats.map(normalizeFormat);
    const invalidFormats = configuredFormats.filter((format) => !CONFIGURED_OUTPUT_FORMATS.has(format));
    if (invalidFormats.length > 0) {
      throw new Error(`astro-image-cdn has unsupported configured output format(s): ${invalidFormats.join(", ")}. Supported output formats are avif, webp, jpeg, or png.`);
    }
    const format = normalizeFormat(options.format ?? defaultOutputFormat(options));
    const isSourceFormat = sourceFormat === format && ["avif", "webp", "jpeg", "png", "svg"].includes(format);
    if (typeof options.src !== "string" && !configuredFormats.includes(format) && !isSourceFormat) {
      if (format === "webp" && options.format == null) {
        throw new Error('Astro 7.4 defaults raster images to "webp", but "webp" is not configured. Add "webp" to astroImageCdn({ formats }) or set an explicit configured format on the image.');
      }
      throw new Error(`astro-image-cdn format "${format}" is not configured for generation`);
    }
    if (sourceFormat === "svg" && format !== "svg" && !config.dangerouslyProcessSVG) {
      throw new Error("SVG image processing is disabled. Set image.dangerouslyProcessSVG: true only if you trust the SVG source.");
    }
    validateStaticTransform(options, config);
    const validatedOptions = { ...options, format };
    if (validatedOptions.width) validatedOptions.width = Math.round(validatedOptions.width);
    if (validatedOptions.height) validatedOptions.height = Math.round(validatedOptions.height);
    delete validatedOptions.layout;
    if (validatedOptions.fit === "none") delete validatedOptions.fit;
    return validatedOptions;
  },

  async getURL(options, imageConfig, logger) {
    if (typeof options.src === "string") return options.src;
    await ensureRequestedImage(options, imageConfig, logger);
    const image = resolveImage(options, imageConfig);
    return imageUrl(options, imageConfig, targetWidth(options, image));
  },

  async getSrcSet(options, imageConfig, logger) {
    if (typeof options.src === "string") return [];
    await ensureRequestedImage(options, imageConfig, logger);
    const image = resolveImage(options, imageConfig);
    const format = normalizeFormat(options.format ?? defaultOutputFormat(options));
    const variants = image.variants.filter((variant) => variant.format === format);
    const maximumWidth = targetWidth(options, image);
    let candidates;

    if (Array.isArray(options.widths) && options.widths.length > 0) {
      candidates = options.widths
        .map((width) => findVariant(image, Math.min(image.width, Math.round(width)), format))
        .filter(Boolean);
    } else if (Array.isArray(options.densities) && options.densities.length > 0) {
      candidates = options.densities
        .map((density) => {
          const multiplier = typeof density === "string" ? Number.parseFloat(density) : Number(density);
          return findVariant(image, Math.min(image.width, Math.round(maximumWidth * multiplier)), format);
        })
        .filter(Boolean);
    } else {
      candidates = [];
    }

    const unique = [...new Map(candidates.map((variant) => [variant.width, variant])).values()]
      .filter((variant) => variant.width <= image.width)
      .sort((a, b) => a.width - b.width);
    return unique.map((variant) => ({
      transform: { ...options, width: variant.width, height: variant.height, format },
      descriptor: Array.isArray(options.densities) && options.densities.length > 0
        ? `${Number((variant.width / maximumWidth).toFixed(2))}x`
        : `${variant.width}w`,
      attributes: { type: `image/${format}` },
    }));
  },

  async getHTMLAttributes(options, imageConfig, logger) {
    const attributes = Object.fromEntries(Object.entries(options).filter(([key]) => !TRANSFORM_OPTIONS.has(key)));
    if (typeof options.src === "string") {
      return {
        ...attributes,
        width: options.width,
        height: options.height,
        loading: attributes.loading ?? (options.priority ? "eager" : "lazy"),
        decoding: attributes.decoding ?? "async",
        ...(options.priority ? { fetchpriority: "high" } : {}),
      };
    }

    await ensureRequestedImage(options, imageConfig, logger);
    const image = resolveImage(options, imageConfig);
    const width = targetWidth(options, image);
    const height = Math.max(1, Math.round(width * image.height / image.width));
    return {
      ...attributes,
      width,
      height,
      loading: attributes.loading ?? (options.priority ? "eager" : "lazy"),
      decoding: attributes.decoding ?? "async",
      ...(options.priority ? { fetchpriority: "high" } : {}),
    };
  },
};

export default service;
