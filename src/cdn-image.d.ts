import type { AstroComponentFactory } from "astro/runtime/server/index.js";
import type { ImageMetadata } from "astro";
import type { HTMLAttributes } from "astro/types";

/** Official <img> attributes minus the pipeline-derived ones. */
export type CdnImageProps = Omit<
  HTMLAttributes<"img">,
  "src" | "srcset" | "width" | "height" | "style"
> & {
  /** Imported local image (Astro ImageMetadata). */
  src: ImageMetadata;
  /** Alternative text. */
  alt: string;
  /** Optional HTML sizes hint; forwarded to <source> and <img>. */
  sizes?: string;
  /** Optional class for the <picture> wrapper (layout only). */
  pictureClass?: string;
  /** Any other prop is forwarded as an HTML attribute to the <img>. */
  [key: string]: unknown;
};

declare const CdnImage: AstroComponentFactory & ((props: CdnImageProps) => unknown);
export default CdnImage;
