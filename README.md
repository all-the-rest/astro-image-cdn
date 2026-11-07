# @all-the.rest/astro-image-cdn

An Astro integration that creates content-addressed image variants in a persistent directory and wires those variants into Astro's native `Image`, `Picture`, and `getImage()` APIs.

Unlike Astro's built-in local service, generated variants are **not written to `dist/`**. They and the incremental cache remain in directories outside the site build output, so rebuilding the site does not throw away image work.

## Install

```sh
pnpm add @all-the.rest/astro-image-cdn
```

Sharp is included as a runtime dependency. Astro 7.4 or newer is required; the integration is verified with Astro 7.4.1.

## Configure

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import astroImageCdn from "@all-the.rest/astro-image-cdn";

export default defineConfig({
  integrations: [
    astroImageCdn({
      baseUrl: "https://images.example.com",
    }),
  ],
});
```

By default, the integration accepts imported local images from `src/`, writes generated image variants to `.imagedist/`, and stores the manifest and warm-cache state privately in `.astro-image-cdn/`. It processes only local images actually requested through Astro's `Image`, `Picture`, or `getImage()` APIs; it does not pre-scan or transform unrelated source images. Requested entries are merged into the private manifest/cache without dropping unrelated entries. The package does not create a public manifest. If a pre-existing `manifest.json` is found in the output directory while processing a requested image, it is left untouched and a warning explains how to inspect and manually move or remove it before publishing. The manifest contains source paths and hashes, so it belongs outside public output. The output and cache directories must be disjoint and are checked against Astro's resolved `outDir` and all canonicalized source roots.

Use Astro's native assets imports and components as usual:

```astro
---
import { Image, Picture, getImage } from "astro:assets";
import photo from "../assets/photo.jpg";

const socialImage = await getImage({ src: photo, width: 1200, format: "webp" });
---

<Image src={photo} widths={[256, 640, 1200]} format="webp" alt="A landscape" />
<Picture src={photo} widths={[256, 640, 1200]} formats={["avif", "webp"]} alt="A landscape" />
<meta property="og:image" content={socialImage.src} />
```

In production builds, `Image`, `Picture`, and `getImage()` generate absolute URLs under `baseUrl`. In `astro dev`, requested variants are served directly from `outputDir` at `/_astro-image-cdn/`; the URL is local and does not require a CDN upload. The integration does not upload assets, configure a CDN, deploy, or modify hosting configuration. Production output must be made available at the corresponding `baseUrl` by the site's separate publishing process.

For a locally linked package that should affect development only, set `devOnly: true`:

```js
astroImageCdn({
  devOnly: true,
})
```

With this option, `astro dev` installs the image service and local asset route, while `astro build`, preview, and sync leave Astro's configured image service unchanged and do not invoke this package's image processor.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | required unless `devOnly: true` | Public HTTP(S) CDN origin and optional path prefix. Usernames and passwords are rejected. It is not used by the local dev asset route. |
| `sources` | `["src"]` | Project-root-relative directories from which imported local images may be requested. No startup pre-scan is performed. |
| `outputDir` | `".imagedist"` | Persistent generated variants, relative to the project root. |
| `cacheDir` | `".astro-image-cdn"` | Private manifest and incremental fingerprints, relative to the project root. |
| `widths` | `[256, 640, 828, 1080, 1200, 1920, 2048]` | Requested widths; each source's native width is also generated. Values above the source width are omitted. |
| `formats` | `["avif", "webp"]` | Output encodings generated for every selected width. Supported: `avif`, `webp`, `jpeg`, `png`. |
| `quality` | `75` | Sharp encoder quality from 1 to 100. |
| `concurrency` | `4` | Maximum number of source images processed at once. |
| `devOnly` | `false` | Install the integration only for `astro dev`; other Astro commands retain their configured image service. |

Configured formats are generated alongside the source's native raster format (when supported). Astro 7.4's default output for raster images is WebP, independent of the order in `formats`; include `webp` or request a configured format explicitly. If the default or an explicit format is unavailable, the service reports which format needs to be added. For a custom `widths` list, include the widths used by your native image components. For a requested width between generated sizes, the service selects the next available variant, capped at the source's native width.

Animated or multi-page sources are rejected rather than silently flattened to a still frame, including GIF, WebP, AVIF sequences, and multi-page TIFF. Convert them to a static image or exclude them from the configured source directories.

SVG sources are copied through unchanged by default. The integration honors Astro's `image.dangerouslyProcessSVG` setting before rasterizing SVGs. Standalone `processImages()` calls also default to safe pass-through and require `dangerouslyProcessSVG: true` to create raster variants; only enable it for trusted SVG sources.

The generated transform is aspect-preserving. Per-image crops (a requested width/height ratio different from the source), `background` flattening, unsupported `fit` modes, and a per-image `quality` that differs from the integration setting are rejected instead of silently returning the wrong pixels. Use a pre-cropped source for alternate aspect ratios.

Image identity is the project-relative file path; no frontmatter, YAML sidecars, slugs, EXIF metadata, or generated content metadata are read. Imported local images inside `sources` are optimized. Astro's SVG component wrapper can omit its private filesystem path, so those SVG imports are resolved by basename and require a unique filename within `sources`. String/remote image sources are passed through as-is and are not optimized.

## Persistence and cache behavior

- Source bytes, encoder settings, the transform implementation version, and the Sharp/libvips versions are fingerprinted with SHA-256.
- Variant filenames include that fingerprint, width, and format. Each manifest variant stores a SHA-256 digest; warm-cache reuse verifies the digest and rejects symlinks instead of trusting file existence alone.
- Each manifest is checked against the complete set of variants expected for its source and current options, so empty or partial entries trigger repair rather than a false cache hit.
- The private cache and manifest are updated atomically and only when their contents change. Concurrent native image requests are deduplicated and batched per event-loop turn; batches are serialized through one writer queue, while the configured concurrency controls processing within each batch. A pre-existing `manifest.json` in `outputDir` is detected, reported in the processing result, and warned about when an Astro-requested image or standalone bulk run processes images; it is never modified. Verify its ownership, then manually move it outside public output or remove it before publishing. A filesystem lock allows only one process to write a given output/cache pair; overlapping processes fail with the lock path instead of racing. If a process is interrupted, verify it has stopped and remove any leftover `.astro-image-cdn.lock` file before retrying; the next run can rebuild missing variants.
- Warm runs re-hash source bytes but skip Sharp transformations when the fingerprint and every expected output still match.
- Old content-addressed files are intentionally retained. Request-driven Astro processing preserves unrelated manifest entries; an explicit standalone `processImages()` run reconciles the manifest with the files found under its source directories. Neither mode deletes historical output files.
- Astro's `dist/` remains Astro-owned; this package does not copy into, clean, or deploy it.

## API

The default export is the Astro integration. Its image processor runs only when a native Astro image API requests an imported local image. The exported `processImages()` API is a separate, explicit bulk operation for standalone build scripts; calling it scans every supported image under `sources`:

```js
import { processImages } from "@all-the.rest/astro-image-cdn";

const result = await processImages({
  rootDir: process.cwd(),
  sources: ["src"],
  outputDir: ".imagedist",
  cacheDir: ".astro-image-cdn",
});
console.log(result);
```

The returned counts distinguish newly processed images from warm-cache reuses. `manifestPath` points into the configured private `cacheDir`; `legacyPublicManifestPath` is set when a pre-existing public manifest was found. This API only generates files and a manifest; it performs no deployment.

The standalone processor rejects `outputDir` or `cacheDir` inside Astro's `publicDir`, including symlink aliases. It assumes `rootDir/public` by default; pass `publicDir` when the Astro project customizes that directory. The integration supplies Astro's configured `publicDir` automatically.

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm check
ratchet check
```

The tests include real Astro static builds using `Image`, `Picture`, and `getImage()`, a real dev-server request served from local output, unrequested-image checks, a repeated warm build, and assertions that optimized variants remain outside `dist/`.

The npm workflow publishes only pushed `vMAJOR.MINOR.PATCH` version tags whose version matches `package.json`; verification and packaging use pnpm in a separate job without OIDC, while the minimal publishing job downloads the verified tarball and uses npm CLI only for OIDC publishing. Configure `@all-the.rest/astro-image-cdn` on npm to trust this repository's `.github/workflows/publish.yml` and allow `npm publish`.

npm requires a package to exist before a trusted publisher can be configured ([`npm trust` prerequisites](https://docs.npmjs.com/cli/v12/commands/npm-trust/#prerequisites)). This package is not published yet, so its initial registry creation needs a separately approved one-time bootstrap path. After the package exists and the GitHub Actions trusted publisher is configured, version-tag releases use OIDC without a long-lived npm publish token. No package has been published by this project setup.

## Provenance and license

The image-processing behavior was independently reimplemented for this package after reviewing `packages/tools/scripts/process-images.mjs` in [reisinger.pictures](https://github.com/reisinger-pictures/reisinger.pictures). The upstream root `package.json` declares ISC, but that repository contains no root license text and the script has no separate copyright or license header; no source code was copied verbatim. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
