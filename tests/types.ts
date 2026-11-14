import astroImageCdn, {
  adoptImageVariants,
  type AstroImageCdnOptions,
  processImages,
  pruneImages,
  type PruneImagesResult,
} from "../src/index.js";

const options: AstroImageCdnOptions = {
  baseUrl: "https://images.example.com/site",
  sources: ["src"],
  widths: [320, 640],
  formats: ["avif", "webp"],
  webpEffort: 2,
  avifEffort: 7,
  verification: "stat",
  includeSourceFormat: false,
  includeNativeWidth: false,
  autoRotate: false,
  devOnly: true,
};

const integration = astroImageCdn(options);
const localDevIntegration = astroImageCdn({ devOnly: true });
const processing = processImages({ rootDir: process.cwd(), sources: ["src"], webpEffort: 0, avifEffort: 9 });
const adoption = adoptImageVariants({
  rootDir: process.cwd(),
  formats: ["webp"],
  includeSourceFormat: false,
  includeNativeWidth: false,
  autoRotate: false,
}, {
  sourcePath: "src/photo.jpg",
  sourceHash: "a".repeat(64),
  variants: [{ path: ".legacy/photo_256.webp", width: 256, format: "webp" }],
});
const pruning: Promise<PruneImagesResult> = pruneImages({
  rootDir: process.cwd(),
  sources: ["src"],
  dryRun: true,
  removeLegacyPublicManifest: false,
});
const legacyPublicManifestPath: Promise<string | undefined> = processing.then((result) => result.legacyPublicManifestPath);
const prunedFiles: Promise<number> = pruning.then((result) => result.removed);
void integration;
void localDevIntegration;
void processing;
void adoption;
void pruning;
void legacyPublicManifestPath;
void prunedFiles;
