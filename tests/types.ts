import astroImageCdn, { type AstroImageCdnOptions, processImages } from "../src/index.js";

const options: AstroImageCdnOptions = {
  baseUrl: "https://images.example.com/site",
  sources: ["src"],
  widths: [320, 640],
  formats: ["avif", "webp"],
  devOnly: true,
};

const integration = astroImageCdn(options);
const localDevIntegration = astroImageCdn({ devOnly: true });
const processing = processImages({ rootDir: process.cwd(), sources: ["src"] });
const legacyPublicManifestPath: Promise<string | undefined> = processing.then((result) => result.legacyPublicManifestPath);
void integration;
void localDevIntegration;
void processing;
void legacyPublicManifestPath;
