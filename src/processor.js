import { createHash, randomUUID } from "node:crypto";
import { open, readdir, readFile, realpath, rename, mkdir, lstat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const MANIFEST_VERSION = 2;
const CACHE_VERSION = 1;
const TRANSFORM_VERSION = 3;
const DEFAULT_WIDTHS = [256, 640, 828, 1080, 1200, 1920, 2048];
const DEFAULT_FORMATS = ["avif", "webp"];
const DEFAULT_WEBP_EFFORT = 4;
const DEFAULT_AVIF_EFFORT = 4;
const DEFAULT_VERIFICATION = "stat";
const SUPPORTED_FORMATS = new Set(["avif", "webp", "jpeg", "png", "svg"]);
const IMAGE_EXTENSIONS = new Set([
  ".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp",
]);
const EXCLUDED_DIRS = new Set([".astro", ".cache", ".git", "dist", "node_modules"]);
const AVIF_SEQUENCE_BRAND = Buffer.from("avis");

function normalizeFormat(format) {
  return format === "jpg" ? "jpeg" : format;
}

function normalizeVariantFormat(metadata) {
  return metadata.format === "heif" && metadata.mediaType === "image/avif"
    ? "avif"
    : normalizeFormat(metadata.format);
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathsOverlap(first, second) {
  return isInside(first, second) || isInside(second, first);
}

async function canonicalizePath(value) {
  let candidate = path.resolve(value);
  const suffix = [];
  while (true) {
    try {
      return path.join(await realpath(candidate), ...suffix.reverse());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function releaseWriterLocks(locks) {
  for (const { lockPath, token } of [...locks].reverse()) {
    try {
      if (await readFile(lockPath, "utf8") === token) await unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function acquireWriterLocks(directories) {
  const canonicalDirectories = [...new Set(await Promise.all(directories.map((directory) => realpath(directory))))]
    .sort((a, b) => a.localeCompare(b));
  const locks = [];
  try {
    for (const directory of canonicalDirectories) {
      const lockPath = path.join(directory, ".astro-image-cdn.lock");
      const token = `${process.pid}\n${randomUUID()}\n`;
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new Error(`Another astro-image-cdn process is already writing ${directory}; remove ${lockPath} only after confirming its process has stopped.`, { cause: error });
        }
        throw error;
      }

      try {
        await handle.writeFile(token);
      } catch (error) {
        await handle.close();
        await unlink(lockPath).catch(() => {});
        throw error;
      }
      await handle.close();
      locks.push({ lockPath, token });
    }
  } catch (error) {
    await releaseWriterLocks(locks);
    throw error;
  }

  return () => releaseWriterLocks(locks);
}

function validatePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must contain positive integers; received ${value}`);
  }
}

function validateEffort(value, label, maximum) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer between 0 and ${maximum}; received ${value}`);
  }
  if (value < 0 || value > maximum) {
    throw new RangeError(`${label} must be between 0 and ${maximum}; received ${value}`);
  }
}

export function resolveEncoderEfforts(options) {
  const webpEffort = options.webpEffort === undefined ? DEFAULT_WEBP_EFFORT : options.webpEffort;
  const avifEffort = options.avifEffort === undefined ? DEFAULT_AVIF_EFFORT : options.avifEffort;
  validateEffort(webpEffort, "webpEffort", 6);
  validateEffort(avifEffort, "avifEffort", 9);
  return { webpEffort, avifEffort };
}

export function resolveVerification(options) {
  const verification = options.verification ?? DEFAULT_VERIFICATION;
  if (verification !== "stat" && verification !== "digest") {
    throw new TypeError(`verification must be "stat" or "digest"; received ${JSON.stringify(verification)}`);
  }
  return verification;
}

function heightMatchesExpected(expected, actual) {
  return Number.isSafeInteger(actual) && Math.abs(actual - expected) <= 1;
}

function resolveOptions(options) {
  if (!options || typeof options.rootDir !== "string") {
    throw new TypeError("processImages requires an absolute rootDir");
  }

  const rootDir = path.resolve(options.rootDir);
  const sourceDirectories = (options.sources ?? ["src"]).map((source) => path.resolve(rootDir, source));
  const publicDir = path.resolve(rootDir, options.publicDir ?? "public");
  const outputDir = path.resolve(rootDir, options.outputDir ?? ".imagedist");
  const cacheDir = path.resolve(rootDir, options.cacheDir ?? ".astro-image-cdn");
  const widths = [...new Set(options.widths ?? DEFAULT_WIDTHS)].sort((a, b) => a - b);
  const formats = [...new Set((options.formats ?? DEFAULT_FORMATS).map(normalizeFormat))];
  const quality = options.quality ?? 75;
  const { webpEffort, avifEffort } = resolveEncoderEfforts(options);
  const verification = resolveVerification(options);
  const concurrency = options.concurrency ?? 4;
  const dangerouslyProcessSVG = options.dangerouslyProcessSVG ?? false;
  const includeSourceFormat = options.includeSourceFormat ?? true;
  const includeNativeWidth = options.includeNativeWidth ?? true;
  const autoRotate = options.autoRotate ?? true;

  for (const width of widths) validatePositiveInteger(width, "widths");
  for (const format of formats) {
    if (!["avif", "webp", "jpeg", "png"].includes(format)) {
      throw new TypeError(`Unsupported configured output format "${format}" for astro-image-cdn. Supported output formats are avif, webp, jpeg, and png.`);
    }
  }
  validatePositiveInteger(quality, "quality");
  validatePositiveInteger(concurrency, "concurrency");
  if (typeof dangerouslyProcessSVG !== "boolean") {
    throw new TypeError("dangerouslyProcessSVG must be a boolean");
  }
  for (const [label, value] of Object.entries({ includeSourceFormat, includeNativeWidth, autoRotate })) {
    if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  }
  if (quality > 100) throw new RangeError("quality must be between 1 and 100");
  if (formats.length === 0) throw new TypeError("formats must contain at least one image format");

  return {
    rootDir,
    sourceDirectories,
    publicDir,
    outputDir,
    cacheDir,
    widths,
    formats,
    quality,
    webpEffort,
    avifEffort,
    verification,
    concurrency,
    dangerouslyProcessSVG,
    includeSourceFormat,
    includeNativeWidth,
    autoRotate,
  };
}

async function walk(directory, output, excludedPaths) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (excludedPaths.has(fullPath)) continue;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) await walk(fullPath, output, excludedPaths);
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      output.push(fullPath);
    }
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Could not read JSON file ${filePath}: ${error.message}`, { cause: error });
  }
}

async function atomicWrite(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function detectLegacyPublicManifest(outputDir) {
  const manifestPath = path.join(outputDir, "manifest.json");
  try {
    await lstat(manifestPath);
    return manifestPath;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

function hasAvifSequenceBrand(buffer) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const boxType = buffer.toString("ascii", offset + 4, offset + 8);
    let boxSize = buffer.readUInt32BE(offset);
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > buffer.length) return false;
      boxSize = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = buffer.length - offset;
    }

    if (boxType === "ftyp") {
      const boxEnd = Math.min(buffer.length, offset + boxSize);
      for (let brandOffset = offset + headerSize; brandOffset + 4 <= boxEnd; brandOffset += 4) {
        if (buffer.subarray(brandOffset, brandOffset + 4).equals(AVIF_SEQUENCE_BRAND)) return true;
      }
      return false;
    }
    if (boxSize < headerSize || offset + boxSize > buffer.length) return false;
    offset += boxSize;
  }
  return false;
}

async function imageMetadata(buffer, filePath, autoRotate = true) {
  if (hasAvifSequenceBrand(buffer)) {
    throw new Error(`Animated or multi-page image sources are not supported: ${filePath} is an AVIF image sequence.`);
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: "none" }).metadata();
  } catch (error) {
    throw new Error(`Unable to read image metadata for ${filePath}: ${error.message}`, { cause: error });
  }

  if (!metadata.width || !metadata.height) {
    throw new Error(`Unable to determine image dimensions for ${filePath}`);
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new Error(`Animated or multi-page image sources are not supported: ${filePath} (${metadata.mediaType ?? metadata.format}, ${metadata.pages} pages).`);
  }
  const rotated = autoRotate && metadata.orientation >= 5 && metadata.orientation <= 8;
  return {
    width: rotated ? metadata.height : metadata.width,
    height: rotated ? metadata.width : metadata.height,
    format: metadata.format,
  };
}

function getVariants(width, formats) {
  return formats.map((format) => ({ width, format }));
}

function pipelineSettings(options) {
  return JSON.stringify({
    widths: options.widths,
    formats: options.formats,
    quality: options.quality,
    webpEffort: options.webpEffort,
    avifEffort: options.avifEffort,
    transformVersion: TRANSFORM_VERSION,
    sharpVersion: sharp.versions.sharp,
    libvipsVersion: sharp.versions.vips,
    dangerouslyProcessSVG: options.dangerouslyProcessSVG,
    includeSourceFormat: options.includeSourceFormat,
    includeNativeWidth: options.includeNativeWidth,
    autoRotate: options.autoRotate,
  });
}

function expectedVariants(fingerprint, dimensions, sourceFormat, options) {
  const targetWidths = options.widths.filter((width) => width <= dimensions.width);
  if (options.includeNativeWidth || (sourceFormat === "svg" && (!options.dangerouslyProcessSVG || options.includeSourceFormat))) {
    targetWidths.push(dimensions.width);
  }
  const uniqueWidths = [...new Set(targetWidths)].sort((a, b) => a - b);
  const generatedFormats = sourceFormat === "svg" && !options.dangerouslyProcessSVG
    ? ["svg"]
    : options.includeSourceFormat && SUPPORTED_FORMATS.has(sourceFormat)
      ? [...new Set([...options.formats, sourceFormat])]
      : options.formats;

  return uniqueWidths.flatMap((width) => getVariants(width, generatedFormats)
    .filter((variant) => variant.format !== "svg" || width === dimensions.width)
    .map((variant) => ({
      ...variant,
      height: Math.max(1, Math.round(width * dimensions.height / dimensions.width)),
      file: `${fingerprint.slice(0, 2)}/${fingerprint}_${width}.${variant.format}`,
    })));
}

function hasValidVariantIdentity(variant) {
  return Boolean(variant)
    && typeof variant.file === "string"
    && /^[a-f0-9]{64}$/.test(variant.digest ?? "");
}

async function fileStat(filePath) {
  const info = await lstat(filePath, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  return { size: Number(info.size), mtimeNs: info.mtimeNs.toString() };
}

async function sourceFileStat(filePath) {
  try {
    return await fileStat(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  }
}

function matchesRecordedStat(variant, info) {
  return Number.isSafeInteger(variant?.size)
    && variant.size === info.size
    && typeof variant?.mtimeNs === "string"
    && variant.mtimeNs === info.mtimeNs;
}

async function inspectVariantFile(outputDir, file) {
  if (typeof file !== "string") return undefined;
  const filePath = path.resolve(outputDir, file);
  if (!isInside(outputDir, filePath) || filePath === outputDir) return undefined;

  try {
    const relative = path.relative(outputDir, filePath);
    const segments = relative.split(path.sep);
    let directory = outputDir;
    for (const segment of segments.slice(0, -1)) {
      directory = path.join(directory, segment);
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return undefined;
    }
    const info = await fileStat(filePath);
    return info ? { filePath, ...info } : undefined;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function readMatchingVariant(outputDir, variant) {
  if (!hasValidVariantIdentity(variant)) return undefined;
  const inspected = await inspectVariantFile(outputDir, variant.file);
  if (!inspected) return undefined;
  const buffer = await readFile(inspected.filePath);
  return digest(buffer) === variant.digest ? { buffer, ...inspected } : undefined;
}

async function variantMatches(outputDir, variant) {
  return (await readMatchingVariant(outputDir, variant)) !== undefined;
}

async function verifyVariant(outputDir, variant, expectedVariant, verification) {
  if (!hasValidVariantIdentity(variant) || !expectedVariant) return undefined;
  if (verification === "stat") {
    const inspected = await inspectVariantFile(outputDir, variant.file);
    if (inspected
      && matchesRecordedStat(variant, inspected)
      && heightMatchesExpected(expectedVariant.height, variant.height)) {
      return { ...variant, size: inspected.size, mtimeNs: inspected.mtimeNs };
    }
  }

  const matched = await readMatchingVariant(outputDir, variant);
  if (!matched) return undefined;
  let metadata;
  try {
    metadata = await sharp(matched.buffer, { failOn: "none" }).metadata();
  } catch {
    return undefined;
  }
  if (normalizeVariantFormat(metadata) !== expectedVariant.format
    || metadata.width !== expectedVariant.width
    || !heightMatchesExpected(expectedVariant.height, metadata.height)) return undefined;
  return { ...variant, height: metadata.height, size: matched.size, mtimeNs: matched.mtimeNs };
}

function variantKey(variant) {
  return `${variant.width}\0${variant.format}`;
}

function hasCompleteVariantSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const byKey = new Map();
  for (const variant of actual) {
    if (!hasValidVariantIdentity(variant)) return false;
    const key = variantKey(variant);
    if (byKey.has(key)) return false;
    byKey.set(key, variant);
  }
  return expected.every((variant) => {
    const actualVariant = byKey.get(variantKey(variant));
    return actualVariant?.file === variant.file && heightMatchesExpected(variant.height, actualVariant.height);
  });
}

async function verifiedOutputVariants(outputDir, actual, expected, verification) {
  if (!hasCompleteVariantSet(actual, expected)) return undefined;
  const actualByKey = new Map(actual.map((variant) => [variantKey(variant), variant]));
  const verified = [];
  for (const expectedVariant of expected) {
    const variant = actualByKey.get(variantKey(expectedVariant));
    const verifiedVariant = await verifyVariant(outputDir, variant, expectedVariant, verification);
    if (!verifiedVariant) return undefined;
    verified.push(verifiedVariant);
  }
  return verified;
}

function carryForwardVariantDigests(expected, previous) {
  const previousByKey = new Map();
  if (Array.isArray(previous)) {
    for (const variant of previous) {
      if (hasValidVariantIdentity(variant)) {
        previousByKey.set(variantKey(variant), variant);
      }
    }
  }

  return expected.map((variant) => {
    const previousVariant = previousByKey.get(variantKey(variant));
    if (previousVariant?.file === variant.file && heightMatchesExpected(variant.height, previousVariant.height)) {
      return {
        ...variant,
        height: previousVariant.height,
        digest: previousVariant.digest,
        ...(Number.isSafeInteger(previousVariant.size) && typeof previousVariant.mtimeNs === "string"
          ? { size: previousVariant.size, mtimeNs: previousVariant.mtimeNs }
          : {}),
      };
    }
    return variant;
  });
}

async function ensureVariantDirectory(outputDir, file) {
  const filePath = path.resolve(outputDir, file);
  if (!isInside(outputDir, filePath) || filePath === outputDir) {
    throw new Error(`Refusing to write image variant outside outputDir: ${file}`);
  }

  const segments = path.relative(outputDir, filePath).split(path.sep);
  let directory = outputDir;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    let directoryInfo;
    try {
      directoryInfo = await lstat(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(directory).catch((mkdirError) => {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      });
      directoryInfo = await lstat(directory);
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error(`Refusing to write image variant through a symlink or non-directory: ${directory}`);
    }
  }
  return filePath;
}

async function writeVariant(buffer, filePath, variant, options, expectedHeight) {
  if (variant.format === "svg") {
    await atomicWrite(filePath, buffer);
    const fileInfo = await lstat(filePath, { bigint: true });
    return {
      digest: digest(buffer),
      width: variant.width,
      height: expectedHeight,
      size: Number(fileInfo.size),
      mtimeNs: fileInfo.mtimeNs.toString(),
    };
  }
  const image = sharp(buffer, { failOn: "none" });
  if (options.autoRotate) image.rotate();
  image.resize({ width: variant.width, withoutEnlargement: true });
  if (variant.format === "avif") image.avif({ quality: options.quality, effort: options.avifEffort });
  else if (variant.format === "webp") image.webp({ quality: options.quality, effort: options.webpEffort });
  else if (variant.format === "jpeg") image.jpeg({ quality: options.quality });
  else image.png({ quality: options.quality });

  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  await atomicWrite(filePath, data);
  const fileInfo = await lstat(filePath, { bigint: true });
  return {
    digest: digest(data),
    width: info.width,
    height: info.height,
    size: Number(fileInfo.size),
    mtimeNs: fileInfo.mtimeNs.toString(),
  };
}

async function mapConcurrent(items, concurrency, callback) {
  let nextIndex = 0;
  const results = new Array(items.length);
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

async function processImagesFromFiles(rawOptions, requestedFiles) {
  const options = resolveOptions(rawOptions);
  const { rootDir, sourceDirectories, publicDir, concurrency, autoRotate, verification } = options;
  let { outputDir, cacheDir } = options;
  const reportedManifestPath = path.join(cacheDir, "manifest.json");
  const canonicalRoot = await canonicalizePath(rootDir);
  const canonicalSources = [];
  for (const sourceDirectory of sourceDirectories) {
    const relative = path.relative(rootDir, sourceDirectory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Image source directory must remain inside rootDir: ${sourceDirectory}`);
    }
    const canonicalSource = await canonicalizePath(sourceDirectory);
    if (!isInside(canonicalRoot, canonicalSource)) {
      throw new Error(`Image source directory must remain inside rootDir after resolving symlinks: ${sourceDirectory}`);
    }
    canonicalSources.push(canonicalSource);
  }

  const canonicalOutputDir = await canonicalizePath(outputDir);
  const canonicalCacheDir = await canonicalizePath(cacheDir);
  const canonicalPublicDir = await canonicalizePath(publicDir);
  if (pathsOverlap(canonicalOutputDir, canonicalCacheDir)) {
    throw new Error(`outputDir and cacheDir must not overlap: ${canonicalOutputDir} and ${canonicalCacheDir}`);
  }
  for (const [label, directory] of [["outputDir", canonicalOutputDir], ["cacheDir", canonicalCacheDir]]) {
    if (isInside(canonicalPublicDir, directory)) {
      throw new Error(`Image ${label} must be outside Astro's public directory, including through symlinks: ${directory}`);
    }
  }
  for (const canonicalSource of canonicalSources) {
    for (const [label, directory] of [["outputDir", canonicalOutputDir], ["cacheDir", canonicalCacheDir]]) {
      if (pathsOverlap(canonicalSource, directory)) {
        throw new Error(`Image ${label} must not overlap a scanned source directory, including through symlinks: ${directory}`);
      }
    }
  }

  await mkdir(outputDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  outputDir = await realpath(outputDir);
  cacheDir = await realpath(cacheDir);
  const releaseLocks = await acquireWriterLocks([outputDir, cacheDir]);
  try {
    const legacyPublicManifestPath = await detectLegacyPublicManifest(outputDir);
    const excludedPaths = new Set([outputDir, cacheDir]);
    const files = [];
    if (requestedFiles === undefined) {
      for (const sourceDirectory of sourceDirectories) {
        await walk(sourceDirectory, files, excludedPaths);
      }
    } else {
      const uniqueFiles = new Set();
      for (const requestedFile of requestedFiles) {
        if (typeof requestedFile !== "string") {
          throw new TypeError("Requested image paths must be strings");
        }
        const sourcePath = path.resolve(rootDir, requestedFile);
        const relative = path.relative(rootDir, sourcePath);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Requested image must remain inside rootDir: ${sourcePath}`);
        }
        if (!IMAGE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
          throw new Error(`Requested file is not a supported image: ${sourcePath}`);
        }
        const fileInfo = await lstat(sourcePath);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
          throw new Error(`Requested image must be a regular file, not a symlink: ${sourcePath}`);
        }
        const canonicalFile = await realpath(sourcePath);
        if (!isInside(canonicalRoot, canonicalFile) || !canonicalSources.some((source) => isInside(source, canonicalFile))) {
          throw new Error(`Requested image must be inside one of the configured image source directories: ${sourcePath}`);
        }
        uniqueFiles.add(sourcePath);
      }
      files.push(...uniqueFiles);
    }
    files.sort((a, b) => a.localeCompare(b));

    const manifestPath = path.join(cacheDir, "manifest.json");
    const cachePath = path.join(cacheDir, "cache.json");
    const oldManifest = await readJson(manifestPath, { version: MANIFEST_VERSION, images: {} });
    const oldCache = await readJson(cachePath, { version: CACHE_VERSION, sources: {} });
    const incrementalRequest = requestedFiles !== undefined;
    const manifest = {
      version: MANIFEST_VERSION,
      images: incrementalRequest && oldManifest.images && typeof oldManifest.images === "object"
        ? { ...oldManifest.images }
        : {},
    };
    const cache = {
      version: CACHE_VERSION,
      sources: incrementalRequest && oldCache.sources && typeof oldCache.sources === "object"
        ? { ...oldCache.sources }
        : {},
    };
    let processed = 0;
    let skipped = 0;

    const pipeline = pipelineSettings(options);

    const results = await mapConcurrent(files, concurrency, async (sourcePath) => {
      const relativePath = normalizeRelativePath(path.relative(rootDir, sourcePath));
      const cacheEntry = oldCache.sources?.[relativePath];
      const previousEntry = oldManifest.images?.[relativePath];
      let sourceInfo = await sourceFileStat(sourcePath);
      const canTrustSourceStat = verification === "stat"
        && sourceInfo
        && cacheEntry?.sourceSize === sourceInfo.size
        && cacheEntry?.sourceMtimeNs === sourceInfo.mtimeNs
        && cacheEntry?.autoRotate === autoRotate
        && previousEntry
        && typeof previousEntry.sourceHash === "string"
        && Number.isSafeInteger(previousEntry.width) && previousEntry.width > 0
        && Number.isSafeInteger(previousEntry.height) && previousEntry.height > 0
        && typeof previousEntry.sourceFormat === "string";

      let sourceBuffer;
      let sourceHash;
      let dimensions;
      if (canTrustSourceStat) {
        sourceHash = previousEntry.sourceHash;
        dimensions = { width: previousEntry.width, height: previousEntry.height, format: previousEntry.sourceFormat };
      } else {
        sourceBuffer = await readFile(sourcePath);
        sourceHash = digest(sourceBuffer);
        dimensions = await imageMetadata(sourceBuffer, sourcePath, autoRotate);
        sourceInfo = await sourceFileStat(sourcePath) ?? sourceInfo;
      }

      let fingerprint = digest(`${sourceHash}\0${pipeline}`);
      let expected = expectedVariants(fingerprint, dimensions, normalizeFormat(dimensions.format), options);
      let expectedByKey = new Map(expected.map((variant) => [variantKey(variant), variant]));

      const canReuse = cacheEntry?.fingerprint === fingerprint
        && previousEntry?.fingerprint === fingerprint
        && previousEntry.sourceHash === sourceHash
        && previousEntry.width === dimensions.width
        && previousEntry.height === dimensions.height
        && previousEntry.sourceFormat === dimensions.format;
      let verifiedVariants = canReuse
        ? await verifiedOutputVariants(outputDir, previousEntry.variants, expected, verification)
        : undefined;

      if (verifiedVariants === undefined && sourceBuffer === undefined) {
        sourceBuffer = await readFile(sourcePath);
        sourceInfo = await sourceFileStat(sourcePath) ?? sourceInfo;
        const actualHash = digest(sourceBuffer);
        if (actualHash !== sourceHash) {
          sourceHash = actualHash;
          dimensions = await imageMetadata(sourceBuffer, sourcePath, autoRotate);
          fingerprint = digest(`${sourceHash}\0${pipeline}`);
          expected = expectedVariants(fingerprint, dimensions, normalizeFormat(dimensions.format), options);
          expectedByKey = new Map(expected.map((variant) => [variantKey(variant), variant]));
          verifiedVariants = undefined;
        }
      }

      const isWarm = verifiedVariants !== undefined;
      let variants;
      if (isWarm) {
        variants = verifiedVariants;
        skipped++;
      } else {
        variants = carryForwardVariantDigests(expected, previousEntry?.variants);
        const missingVariants = [];
        for (const variant of variants) {
          const verified = await verifyVariant(outputDir, variant, expectedByKey.get(variantKey(variant)), "digest");
          if (!verified) missingVariants.push(variant);
          else Object.assign(variant, verified);
        }
        await mapConcurrent(missingVariants, Math.min(concurrency, 4), async (variant) => {
          const targetPath = await ensureVariantDirectory(outputDir, variant.file);
          const expectedVariant = expectedByKey.get(variantKey(variant));
          const output = await writeVariant(sourceBuffer, targetPath, variant, options, expectedVariant.height);
          if (output.width !== expectedVariant.width || !heightMatchesExpected(expectedVariant.height, output.height)) {
            throw new Error(`Generated ${variant.width}.${variant.format} has unexpected dimensions ${output.width}x${output.height}`);
          }
          Object.assign(variant, output);
        });
        processed++;
      }

      return {
        relativePath,
        sourceInfo,
        entry: {
          source: relativePath,
          fingerprint,
          sourceHash,
          sourceFormat: dimensions.format,
          width: dimensions.width,
          height: dimensions.height,
          variants,
        },
      };
    });

    for (const { relativePath, entry, sourceInfo } of results) {
      manifest.images[relativePath] = entry;
      cache.sources[relativePath] = {
        fingerprint: entry.fingerprint,
        ...(sourceInfo ? { sourceSize: sourceInfo.size, sourceMtimeNs: sourceInfo.mtimeNs } : {}),
        autoRotate,
      };
    }

    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    const oldManifestJson = JSON.stringify(oldManifest, null, 2);
    if (manifestJson !== `${oldManifestJson}\n`) await atomicWrite(manifestPath, manifestJson);
    const cacheJson = `${JSON.stringify(cache, null, 2)}\n`;
    if (cacheJson !== `${JSON.stringify(oldCache, null, 2)}\n`) await atomicWrite(cachePath, cacheJson);

    return { processed, skipped, imageCount: files.length, manifestPath: reportedManifestPath, legacyPublicManifestPath };
  } finally {
    await releaseLocks();
  }
}

/** Adopt existing image outputs into the current content-addressed layout without re-encoding. */
export async function adoptImageVariants(rawOptions, adoption) {
  const options = resolveOptions(rawOptions);
  if (!adoption || typeof adoption.sourcePath !== "string") {
    throw new TypeError("adoptImageVariants requires a sourcePath");
  }
  if (!/^[a-f0-9]{64}$/.test(adoption.sourceHash ?? "")) {
    throw new TypeError("adoptImageVariants requires a lowercase SHA-256 sourceHash");
  }
  if (!Array.isArray(adoption.variants)) {
    throw new TypeError("adoptImageVariants requires a variants array");
  }

  const { rootDir, sourceDirectories, publicDir, verification, autoRotate } = options;
  const sourcePath = path.resolve(rootDir, adoption.sourcePath);
  const relativePath = path.relative(rootDir, sourcePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Adopted source must remain inside rootDir: ${sourcePath}`);
  }

  const canonicalRoot = await realpath(rootDir);
  const canonicalSources = [];
  for (const sourceDirectory of sourceDirectories) {
    const relative = path.relative(rootDir, sourceDirectory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Image source directory must remain inside rootDir: ${sourceDirectory}`);
    }
    const canonicalSource = await canonicalizePath(sourceDirectory);
    if (!isInside(canonicalRoot, canonicalSource)) {
      throw new Error(`Image source directory must remain inside rootDir after resolving symlinks: ${sourceDirectory}`);
    }
    canonicalSources.push(canonicalSource);
  }

  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Adopted source must be a regular file, not a symlink: ${sourcePath}`);
  }
  const canonicalSourcePath = await realpath(sourcePath);
  if (!isInside(canonicalRoot, canonicalSourcePath) || !canonicalSources.some((directory) => isInside(directory, canonicalSourcePath))) {
    throw new Error(`Adopted source must be inside one of the configured image source directories: ${sourcePath}`);
  }

  const canonicalOutputDir = await canonicalizePath(options.outputDir);
  const canonicalCacheDir = await canonicalizePath(options.cacheDir);
  const canonicalPublicDir = await canonicalizePath(publicDir);
  if (pathsOverlap(canonicalOutputDir, canonicalCacheDir)) {
    throw new Error(`outputDir and cacheDir must not overlap: ${canonicalOutputDir} and ${canonicalCacheDir}`);
  }
  for (const [label, directory] of [["outputDir", canonicalOutputDir], ["cacheDir", canonicalCacheDir]]) {
    if (isInside(canonicalPublicDir, directory)) {
      throw new Error(`Image ${label} must be outside Astro's public directory, including through symlinks: ${directory}`);
    }
    if (canonicalSources.some((sourceDirectory) => pathsOverlap(sourceDirectory, directory))) {
      throw new Error(`Image ${label} must not overlap a scanned source directory, including through symlinks: ${directory}`);
    }
  }

  for (const [index, variant] of adoption.variants.entries()) {
    if (!variant || typeof variant.path !== "string") {
      throw new TypeError(`Adopted variant ${index} requires a path`);
    }
    validatePositiveInteger(variant.width, "variant width");
    const format = normalizeFormat(variant.format);
    if (!SUPPORTED_FORMATS.has(format)) {
      throw new TypeError(`Unsupported adopted variant format "${variant.format}"`);
    }
  }

  await mkdir(options.outputDir, { recursive: true });
  await mkdir(options.cacheDir, { recursive: true });
  const outputDir = await realpath(options.outputDir);
  const cacheDir = await realpath(options.cacheDir);
  const releaseLocks = await acquireWriterLocks([outputDir, cacheDir]);
  const createdPaths = [];
  try {
    const manifestPath = path.join(cacheDir, "manifest.json");
    const cachePath = path.join(cacheDir, "cache.json");
    const [oldManifest, oldCache] = await Promise.all([
      readJson(manifestPath, { version: MANIFEST_VERSION, images: {} }),
      readJson(cachePath, { version: CACHE_VERSION, sources: {} }),
    ]);
    const manifest = {
      version: MANIFEST_VERSION,
      images: oldManifest.images && typeof oldManifest.images === "object" ? { ...oldManifest.images } : {},
    };
    const cache = {
      version: CACHE_VERSION,
      sources: oldCache.sources && typeof oldCache.sources === "object" ? { ...oldCache.sources } : {},
    };
    const key = normalizeRelativePath(relativePath);
    const previousEntry = manifest.images[key];
    const cacheEntry = cache.sources[key];
    let sourceInfo = await sourceFileStat(sourcePath);
    const canTrustPrevious = verification === "stat"
      && sourceInfo
      && cacheEntry?.sourceSize === sourceInfo.size
      && cacheEntry?.sourceMtimeNs === sourceInfo.mtimeNs
      && cacheEntry?.autoRotate === autoRotate
      && previousEntry
      && previousEntry.sourceHash === adoption.sourceHash
      && Number.isSafeInteger(previousEntry.width) && previousEntry.width > 0
      && Number.isSafeInteger(previousEntry.height) && previousEntry.height > 0
      && typeof previousEntry.sourceFormat === "string";

    let sourceHash;
    let dimensions;
    if (canTrustPrevious) {
      sourceHash = adoption.sourceHash;
      dimensions = { width: previousEntry.width, height: previousEntry.height, format: previousEntry.sourceFormat };
    } else {
      const sourceBuffer = await readFile(sourcePath);
      sourceHash = digest(sourceBuffer);
      if (sourceHash !== adoption.sourceHash) {
        throw new Error(`Adopted source changed: expected SHA-256 ${adoption.sourceHash}, received ${sourceHash} for ${sourcePath}`);
      }
      dimensions = await imageMetadata(sourceBuffer, sourcePath, autoRotate);
      sourceInfo = await sourceFileStat(sourcePath) ?? sourceInfo;
    }

    const fingerprint = digest(`${sourceHash}\0${pipelineSettings(options)}`);
    const expected = expectedVariants(fingerprint, dimensions, normalizeFormat(dimensions.format), options);
    const supplied = new Map();
    for (const variant of adoption.variants) {
      const variantKeyValue = variantKey({ width: variant.width, format: normalizeFormat(variant.format) });
      if (supplied.has(variantKeyValue)) throw new Error(`Duplicate adopted variant for ${variant.width}.${normalizeFormat(variant.format)}`);
      supplied.set(variantKeyValue, variant);
    }
    for (const expectedVariant of expected) {
      if (!supplied.has(variantKey(expectedVariant))) {
        throw new Error(`Missing adopted variant ${expectedVariant.width}.${expectedVariant.format} for ${relativePath}`);
      }
    }

    const persistState = async () => {
      const manifestChanged = JSON.stringify(manifest.images[key]) !== JSON.stringify(oldManifest.images?.[key]);
      const cacheChanged = JSON.stringify(cache.sources[key]) !== JSON.stringify(oldCache.sources?.[key]);
      if (!manifestChanged && !cacheChanged) return;

      const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
      const cacheJson = `${JSON.stringify(cache, null, 2)}\n`;
      let oldCacheText;
      if (cacheChanged) {
        oldCacheText = await readFile(cachePath, "utf8").catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        await atomicWrite(cachePath, cacheJson);
      }
      try {
        if (manifestChanged) await atomicWrite(manifestPath, manifestJson);
      } catch (error) {
        if (cacheChanged) {
          if (oldCacheText === undefined) await unlink(cachePath).catch(() => {});
          else await atomicWrite(cachePath, oldCacheText).catch(() => {});
        }
        throw error;
      }
    };

    if (canTrustPrevious
      && previousEntry.fingerprint === fingerprint
      && cacheEntry?.fingerprint === fingerprint) {
      const verifiedVariants = await verifiedOutputVariants(outputDir, previousEntry.variants, expected, verification);
      if (verifiedVariants) {
        manifest.images[key] = { ...previousEntry, variants: verifiedVariants };
        cache.sources[key] = {
          fingerprint,
          sourceSize: sourceInfo.size,
          sourceMtimeNs: sourceInfo.mtimeNs,
          autoRotate,
        };
        await persistState();
        return { fingerprint, adopted: expected.length, reused: expected.length, manifestPath };
      }
    }

    const validated = [];
    for (const expectedVariant of expected) {
      const suppliedVariant = supplied.get(variantKey(expectedVariant));
      const inputPath = path.resolve(rootDir, suppliedVariant.path);
      const inputInfo = await lstat(inputPath);
      if (!inputInfo.isFile() || inputInfo.isSymbolicLink()) {
        throw new Error(`Adopted variant must be a regular file, not a symlink: ${inputPath}`);
      }
      const buffer = await readFile(inputPath);
      let metadata;
      try {
        metadata = await sharp(buffer, { failOn: "none" }).metadata();
      } catch (error) {
        throw new Error(`Unable to read adopted variant ${inputPath}: ${error.message}`, { cause: error });
      }
      const actualFormat = normalizeVariantFormat(metadata);
      const expectedHeight = expectedVariant.height;
      if (actualFormat !== expectedVariant.format || metadata.width !== expectedVariant.width || !heightMatchesExpected(expectedHeight, metadata.height)) {
        throw new Error(
          `Adopted variant ${inputPath} does not match expected ${expectedVariant.width}x${expectedHeight}±1 ${expectedVariant.format}; ` +
          `received ${metadata.width}x${metadata.height} ${actualFormat}.`,
        );
      }
      validated.push({
        ...expectedVariant,
        height: metadata.height,
        digest: digest(buffer),
        buffer,
      });
    }

    const writeTargets = [];
    for (const variant of validated) {
      const targetPath = await ensureVariantDirectory(outputDir, variant.file);
      try {
        const info = await lstat(targetPath);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`Refusing to replace an existing non-matching adopted output: ${targetPath}`);
        }
        const matched = await readMatchingVariant(outputDir, variant);
        if (!matched) {
          throw new Error(`Refusing to replace an existing non-matching adopted output: ${targetPath}`);
        }
        variant.size = matched.size;
        variant.mtimeNs = matched.mtimeNs;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        writeTargets.push({ targetPath, variant });
      }
    }

    for (const { targetPath, variant } of writeTargets) {
      await atomicWrite(targetPath, variant.buffer);
      const fileInfo = await lstat(targetPath, { bigint: true });
      variant.size = Number(fileInfo.size);
      variant.mtimeNs = fileInfo.mtimeNs.toString();
      createdPaths.push({ targetPath, variant });
    }

    if ((!canTrustPrevious || writeTargets.length > 0) && digest(await readFile(sourcePath)) !== sourceHash) {
      throw new Error(`Adopted source changed during migration: ${sourcePath}`);
    }

    const outputVariants = validated.map(({ buffer, ...variant }) => variant);
    manifest.images[key] = {
      source: key,
      fingerprint,
      sourceHash,
      sourceFormat: dimensions.format,
      width: dimensions.width,
      height: dimensions.height,
      variants: outputVariants,
    };
    cache.sources[key] = {
      fingerprint,
      ...(sourceInfo ? { sourceSize: sourceInfo.size, sourceMtimeNs: sourceInfo.mtimeNs } : {}),
      autoRotate,
    };
    await persistState();

    return {
      fingerprint,
      adopted: outputVariants.length,
      reused: outputVariants.length - writeTargets.length,
      manifestPath,
    };
  } catch (error) {
    for (const { targetPath, variant } of createdPaths.reverse()) {
      if (await variantMatches(outputDir, variant).catch(() => false)) await unlink(targetPath).catch(() => {});
    }
    throw error;
  } finally {
    await releaseLocks();
  }
}

/** Generate variants for exactly the requested source files, preserving unrelated manifest/cache entries. */
export async function processRequestedImages(rawOptions, requestedFiles) {
  if (!Array.isArray(requestedFiles)) {
    throw new TypeError("processRequestedImages requires an array of requested image paths");
  }
  return processImagesFromFiles(rawOptions, requestedFiles);
}

/** Generate content-addressed variants for every image under the configured source directories. */
export async function processImages(rawOptions) {
  return processImagesFromFiles(rawOptions, undefined);
}

export const DEFAULT_IMAGE_WIDTHS = DEFAULT_WIDTHS;
export const DEFAULT_IMAGE_FORMATS = DEFAULT_FORMATS;
