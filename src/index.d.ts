import type { AstroIntegration } from "astro";

interface AstroImageCdnBaseOptions {
  /** Directories that may contain imported local images, relative to Astro's project root. Defaults to ["src"]. */
  sources?: string[];
  /** Persistent generated image directory, relative to the project root. Defaults to ".imagedist". */
  outputDir?: string;
  /** Incremental state directory, relative to the project root. Defaults to ".astro-image-cdn". */
  cacheDir?: string;
  /** Configured widths; values above the source width are omitted. */
  widths?: number[];
  /** Output formats generated for every source. Defaults to ["avif", "webp"]. */
  formats?: Array<"avif" | "webp" | "jpeg" | "png">;
  /** Encoder quality from 1 to 100. Defaults to 75. */
  quality?: number;
  /** WebP encoder effort, integer from 0 (fastest) to 6 (slowest). Defaults to Sharp's default, 4. */
  webpEffort?: number;
  /** AVIF encoder effort, integer from 0 (fastest) to 9 (slowest). Defaults to Sharp's default, 4. */
  avifEffort?: number;
  /**
   * Warm-cache verification strategy. "stat" (default) trusts recorded file size and mtime,
   * avoiding source/output reads when nothing changed. "digest" re-hashes every source and
   * output on every run.
   */
  verification?: "stat" | "digest";
  /** Also generate a supported source-native format. Defaults to true. */
  includeSourceFormat?: boolean;
  /** Also generate the source's native width when it is not configured. Defaults to true. */
  includeNativeWidth?: boolean;
  /** Apply EXIF orientation before resizing. Defaults to true. */
  autoRotate?: boolean;
  /** Maximum number of images processed concurrently. Defaults to 4. */
  concurrency?: number;
}

export type AstroImageCdnOptions = AstroImageCdnBaseOptions & (
  | {
      /** Public HTTP(S) CDN origin and optional path prefix. */
      baseUrl: string;
      devOnly?: false;
    }
  | {
      /** Optional because development assets are served locally in dev-only mode. */
      baseUrl?: string;
      /** Enable only for `astro dev`; build, preview, and sync leave Astro's image service unchanged. */
      devOnly: true;
    }
);

export interface ProcessImagesOptions extends AstroImageCdnBaseOptions {
  rootDir: string;
  /** Astro's public directory, relative to rootDir. Defaults to "public". */
  publicDir?: string;
  /** Permit Sharp to rasterize trusted SVG sources. Defaults to false. */
  dangerouslyProcessSVG?: boolean;
}

export interface ProcessImagesResult {
  processed: number;
  skipped: number;
  imageCount: number;
  manifestPath: string;
  legacyPublicManifestPath?: string;
}

export interface AdoptImageVariant {
  /** Existing encoded output path; relative paths are resolved from rootDir. */
  path: string;
  width: number;
  format: "avif" | "webp" | "jpeg" | "png" | "svg";
}

export interface AdoptImageVariantsInput {
  /** Existing source path, relative to rootDir or absolute. */
  sourcePath: string;
  /** SHA-256 of the source bytes when the existing variants were produced. */
  sourceHash: string;
  /** Existing variants to adopt; every output required by the options must be supplied. */
  variants: AdoptImageVariant[];
}

export interface AdoptImageVariantsResult {
  fingerprint: string;
  adopted: number;
  reused: number;
  manifestPath: string;
}

export default function astroImageCdn(options: AstroImageCdnOptions): AstroIntegration;

export declare function processImages(options: ProcessImagesOptions): Promise<ProcessImagesResult>;
export declare function adoptImageVariants(
  options: ProcessImagesOptions,
  input: AdoptImageVariantsInput,
): Promise<AdoptImageVariantsResult>;
