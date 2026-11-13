import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import path from "node:path";
import { DEFAULT_IMAGE_FORMATS, DEFAULT_IMAGE_WIDTHS, resolveEncoderEfforts, resolveVerification } from "./processor.js";
import { installDevAssetMiddleware } from "./dev-server.js";

const serviceEntrypoint = fileURLToPath(new URL("./service.js", import.meta.url));

function normalizeBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("astroImageCdn requires an absolute http(s) baseUrl");
  }
  const authority = baseUrl.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "";
  if (url.username || url.password || authority.includes("@")) {
    throw new TypeError("baseUrl must not include username or password credentials");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
    throw new TypeError("baseUrl must be an http(s) origin/path without a query or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function resolveDirectories(rootDir, options) {
  return {
    sources: (options.sources ?? ["src"]).map((source) => path.resolve(rootDir, source)),
    outputDir: path.resolve(rootDir, options.outputDir ?? ".imagedist"),
    cacheDir: path.resolve(rootDir, options.cacheDir ?? ".astro-image-cdn"),
  };
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalizePath(value) {
  let candidate = path.resolve(value);
  const suffix = [];
  while (true) {
    try {
      return path.join(realpathSync(candidate), ...suffix.reverse());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function assertOutsideBuildOutput(candidate, outDir, label) {
  const canonicalOutDir = canonicalizePath(outDir);
  const canonicalCandidate = canonicalizePath(candidate);
  if (isInside(canonicalOutDir, canonicalCandidate)) {
    throw new Error(`astroImageCdn ${label} must be outside Astro's build output directory (${canonicalOutDir}); received ${canonicalCandidate}`);
  }
}

function assertOutsidePublicDirectory(candidate, publicDir, label) {
  const canonicalPublicDir = canonicalizePath(publicDir);
  const canonicalCandidate = canonicalizePath(candidate);
  if (isInside(canonicalPublicDir, canonicalCandidate)) {
    throw new Error(`astroImageCdn ${label} must be outside Astro's public directory (${canonicalPublicDir}); received ${canonicalCandidate}`);
  }
}

function assertDirectoriesDoNotOverlap(outputDir, cacheDir) {
  const canonicalOutputDir = canonicalizePath(outputDir);
  const canonicalCacheDir = canonicalizePath(cacheDir);
  if (isInside(canonicalOutputDir, canonicalCacheDir) || isInside(canonicalCacheDir, canonicalOutputDir)) {
    throw new Error(`astroImageCdn outputDir and cacheDir must not overlap; received ${canonicalOutputDir} and ${canonicalCacheDir}`);
  }
}

export default function astroImageCdn(options) {
  if (!options || (typeof options.baseUrl !== "string" && options.devOnly !== true)) {
    throw new TypeError("astroImageCdn requires a baseUrl unless devOnly is true");
  }
  const baseUrl = typeof options.baseUrl === "string" ? normalizeBaseUrl(options.baseUrl) : "";
  const { webpEffort, avifEffort } = resolveEncoderEfforts(options);
  const verification = resolveVerification(options);
  let projectRoot;
  let outputDir;
  let cacheDir;
  let imageOptions;
  let active = false;
  let devMode = false;

  return {
    name: "@all-the.rest/astro-image-cdn",
    hooks: {
      "astro:config:setup"({ config, command = "build", updateConfig }) {
        active = !options.devOnly || command === "dev";
        devMode = command === "dev";
        if (!active) return;
        projectRoot = realpathSync(fileURLToPath(config.root));
        const directories = resolveDirectories(projectRoot, options);
        outputDir = directories.outputDir;
        cacheDir = directories.cacheDir;
        imageOptions = {
          ...options,
          rootDir: projectRoot,
          sources: directories.sources,
          publicDir: config.publicDir ? fileURLToPath(config.publicDir) : path.join(projectRoot, "public"),
          outputDir,
          cacheDir,
          baseUrl,
          widths: options.widths ?? DEFAULT_IMAGE_WIDTHS,
          formats: options.formats ?? DEFAULT_IMAGE_FORMATS,
          quality: options.quality ?? 75,
          webpEffort,
          avifEffort,
          verification,
          includeSourceFormat: options.includeSourceFormat ?? true,
          includeNativeWidth: options.includeNativeWidth ?? true,
          autoRotate: options.autoRotate ?? true,
          concurrency: options.concurrency ?? 4,
          dangerouslyProcessSVG: config.image?.dangerouslyProcessSVG ?? false,
          devMode,
          requestSessionId: randomUUID(),
        };
        const vite = devMode
          ? {
              plugins: [{
                name: "@all-the.rest/astro-image-cdn:dev-assets",
                configureServer(server) {
                  installDevAssetMiddleware(server, outputDir);
                },
              }],
            }
          : {};
        updateConfig({
          image: {
            service: {
              entrypoint: serviceEntrypoint,
              config: imageOptions,
            },
          },
          vite,
        });
      },
      "astro:config:done"({ config }) {
        if (!active) return;
        const outDir = fileURLToPath(config.outDir);
        const publicDir = fileURLToPath(config.publicDir);
        assertOutsideBuildOutput(outputDir, outDir, "outputDir");
        assertOutsideBuildOutput(cacheDir, outDir, "cacheDir");
        assertOutsidePublicDirectory(outputDir, publicDir, "outputDir");
        assertOutsidePublicDirectory(cacheDir, publicDir, "cacheDir");
        assertDirectoriesDoNotOverlap(outputDir, cacheDir);
      },
    },
  };
}

export { adoptImageVariants, processImages } from "./processor.js";
