import type { AstroComponentFactory } from "astro/runtime/server/index.js";
import type { ImageMetadata } from "astro";

export interface CdnImageProps {
  /** Imported local image (Astro ImageMetadata). */
  src: ImageMetadata;
  /** Alternative text. */
  alt: string;
  /** Optional HTML sizes hint; forwarded to <source> and <img>. */
  sizes?: string;
}

declare const CdnImage: AstroComponentFactory & ((props: CdnImageProps) => unknown);
export default CdnImage;
