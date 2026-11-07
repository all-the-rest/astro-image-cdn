import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import imageService from "../src/service.js";

const imageConfig = {
  service: {
    config: {
      formats: ["avif", "webp"],
      quality: 75,
    },
  },
};

const image = { src: "/_astro/photo.hash.png", width: 800, height: 600, format: "png" };

test("rejects image transforms that the static CDN variants cannot honor", () => {
  assert.throws(
    () => imageService.validateOptions({ src: image, width: 400, height: 400, fit: "cover" }, imageConfig),
    /per-image cropping is not supported/,
  );
  assert.throws(
    () => imageService.validateOptions({ src: image, width: 400, background: "#fff" }, imageConfig),
    /background flattening/,
  );
  assert.throws(
    () => imageService.validateOptions({ src: image, quality: "mid" }, imageConfig),
    /per-image quality mid \(50\) is not available/,
  );
});

test("allows aspect-preserving native dimensions and the source's output format", () => {
  const options = imageService.validateOptions({ src: image, width: 400, height: 300, format: "png" }, imageConfig);
  assert.equal(options.format, "png");
});

test("defaults raster images to WebP and explains when that output is unavailable", () => {
  assert.equal(imageService.validateOptions({ src: image }, imageConfig).format, "webp");

  const avifOnlyConfig = {
    service: { config: { ...imageConfig.service.config, formats: ["avif"] } },
  };
  assert.throws(
    () => imageService.validateOptions({ src: image }, avifOnlyConfig),
    /Astro 7\.4 defaults raster images to "webp".*Add "webp".*explicit configured format/,
  );
  assert.equal(imageService.validateOptions({ src: image, format: "avif" }, avifOnlyConfig).format, "avif");

  const unsupportedConfig = {
    service: { config: { ...imageConfig.service.config, formats: ["gif"] } },
  };
  assert.throws(
    () => imageService.validateOptions({ src: image }, unsupportedConfig),
    /unsupported configured output format.*Supported output formats are avif, webp, jpeg, or png/i,
  );
});

test("validates source-format availability when only configured output formats are generated", () => {
  const webpOnlyConfig = {
    service: {
      config: { ...imageConfig.service.config, formats: ["webp"], includeSourceFormat: false },
    },
  };
  assert.equal(imageService.validateOptions({ src: image }, webpOnlyConfig).format, "webp");
  assert.throws(
    () => imageService.validateOptions({ src: image, format: "png" }, webpOnlyConfig),
    /format "png" is not configured for generation/,
  );
});

test("preserves Astro validation for remote dimensions and incompatible descriptors", () => {
  assert.throws(
    () => imageService.validateOptions({ src: "https://images.example.test/photo.jpg" }, imageConfig),
    /require width and height/,
  );
  assert.throws(
    () => imageService.validateOptions({ src: "https://images.example.test/photo.jpg", width: 400 }, imageConfig),
    /require height/,
  );
  assert.equal(
    imageService.validateOptions({ src: "https://images.example.test/photo.jpg", width: 400, height: 300 }, imageConfig).height,
    300,
  );
  assert.throws(
    () => imageService.validateOptions({ src: image, widths: [256, 640], densities: [1, 2] }, imageConfig),
    /cannot specify both widths and densities/,
  );
});

test("rejects remote URLs with credentials before dimension validation without echoing them", () => {
  const source = "https://private-user:top-secret@images.example.test/photo.jpg";
  const cases = [
    { src: source },
    { src: source, width: 400, height: 300 },
    { src: "https://@images.example.test/photo.jpg", width: 400, height: 300 },
    { src: " \thttps://@images.example.test/photo.jpg", width: 400, height: 300 },
  ];

  for (const options of cases) {
    assert.throws(
      () => imageService.validateOptions(options, imageConfig),
      (error) => error instanceof TypeError
        && /(must not include username or password credentials|must not contain whitespace or control characters)/.test(error.message)
        && !error.message.includes("private-user")
        && !error.message.includes("top-secret")
        && !error.message.includes("images.example.test")
        && !error.message.includes(source),
    );
  }
});

test("keeps SVG pass-through as the default and gates raster output on Astro's opt-in", () => {
  const svgImage = { src: "/_astro/icon.12345678.svg", width: 32, height: 16, format: "svg" };
  assert.equal(imageService.validateOptions({ src: svgImage }, imageConfig).format, "svg");
  assert.throws(
    () => imageService.validateOptions({ src: svgImage, format: "webp" }, imageConfig),
    /SVG image processing is disabled/,
  );

  const optedInConfig = {
    service: {
      config: { ...imageConfig.service.config, dangerouslyProcessSVG: true },
    },
  };
  assert.equal(imageService.validateOptions({ src: svgImage }, optedInConfig).format, "svg");
  assert.equal(imageService.validateOptions({ src: svgImage, format: "webp" }, optedInConfig).format, "webp");
});

test("batches concurrent native requests and processes each source once before resolving srcsets", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-service-batch-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const sourceDir = path.join(rootDir, "src", "images");
  await mkdir(sourceDir, { recursive: true });
  const sourcePaths = ["first.png", "second.png"].map((fileName) => path.join(sourceDir, fileName));
  await Promise.all(sourcePaths.map((sourcePath, index) => sharp({
    create: { width: 64, height: 32, channels: 3, background: index ? "#c2513e" : "#527faa" },
  }).png().toFile(sourcePath)));
  const imageConfigForBatch = {
    service: {
      config: {
        rootDir,
        sources: [sourceDir],
        outputDir: path.join(rootDir, ".imagedist"),
        cacheDir: path.join(rootDir, ".astro-image-cdn"),
        widths: [32],
        formats: ["webp"],
        quality: 75,
        concurrency: 2,
        dangerouslyProcessSVG: false,
        baseUrl: "https://cdn.example.test",
        devMode: false,
      },
    },
  };
  const messages = [];
  const logger = { info(message) { messages.push(message); }, warn() {}, error() {} };
  const results = await Promise.all(sourcePaths.map((fsPath) => imageService.getSrcSet({
    src: { src: `/@fs/${fsPath}`, fsPath, width: 64, height: 32, format: "png" },
    width: 32,
    height: 16,
    format: "webp",
    widths: [32],
  }, imageConfigForBatch, logger)));

  assert.equal(messages.length, 1, "parallel source requests should share one targeted processor call");
  assert.match(messages[0], /2 processed, 0 reused/);
  assert.deepEqual(results.map((result) => result.length), [1, 1]);
  const manifest = JSON.parse(await readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.images).sort(), ["src/images/first.png", "src/images/second.png"]);
});

test("reprocesses a requested dev image after its source changes and keeps warm requests cached", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-service-dev-refresh-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const sourceDir = path.join(rootDir, "src", "images");
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "photo.png");
  const writePhoto = (background) => sharp({
    create: { width: 64, height: 32, channels: 3, background },
  }).png().toFile(sourcePath);
  await writePhoto("#527faa");

  const imageConfigForDev = {
    service: {
      config: {
        rootDir,
        sources: [sourceDir],
        outputDir: path.join(rootDir, ".imagedist"),
        cacheDir: path.join(rootDir, ".astro-image-cdn"),
        widths: [32],
        formats: ["webp"],
        quality: 75,
        concurrency: 1,
        dangerouslyProcessSVG: false,
        baseUrl: "https://cdn.example.test",
        devMode: true,
      },
    },
  };
  const messages = [];
  const logger = { info(message) { messages.push(message); }, warn() {}, error() {} };
  const options = {
    src: { src: `/@fs/${sourcePath}`, fsPath: sourcePath, width: 64, height: 32, format: "png" },
    width: 32,
    height: 16,
    format: "webp",
  };

  const initialUrl = await imageService.getURL(options, imageConfigForDev, logger);
  assert.equal(await imageService.getURL(options, imageConfigForDev, logger), initialUrl);
  assert.equal(messages.length, 1, "unchanged dev sources should not be processed again");

  await writePhoto("#c2513e");
  const updatedUrl = await imageService.getURL(options, imageConfigForDev, logger);
  assert.notEqual(updatedUrl, initialUrl, "changed source contents should resolve to a new content-addressed URL");
  assert.equal(messages.length, 2);
  assert.match(messages[1], /1 processed, 0 reused/);
  assert.equal(await imageService.getURL(options, imageConfigForDev, logger), updatedUrl);
  assert.equal(messages.length, 2, "the refreshed source should remain cached while unchanged");
});
