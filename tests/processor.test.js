import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { adoptImageVariants, processImages, processRequestedImages } from "../src/processor.js";

async function createProject() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-processor-"));
  const sourceDir = path.join(rootDir, "src", "images");
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "sample.png");
  await sharp({ create: { width: 700, height: 350, channels: 3, background: "#527faa" } }).png().toFile(sourcePath);
  return { rootDir, sourcePath };
}

function createAnimatedGif() {
  const frame = (pixels) => [
    0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, ...pixels, 0,
  ];
  return Buffer.from([
    ...Buffer.from("GIF89a"), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff,
    ...frame([0x44, 1]), ...frame([0x4c, 1]), 0x3b,
  ]);
}

function createAvifSequence() {
  // AVIF image-sequence fixture: libvips does not expose its pages as metadata.
  const base64 = [
    "AAAAKGZ0eXBhdmlzAAAAAG1pZjFhdmlmbWlhZm1zZjFpc29tYXZpcwAAAmNtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAABkAAAA",
    "FAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAACAAAB73RyYWsAAABcdGtoZAAAAAcAAAAAAAAAAAAAAAEAAAAAAAAAFAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAA",
    "AAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAAYttZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAABkAAAAFFXLAAAAAAAh",
    "aGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAFCbWluZgAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAA",
    "AQJzdGJsAAAAgnN0c2QAAAAAAAAAAQAAAHJhdjAxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABBEFW",
    "SUYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAADGF2MUOBTWwAAAAAEGNjc3QAAAAAQAAAAAAAABhzdHRzAAAAAAAA",
    "AAEAAAACAAAACgAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAADAAAAAlAAAAFHN0Y28A",
    "AAAAAAAAAQAAA5oAAAAUc3RzcwAAAAAAAAABAAAAAQAAABR2bWhkAAAAAQAAAAAAAAAAAAAA1m1ldGEAAAAAAAAAIWhkbHIAAAAA",
    "AAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAImlsb2MAAAAAREAAAQABAAAAAANpAAEAAAAAAAAAKQAAACNpaW5mAAAAAAABAAAAFWlu",
    "ZmUCAAAAAAEAAGF2MDEAAAAADnBpdG0AAAAAAAEAAABWaXBycAAAADhpcGNvAAAADGF2MUOBQGwAAAAAFGlzcGUAAAAAAAAAEAAA",
    "ABAAAAAQcGl4aQAAAAADDAwMAAAAFmlwbWEAAAAAAAAAAQABA4ECAwAAADFtZGF0EgAKCVgM/9rQENBuEDIaGUeHhiGJpppmgAAA",
    "dYVc0uZTmGBAnA0nRrQAAABdbWRhdBIACg1AAAABn/m18tAQ0G4QMh0QAJo9PTNIAA8IAAAAOtj12fiiNiX40fxovSzXgBIAMiEw",
    "A8CAAAAGyjw8MQwAA0AAEAB1hXUEqy50en58lLxdqxg=",
  ].join("");
  return Buffer.from(base64, "base64");
}

test("generates content-addressed variants outside dist and reuses warm outputs", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const options = {
    rootDir,
    sources: ["src"],
    outputDir: ".imagedist",
    cacheDir: ".astro-image-cdn",
    widths: [256, 640],
    formats: ["webp", "avif"],
    quality: 70,
  };
  const legacyPublicManifest = path.join(rootDir, ".imagedist", "manifest.json");
  await mkdir(path.dirname(legacyPublicManifest), { recursive: true });
  await writeFile(legacyPublicManifest, "legacy public manifest");
  const first = await processImages(options);
  assert.equal(first.processed, 1);
  assert.equal(first.skipped, 0);
  assert.equal(first.imageCount, 1);
  assert.equal(path.relative(rootDir, first.manifestPath), path.join(".astro-image-cdn", "manifest.json"));
  assert.equal(first.legacyPublicManifestPath, await realpath(legacyPublicManifest));
  assert.equal(await readFile(legacyPublicManifest, "utf8"), "legacy public manifest");

  const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
  const entry = manifest.images["src/images/sample.png"];
  assert.equal(entry.width, 700);
  assert.equal(entry.height, 350);
  const expectedFingerprint = createHash("sha256")
    .update(`${entry.sourceHash}\0${JSON.stringify({
      widths: [256, 640],
      formats: ["webp", "avif"],
      quality: 70,
      transformVersion: 3,
      sharpVersion: sharp.versions.sharp,
      libvipsVersion: sharp.versions.vips,
      dangerouslyProcessSVG: false,
      includeSourceFormat: true,
      includeNativeWidth: true,
      autoRotate: true,
    })}`)
    .digest("hex");
  assert.equal(entry.fingerprint, expectedFingerprint, "the fingerprint should include Sharp, libvips, and transform versions");
  assert.deepEqual(entry.variants.map(({ width, format }) => `${width}.${format}`), [
    "256.webp", "256.avif", "256.png", "640.webp", "640.avif", "640.png", "700.webp", "700.avif", "700.png",
  ]);

  const assetPaths = entry.variants.map(({ file }) => path.join(rootDir, ".imagedist", file));
  const optimizedMetadata = await sharp(assetPaths[0]).metadata();
  assert.equal(optimizedMetadata.width, 256);
  assert.equal(optimizedMetadata.format, "webp");
  const beforeStats = await Promise.all(assetPaths.map((filePath) => stat(filePath)));
  const second = await processImages(options);
  const afterStats = await Promise.all(assetPaths.map((filePath) => stat(filePath)));
  assert.equal(second.processed, 0);
  assert.equal(second.skipped, 1);
  assert.deepEqual(afterStats.map(({ mtimeMs }) => mtimeMs), beforeStats.map(({ mtimeMs }) => mtimeMs));
  assert.equal(await readFile(path.join(rootDir, ".astro-image-cdn", "cache.json"), "utf8").then(JSON.parse).then((cache) => cache.sources["src/images/sample.png"].fingerprint), entry.fingerprint);

  const changedSourcePath = sourcePath;
  await sharp({ create: { width: 700, height: 350, channels: 3, background: "#c2513e" } }).png().toFile(changedSourcePath);
  const changed = await processImages(options);
  assert.equal(changed.processed, 1);
  assert.equal(changed.skipped, 0);
  assert.notEqual(JSON.parse(await readFile(first.manifestPath, "utf8")).images["src/images/sample.png"].fingerprint, entry.fingerprint);

  const changedEntry = JSON.parse(await readFile(first.manifestPath, "utf8")).images["src/images/sample.png"];
  const missingVariantPath = path.join(rootDir, ".imagedist", changedEntry.variants[0].file);
  await rm(missingVariantPath);
  const repaired = await processImages(options);
  assert.equal(repaired.processed, 1);
  assert.equal(repaired.skipped, 0);
  assert.ok(await stat(missingVariantPath));

  const outputEntries = await readdir(path.join(rootDir, ".imagedist"));
  assert.ok(outputEntries.includes("manifest.json"));
  assert.equal(await readFile(legacyPublicManifest, "utf8"), "legacy public manifest");
  assert.equal(path.relative(path.join(rootDir, "dist"), path.join(rootDir, ".imagedist")).startsWith(".."), true);
});

test("output options select exact formats and widths and can disable EXIF auto-rotation", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await sharp({ create: { width: 700, height: 350, channels: 3, background: "#527faa" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(sourcePath.replace(/\.png$/, ".jpg"));
  await rm(sourcePath);
  const orientedSourcePath = sourcePath.replace(/\.png$/, ".jpg");
  const options = {
    rootDir,
    widths: [256, 640, 828],
    formats: ["webp"],
    includeSourceFormat: false,
    includeNativeWidth: false,
    autoRotate: false,
  };

  await processImages(options);
  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");
  let entry = JSON.parse(await readFile(manifestPath, "utf8")).images["src/images/sample.jpg"];
  assert.equal(entry.width, 700);
  assert.equal(entry.height, 350);
  assert.deepEqual(entry.variants.map(({ width, format }) => `${width}.${format}`), ["256.webp", "640.webp"]);
  assert.equal((await sharp(path.join(rootDir, ".imagedist", entry.variants[0].file)).metadata()).height, 128);

  await processImages({ ...options, autoRotate: true });
  const rotatedEntry = JSON.parse(await readFile(manifestPath, "utf8")).images["src/images/sample.jpg"];
  assert.notEqual(rotatedEntry.fingerprint, entry.fingerprint, "auto-rotation must be part of the pipeline identity");
  assert.equal(rotatedEntry.width, 350);
  assert.equal(rotatedEntry.height, 700);
  assert.deepEqual(rotatedEntry.variants.map(({ width, format }) => `${width}.${format}`), ["256.webp"]);
  assert.equal((await sharp(path.join(rootDir, ".imagedist", rotatedEntry.variants[0].file)).metadata()).height, 512);
});

test("adopts and reuses Sharp's one-pixel height rounding for JPEG resize", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const jpegPath = sourcePath.replace(/\.png$/, ".jpg");
  await sharp({ create: { width: 2769, height: 4154, channels: 3, background: "#527faa" } }).jpeg({ quality: 90 }).toFile(jpegPath);
  await rm(sourcePath);
  const source = await readFile(jpegPath);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const legacyDir = path.join(rootDir, ".legacy-image-variants");
  await mkdir(legacyDir, { recursive: true });
  const legacyVariants = [];
  for (const width of [256, 828]) {
    const variantPath = path.join(legacyDir, `sample_${width}.webp`);
    await sharp(source).resize({ width, withoutEnlargement: true }).webp({ quality: 75 }).toFile(variantPath);
    legacyVariants.push({ path: variantPath, width, format: "webp" });
  }

  const options = {
    rootDir,
    widths: [256, 828],
    formats: ["webp"],
    includeSourceFormat: false,
    includeNativeWidth: false,
    autoRotate: false,
  };
  const adoption = await adoptImageVariants(options, {
    sourcePath: jpegPath,
    sourceHash,
    variants: legacyVariants,
  });

  assert.equal(adoption.adopted, 2);
  const packageManifestPath = adoption.manifestPath;
  const previousManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
  const previousEntry = previousManifest.images["src/images/sample.jpg"];
  for (const variant of previousEntry.variants) {
    variant.height = Math.round(variant.width * 4154 / 2769);
  }
  await writeFile(packageManifestPath, `${JSON.stringify(previousManifest, null, 2)}\n`);

  let entry = JSON.parse(await readFile(packageManifestPath, "utf8")).images["src/images/sample.jpg"];
  const wideVariant = entry.variants.find(({ width }) => width === 828);
  const widePath = path.join(rootDir, ".imagedist", wideVariant.file);
  const wideBytesBeforeRepair = await readFile(widePath);
  const narrowVariant = entry.variants.find(({ width }) => width === 256);
  await rm(path.join(rootDir, ".imagedist", narrowVariant.file));
  const partialRepair = await processImages(options);
  assert.equal(partialRepair.processed, 1);
  entry = JSON.parse(await readFile(packageManifestPath, "utf8")).images["src/images/sample.jpg"];
  assert.deepEqual(entry.variants.map(({ width, height }) => [width, height]), [[256, 384], [828, 1243]]);
  assert.deepEqual(await readFile(widePath), wideBytesBeforeRepair, "valid adopted variants remain untouched during partial repair");

  const staleVariantManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
  const staleEntry = staleVariantManifest.images["src/images/sample.jpg"];
  const staleWideVariant = staleEntry.variants.find(({ width }) => width === 828);
  const invalidTwoPixelOutput = await sharp({
    create: { width: 828, height: 1244, channels: 3, background: "#527faa" },
  }).webp({ quality: 75 }).toBuffer();
  await writeFile(widePath, invalidTwoPixelOutput);
  staleWideVariant.height = 1243;
  staleWideVariant.digest = createHash("sha256").update(invalidTwoPixelOutput).digest("hex");
  await writeFile(packageManifestPath, `${JSON.stringify(staleVariantManifest, null, 2)}\n`);
  const staleNarrowVariant = staleEntry.variants.find(({ width }) => width === 256);
  await rm(path.join(rootDir, ".imagedist", staleNarrowVariant.file));
  await processImages(options);
  entry = JSON.parse(await readFile(packageManifestPath, "utf8")).images["src/images/sample.jpg"];
  assert.deepEqual(entry.variants.map(({ width, height }) => [width, height]), [[256, 384], [828, 1243]]);
  assert.notDeepEqual(await readFile(widePath), invalidTwoPixelOutput, "height errors beyond one pixel are regenerated");

  const staleManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
  for (const variant of staleManifest.images["src/images/sample.jpg"].variants) {
    variant.height = Math.round(variant.width * 4154 / 2769);
  }
  await writeFile(packageManifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`);
  const warm = await processImages(options);
  assert.equal(warm.processed, 0);
  assert.equal(warm.skipped, 1);
  entry = JSON.parse(await readFile(packageManifestPath, "utf8")).images["src/images/sample.jpg"];
  assert.deepEqual(entry.variants.map(({ width, height }) => [width, height]), [[256, 384], [828, 1243]]);
});

test("SVG partial repair resets tolerated manifest height to the source height", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-svg-height-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const sourceDir = path.join(rootDir, "src", "images");
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "sample.svg");
  await writeFile(sourcePath, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect width="100" height="50" fill="#527faa"/></svg>');
  const options = { rootDir, formats: ["webp"], includeSourceFormat: false };
  await processImages(options);

  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest.images["src/images/sample.svg"];
  const variant = entry.variants[0];
  variant.height = 51;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(path.join(rootDir, ".imagedist", variant.file));

  const result = await processImages(options);
  assert.equal(result.processed, 1);
  const repairedEntry = JSON.parse(await readFile(manifestPath, "utf8")).images["src/images/sample.svg"];
  assert.equal(repairedEntry.variants[0].height, 50);
});

async function createAdoptionFixtures(rootDir, sourcePath) {
  const sourceHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  const legacyDir = path.join(rootDir, ".legacy-image-variants");
  await mkdir(legacyDir, { recursive: true });
  const variants = [];
  for (const width of [256, 640]) {
    const variantPath = path.join(legacyDir, `sample_${width}.webp`);
    await sharp(sourcePath).resize({ width, withoutEnlargement: true }).webp({ quality: 75 }).toFile(variantPath);
    variants.push({ path: variantPath, width, format: "webp" });
  }
  return { sourceHash, variants };
}

const adoptionOptions = (rootDir) => ({
  rootDir,
  widths: [256, 640, 828],
  formats: ["webp"],
  includeSourceFormat: false,
  includeNativeWidth: false,
  autoRotate: false,
});

test("adopts matching existing variants, reuses them warm, and is idempotent", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const { sourceHash, variants } = await createAdoptionFixtures(rootDir, sourcePath);
  const options = adoptionOptions(rootDir);
  const input = { sourcePath, sourceHash, variants };

  const first = await adoptImageVariants(options, input);
  assert.equal(first.adopted, 2);
  assert.equal(first.reused, 0);
  const manifestBefore = await readFile(first.manifestPath, "utf8");
  const entry = JSON.parse(manifestBefore).images["src/images/sample.png"];
  assert.deepEqual(entry.variants.map(({ width, format }) => `${width}.${format}`), ["256.webp", "640.webp"]);
  for (const variant of entry.variants) {
    const targetPath = path.join(rootDir, ".imagedist", variant.file);
    assert.equal(createHash("sha256").update(await readFile(targetPath)).digest("hex"), variant.digest);
  }

  const second = await adoptImageVariants(options, input);
  assert.equal(second.reused, 2);
  assert.equal(await readFile(first.manifestPath, "utf8"), manifestBefore);
  const warm = await processImages(options);
  assert.equal(warm.processed, 0);
  assert.equal(warm.skipped, 1, "the adopted manifest and files should be a normal warm cache entry");
});

test("rejects stale sources and incomplete variant sets without changing prior state", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const { sourceHash, variants } = await createAdoptionFixtures(rootDir, sourcePath);
  const options = adoptionOptions(rootDir);
  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");

  await assert.rejects(
    adoptImageVariants(options, { sourcePath, sourceHash, variants: variants.slice(0, 1) }),
    /Missing adopted variant 640\.webp/,
  );
  await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(rootDir, ".imagedist")), []);

  await writeFile(sourcePath, "changed source bytes");
  await assert.rejects(
    adoptImageVariants(options, { sourcePath, sourceHash, variants }),
    /Adopted source changed/,
  );
  await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(rootDir, ".imagedist")), []);
});

test("rejects adopted outputs with the wrong dimensions or encoding before writing state", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const { sourceHash, variants } = await createAdoptionFixtures(rootDir, sourcePath);
  await sharp(sourcePath).resize({ width: 128 }).webp().toFile(variants[0].path);

  await assert.rejects(
    adoptImageVariants(adoptionOptions(rootDir), { sourcePath, sourceHash, variants }),
    /does not match expected 256x128±1 webp/,
  );
  await assert.rejects(readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json")), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(rootDir, ".imagedist")), []);
  assert.ok(await stat(variants[0].path), "invalid legacy outputs are only read, never modified or removed");

  await sharp(sourcePath).resize({ width: 256 }).png().toFile(variants[0].path);
  await assert.rejects(
    adoptImageVariants(adoptionOptions(rootDir), { sourcePath, sourceHash, variants }),
    /expected 256x128±1 webp; received 256x128 png/,
  );
  await assert.rejects(readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json")), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(rootDir, ".imagedist")), []);
});

test("distinguishes AVIF from other HEIF media during adoption", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const sourceHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  const legacyDir = path.join(rootDir, ".legacy-image-variants");
  await mkdir(legacyDir, { recursive: true });
  const variants = [];
  let avifBytes;
  for (const width of [256, 640]) {
    const variantPath = path.join(legacyDir, `sample_${width}.avif`);
    const bytes = await sharp(sourcePath).resize({ width, withoutEnlargement: true }).avif({ quality: 75 }).toBuffer();
    await writeFile(variantPath, bytes);
    if (width === 256) avifBytes = bytes;
    variants.push({ path: variantPath, width, format: "avif" });
  }

  const options = { ...adoptionOptions(rootDir), formats: ["avif"] };
  const heicBytes = Buffer.from(avifBytes);
  heicBytes.write("heic", 8, "ascii");
  await writeFile(variants[0].path, heicBytes);
  await assert.rejects(
    adoptImageVariants(options, { sourcePath, sourceHash, variants }),
    /expected 256x128±1 avif; received 256x128 heif/,
  );
  await assert.rejects(readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json")), { code: "ENOENT" });

  await writeFile(variants[0].path, avifBytes);
  const adoption = await adoptImageVariants(options, { sourcePath, sourceHash, variants });
  assert.equal(adoption.adopted, 2);
});

test("cleans newly adopted files and preserves the old manifest after a state-read failure", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const { sourceHash, variants } = await createAdoptionFixtures(rootDir, sourcePath);
  const cacheDir = path.join(rootDir, ".astro-image-cdn");
  const manifestPath = path.join(cacheDir, "manifest.json");
  const oldManifest = JSON.stringify({ version: 2, images: { prior: { source: "prior" } } }, null, 2) + "\n";
  await mkdir(cacheDir, { recursive: true });
  await writeFile(manifestPath, oldManifest);
  await mkdir(path.join(cacheDir, "cache.json"));

  await assert.rejects(
    adoptImageVariants(adoptionOptions(rootDir), { sourcePath, sourceHash, variants }),
    /cache\.json/,
  );
  assert.equal(await readFile(manifestPath, "utf8"), oldManifest);
  for (const width of [256, 640]) {
    const fingerprintPrefix = await createHash("sha256").update(`${sourceHash}\0${JSON.stringify({
      widths: [256, 640, 828],
      formats: ["webp"],
      quality: 75,
      transformVersion: 3,
      sharpVersion: sharp.versions.sharp,
      libvipsVersion: sharp.versions.vips,
      dangerouslyProcessSVG: false,
      includeSourceFormat: false,
      includeNativeWidth: false,
      autoRotate: false,
    })}`).digest("hex");
    await assert.rejects(stat(path.join(rootDir, ".imagedist", fingerprintPrefix.slice(0, 2), `${fingerprintPrefix}_${width}.webp`)), { code: "ENOENT" });
  }
  assert.ok(await stat(variants[0].path), "the legacy source variant must not be removed");
});

test("fresh output does not contain a public manifest", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const result = await processImages({ rootDir });

  assert.equal(result.legacyPublicManifestPath, undefined);
  await assert.rejects(stat(path.join(rootDir, ".imagedist", "manifest.json")), { code: "ENOENT" });
  assert.ok(await stat(path.join(rootDir, ".astro-image-cdn", "manifest.json")));
});

test("targeted image batches deduplicate files, preserve unrelated state, and leave warm files untouched", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const otherPath = path.join(rootDir, "src", "images", "other.png");
  await sharp({ create: { width: 480, height: 240, channels: 3, background: "#c2513e" } }).png().toFile(otherPath);
  const options = { rootDir, widths: [256], formats: ["webp"] };
  await processImages(options);

  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");
  const cachePath = path.join(rootDir, ".astro-image-cdn", "cache.json");
  const originalManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const originalCache = JSON.parse(await readFile(cachePath, "utf8"));
  const otherEntry = originalManifest.images["src/images/other.png"];

  await sharp({ create: { width: 700, height: 350, channels: 3, background: "#395f35" } }).png().toFile(sourcePath);
  const targeted = await processRequestedImages(options, [sourcePath, sourcePath]);
  assert.equal(targeted.imageCount, 1, "duplicate API requests should be processed once per batch");
  assert.equal(targeted.processed, 1);
  const manifestAfterTarget = JSON.parse(await readFile(manifestPath, "utf8"));
  const cacheAfterTarget = JSON.parse(await readFile(cachePath, "utf8"));
  assert.deepEqual(manifestAfterTarget.images["src/images/other.png"], otherEntry);
  assert.deepEqual(cacheAfterTarget.sources["src/images/other.png"], originalCache.sources["src/images/other.png"]);
  assert.notEqual(manifestAfterTarget.images["src/images/sample.png"].fingerprint, originalManifest.images["src/images/sample.png"].fingerprint);

  const manifestStatBeforeWarm = await stat(manifestPath);
  const cacheStatBeforeWarm = await stat(cachePath);
  const manifestTextBeforeWarm = await readFile(manifestPath, "utf8");
  const cacheTextBeforeWarm = await readFile(cachePath, "utf8");
  const warm = await processRequestedImages(options, [sourcePath]);
  assert.equal(warm.processed, 0);
  assert.equal(warm.skipped, 1);
  assert.equal((await stat(manifestPath)).mtimeMs, manifestStatBeforeWarm.mtimeMs);
  assert.equal((await stat(cachePath)).mtimeMs, cacheStatBeforeWarm.mtimeMs);
  assert.equal(await readFile(manifestPath, "utf8"), manifestTextBeforeWarm);
  assert.equal(await readFile(cachePath, "utf8"), cacheTextBeforeWarm);
});

test("rejects invalid encoder settings before touching output", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await assert.rejects(
    processImages({ rootDir, formats: ["gif"] }),
    /Unsupported configured output format/,
  );
  await assert.rejects(
    processImages({ rootDir, sources: ["../outside"] }),
    /must remain inside rootDir/,
  );
});

test("rejects source directories whose symlinks resolve outside the project root", async (t) => {
  const { rootDir } = await createProject();
  const outsideDir = `${rootDir}-outside`;
  t.after(() => Promise.all([
    rm(rootDir, { recursive: true, force: true }),
    rm(outsideDir, { recursive: true, force: true }),
  ]));
  await mkdir(outsideDir);
  await symlink(outsideDir, path.join(rootDir, "src", "images", "external"), "dir");

  await assert.rejects(
    processImages({ rootDir, sources: ["src/images/external"] }),
    /must remain inside rootDir after resolving symlinks/,
  );
});

test("rejects output and cache directories that overlap scanned roots after resolving symlinks", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await symlink(path.join(rootDir, "src"), path.join(rootDir, "source-alias"), "dir");

  const cases = [
    { sources: ["src"], outputDir: "src/generated", cacheDir: ".cache-test" },
    { sources: ["src"], outputDir: ".output-test", cacheDir: "src/generated-cache" },
    { sources: ["source-alias"], outputDir: "src/generated-through-alias", cacheDir: ".cache-alias-test" },
  ];
  for (const options of cases) {
    await assert.rejects(
      processImages({ rootDir, ...options }),
      /must not overlap a scanned source directory, including through symlinks/,
    );
  }

  await assert.rejects(
    processImages({ rootDir, outputDir: ".shared-state", cacheDir: ".shared-state/cache" }),
    /outputDir and cacheDir must not overlap/,
  );
});

test("rejects standalone outputs and cache inside Astro publicDir, including symlink aliases", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const publicDir = path.join(rootDir, "public");
  await mkdir(publicDir);
  await symlink(publicDir, path.join(rootDir, "public-alias"), "dir");
  await mkdir(path.join(rootDir, "static"));

  const cases = [
    { outputDir: "public/generated" },
    { cacheDir: "public/.cache" },
    { outputDir: "public-alias/generated" },
    { publicDir: "static", cacheDir: "static/.cache" },
  ];
  for (const options of cases) {
    await assert.rejects(
      processImages({ rootDir, ...options }),
      /must be outside Astro's public directory, including through symlinks/,
    );
  }

  await assert.rejects(stat(path.join(rootDir, ".imagedist")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(rootDir, ".astro-image-cdn")), { code: "ENOENT" });
});

test("keeps standalone SVG rasterization disabled unless explicitly opted in", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const svgPath = path.join(rootDir, "src", "images", "icon.svg");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#527faa"/></svg>');
  await writeFile(svgPath, svg);

  const options = { rootDir, widths: [16], formats: ["webp"] };
  await processImages(options);
  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");
  let manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let variants = manifest.images["src/images/icon.svg"].variants;
  assert.deepEqual(variants.map(({ format }) => format), ["svg"]);
  assert.deepEqual(await readFile(path.join(rootDir, ".imagedist", variants[0].file)), svg);

  await processImages({ ...options, dangerouslyProcessSVG: true });
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  variants = manifest.images["src/images/icon.svg"].variants;
  assert.ok(variants.some(({ format }) => format === "webp"));
  assert.ok(variants.every(({ digest }) => /^[a-f0-9]{64}$/.test(digest)));
});

test("verifies variant digests without following symlinks and safely repairs bad files", async (t) => {
  const { rootDir } = await createProject();
  const externalPath = `${rootDir}-external.bin`;
  t.after(() => Promise.all([
    rm(rootDir, { recursive: true, force: true }),
    rm(externalPath, { force: true }),
  ]));
  const options = { rootDir, widths: [256], formats: ["webp"] };
  await processImages(options);
  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");
  let entry = JSON.parse(await readFile(manifestPath, "utf8")).images["src/images/sample.png"];
  const variant = entry.variants.find(({ format }) => format === "webp");
  const variantPath = path.join(rootDir, ".imagedist", variant.file);
  const originalDigest = variant.digest;
  assert.match(originalDigest, /^[a-f0-9]{64}$/);

  await writeFile(variantPath, "corrupted output");
  await processImages(options);
  entry = JSON.parse(await readFile(manifestPath, "utf8")).images["src/images/sample.png"];
  assert.equal(entry.variants.find(({ format }) => format === "webp").digest, originalDigest);
  assert.equal(createHash("sha256").update(await readFile(variantPath)).digest("hex"), originalDigest);

  await writeFile(externalPath, "external target must remain unchanged");
  await rm(variantPath);
  await symlink(externalPath, variantPath);
  await processImages(options);
  const repairedInfo = await lstat(variantPath);
  assert.ok(repairedInfo.isFile());
  assert.equal(repairedInfo.isSymbolicLink(), false);
  assert.equal(await readFile(externalPath, "utf8"), "external target must remain unchanged");
  entry = JSON.parse(await readFile(manifestPath, "utf8")).images["src/images/sample.png"];
  assert.equal(createHash("sha256").update(await readFile(variantPath)).digest("hex"), entry.variants.find(({ format }) => format === "webp").digest);
});

test("rebuilds the complete expected variant set from empty or partial manifests", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const options = { rootDir, widths: [256], formats: ["webp"] };
  await processImages(options);
  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");

  for (const keepVariants of [0, 1]) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.images["src/images/sample.png"];
    const expected = entry.variants.map(({ width, format, file }) => `${width}:${format}:${file}`);
    entry.variants = entry.variants.slice(0, keepVariants);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await processImages(options);
    const repaired = JSON.parse(await readFile(manifestPath, "utf8")).images["src/images/sample.png"];
    assert.equal(result.processed, 1, `a ${keepVariants ? "partial" : "empty"} variant set should not be considered warm`);
    assert.deepEqual(repaired.variants.map(({ width, format, file }) => `${width}:${format}:${file}`), expected);
    assert.ok(repaired.variants.every(({ digest }) => /^[a-f0-9]{64}$/.test(digest)));
  }
});

test("rejects animated and multi-page sources across formats", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const animatedGif = createAnimatedGif();
  const animatedWebp = await sharp(animatedGif, { pages: -1 }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  const multipageTiff = await sharp(animatedGif, { pages: -1 }).tiff().toBuffer();
  const avifSequence = createAvifSequence();
  const cases = [
    ["animated.gif", animatedGif],
    ["animated.webp", animatedWebp],
    ["multipage.tiff", multipageTiff],
    ["animated.avif", avifSequence],
  ];

  for (const [filename, contents] of cases) {
    const imageDirectory = path.join(rootDir, "src", "images", path.parse(filename).name);
    await mkdir(imageDirectory, { recursive: true });
    await writeFile(path.join(imageDirectory, filename), contents);
    await assert.rejects(
      processImages({ rootDir, sources: [path.relative(rootDir, imageDirectory)] }),
      /Animated or multi-page image sources are not supported/,
      `${filename} should be rejected before frame flattening`,
    );
  }
});

test("serializes concurrent writers before they read or update shared state", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const options = { rootDir, widths: [256], formats: ["webp"] };
  const results = await Promise.allSettled([processImages(options), processImages(options)]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Another astro-image-cdn process is already writing/);
  const manifest = JSON.parse(await readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.images), ["src/images/sample.png"]);
  await assert.rejects(stat(path.join(rootDir, ".imagedist", ".astro-image-cdn.lock")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(rootDir, ".astro-image-cdn", ".astro-image-cdn.lock")), { code: "ENOENT" });
});
