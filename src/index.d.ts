import type { AstroIntegration } from "astro";

interface AstroImageCdnBaseOptions {
  /** Directories that may contain imported local images, relative to Astro's project root. Defaults to ["src"]. */
  sources?: string[];
  /** Persistent generated image directory, relative to the project root. Defaults to ".imagedist". */
  outputDir?: string;
  /** Incremental state directory, relative to the project root. Defaults to ".astro-image-cdn". */
  cacheDir?: string;
  /** Widths generated in addition to each source image's native width. */
  widths?: number[];
  /** Output formats generated for every source. Defaults to ["avif", "webp"]. */
  formats?: Array<"avif" | "webp" | "jpeg" | "png">;
  /** Encoder quality from 1 to 100. Defaults to 75. */
  quality?: number;
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

export default function astroImageCdn(options: AstroImageCdnOptions): AstroIntegration;

export declare function processImages(options: ProcessImagesOptions): Promise<ProcessImagesResult>;
