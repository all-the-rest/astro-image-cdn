import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { processImages, pruneImages } from "../src/processor.js";

async function createProject() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-prune-"));
  const sourceDir = path.join(rootDir, "src", "images");
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "sample.png");
  await sharp({ create: { width: 700, height: 350, channels: 3, background: "#527faa" } }).png().toFile(sourcePath);
  return { rootDir, sourcePath };
}

const processingOptions = (rootDir) => ({
  rootDir,
  widths: [256, 640],
  formats: ["webp"],
  includeSourceFormat: false,
  includeNativeWidth: false,
});

test("removes only unreferenced output files, empty directories, and leaves sources alone", async (t) => {
  const { rootDir, sourcePath } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await processImages(processingOptions(rootDir));

  const outputDir = path.join(rootDir, ".imagedist");
  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest.images["src/images/sample.png"];
  const referencedPaths = entry.variants.map(({ file }) => path.join(outputDir, file));
  assert.equal(referencedPaths.length, 2);
  const referencedBytes = await Promise.all(referencedPaths.map((filePath) => readFile(filePath)));
  const sourceBytes = await readFile(sourcePath);

  const orphanPath = path.join(outputDir, "ff", "orphan.webp");
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await writeFile(orphanPath, Buffer.alloc(11, 1));
  const nestedStalePath = path.join(outputDir, "aa", "bb", "stale.bin");
  await mkdir(path.dirname(nestedStalePath), { recursive: true });
  await writeFile(nestedStalePath, Buffer.alloc(7, 2));
  await mkdir(path.join(outputDir, "cc", "empty"), { recursive: true });
  const nestedLockPath = path.join(outputDir, "gg", ".astro-image-cdn.lock");
  await mkdir(path.dirname(nestedLockPath), { recursive: true });
  await writeFile(nestedLockPath, Buffer.alloc(3, 5));

  const result = await pruneImages({ rootDir, dryRun: false });

  assert.equal(result.dryRun, false);
  assert.equal(result.removed, 3);
  assert.equal(result.kept, 2);
  assert.equal(result.bytesFreed, 21);
  assert.equal(result.removedDirectories, 6);
  assert.equal(result.legacyPublicManifestPath, undefined);
  assert.equal(result.legacyPublicManifestRemoved, false);
  assert.equal(path.relative(rootDir, result.manifestPath), path.join(".astro-image-cdn", "manifest.json"));

  await assert.rejects(stat(orphanPath), { code: "ENOENT" });
  await assert.rejects(stat(nestedStalePath), { code: "ENOENT" });
  await assert.rejects(stat(path.join(outputDir, "aa")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(outputDir, "cc")), { code: "ENOENT" });
  await assert.rejects(stat(nestedLockPath), { code: "ENOENT" });
  await assert.rejects(stat(path.join(outputDir, "gg")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(outputDir, ".astro-image-cdn.lock")), { code: "ENOENT" });
  assert.deepEqual(await Promise.all(referencedPaths.map((filePath) => readFile(filePath))), referencedBytes);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assert.ok(await stat(outputDir), "outputDir itself must be retained");
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).images["src/images/sample.png"].fingerprint, entry.fingerprint);
});

test("dry run reports counts without deleting or removing directories", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await processImages(processingOptions(rootDir));
  const outputDir = path.join(rootDir, ".imagedist");
  const orphanPath = path.join(outputDir, "ee", "orphan.webp");
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await writeFile(orphanPath, Buffer.alloc(5, 3));

  const dryRun = await pruneImages({ rootDir, dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.removed, 1);
  assert.equal(dryRun.kept, 2);
  assert.equal(dryRun.bytesFreed, 5);
  assert.equal(dryRun.removedDirectories, 1);
  await stat(orphanPath);
  await stat(path.join(outputDir, "ee"));

  const applied = await pruneImages({ rootDir });
  assert.equal(applied.removed, 1);
  assert.equal(applied.kept, 2);
  assert.equal(applied.bytesFreed, 5);
  assert.equal(applied.removedDirectories, 1);
  await assert.rejects(stat(orphanPath), { code: "ENOENT" });
  await assert.rejects(stat(path.join(outputDir, "ee")), { code: "ENOENT" });
});

test("never follows or removes symlinks and leaves their targets untouched", async (t) => {
  const { rootDir } = await createProject();
  const externalDir = `${rootDir}-external`;
  const externalFile = path.join(externalDir, "victim.bin");
  t.after(() => Promise.all([
    rm(rootDir, { recursive: true, force: true }),
    rm(externalDir, { recursive: true, force: true }),
  ]));
  await processImages(processingOptions(rootDir));
  await mkdir(externalDir, { recursive: true });
  await writeFile(externalFile, "external target must remain unchanged");
  await writeFile(path.join(externalDir, "other.bin"), "other external file");

  const outputDir = path.join(rootDir, ".imagedist");
  const manifest = JSON.parse(await readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json"), "utf8"));
  const referenced = manifest.images["src/images/sample.png"].variants.map(({ file }) => path.join(outputDir, file));
  const linkedDirectory = path.join(outputDir, "linked-directory");
  await symlink(externalDir, linkedDirectory, "dir");
  const linkedFile = path.join(outputDir, path.basename(path.dirname(referenced[0])), "linked.webp");
  await symlink(externalFile, linkedFile);
  const orphanPath = path.join(outputDir, "dd", "orphan.webp");
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await writeFile(orphanPath, Buffer.alloc(9, 4));

  const result = await pruneImages({ rootDir });

  assert.equal(result.removed, 1);
  assert.equal(result.bytesFreed, 9);
  assert.equal(result.kept, 4, "two referenced variants and two symlinks are kept");
  assert.equal(result.removedDirectories, 1);
  assert.ok((await lstat(linkedDirectory)).isSymbolicLink());
  assert.ok((await lstat(linkedFile)).isSymbolicLink());
  assert.equal(await readFile(externalFile, "utf8"), "external target must remain unchanged");
  assert.equal((await readdir(externalDir)).sort().join(","), "other.bin,victim.bin");
  await assert.rejects(stat(orphanPath), { code: "ENOENT" });
  for (const filePath of referenced) assert.ok((await lstat(filePath)).isFile());
});

test("reports and optionally removes a legacy public manifest", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await processImages(processingOptions(rootDir));
  const legacyManifestPath = path.join(rootDir, ".imagedist", "manifest.json");
  const legacyBytes = Buffer.from("legacy public manifest");
  await writeFile(legacyManifestPath, legacyBytes);

  const kept = await pruneImages({ rootDir });
  assert.equal(kept.legacyPublicManifestPath, legacyManifestPath);
  assert.equal(kept.legacyPublicManifestRemoved, false);
  assert.equal(kept.removed, 0);
  assert.equal(kept.kept, 3);
  assert.deepEqual(await readFile(legacyManifestPath), legacyBytes);

  const dryRun = await pruneImages({ rootDir, dryRun: true, removeLegacyPublicManifest: true });
  assert.equal(dryRun.legacyPublicManifestPath, legacyManifestPath);
  assert.equal(dryRun.legacyPublicManifestRemoved, true);
  assert.equal(dryRun.removed, 1);
  assert.equal(dryRun.bytesFreed, legacyBytes.length);
  assert.equal(dryRun.kept, 2);
  assert.deepEqual(await readFile(legacyManifestPath), legacyBytes);

  const removed = await pruneImages({ rootDir, removeLegacyPublicManifest: true });
  assert.equal(removed.legacyPublicManifestPath, legacyManifestPath);
  assert.equal(removed.legacyPublicManifestRemoved, true);
  assert.equal(removed.removed, 1);
  assert.equal(removed.bytesFreed, legacyBytes.length);
  assert.equal(removed.kept, 2);
  await assert.rejects(stat(legacyManifestPath), { code: "ENOENT" });

  const again = await pruneImages({ rootDir, removeLegacyPublicManifest: true });
  assert.equal(again.legacyPublicManifestPath, undefined);
  assert.equal(again.legacyPublicManifestRemoved, false);
  assert.equal(again.removed, 0);

  const legacyTargetPath = path.join(rootDir, "legacy-target.txt");
  await writeFile(legacyTargetPath, "must not be deleted through the legacy manifest symlink");
  await symlink(legacyTargetPath, legacyManifestPath);
  const linked = await pruneImages({ rootDir, removeLegacyPublicManifest: true });
  assert.equal(linked.legacyPublicManifestPath, legacyManifestPath);
  assert.equal(linked.legacyPublicManifestRemoved, true);
  assert.equal(linked.removed, 1);
  assert.equal(linked.bytesFreed, 0, "removing a symlink frees no target bytes");
  assert.equal(await readFile(legacyTargetPath, "utf8"), "must not be deleted through the legacy manifest symlink");
  await assert.rejects(lstat(legacyManifestPath), { code: "ENOENT" });

  await mkdir(legacyManifestPath);
  const orphanPath = path.join(rootDir, ".imagedist", "zz", "orphan.webp");
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await writeFile(orphanPath, "kept because pruning refused");
  await assert.rejects(
    pruneImages({ rootDir, removeLegacyPublicManifest: true }),
    /legacy manifest path .* is not a file/,
  );
  assert.equal(await readFile(orphanPath, "utf8"), "kept because pruning refused");
});

test("refuses to prune without a manifest or with unsafe manifest entries", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const outputDir = path.join(rootDir, ".imagedist");
  const orphanPath = path.join(outputDir, "aa", "orphan.webp");
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await writeFile(orphanPath, "unreferenced");

  await assert.rejects(pruneImages({ rootDir }), /Refusing to prune image variants: no manifest at .*manifest\.json/);
  assert.equal(await readFile(orphanPath, "utf8"), "unreferenced");

  await processImages(processingOptions(rootDir));
  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const variants = manifest.images["src/images/sample.png"].variants;
  const variantPaths = variants.map(({ file }) => path.join(outputDir, file));
  const original = JSON.parse(JSON.stringify(manifest));

  manifest.images["src/images/sample.png"].variants[0].file = "../outside.webp";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(pruneImages({ rootDir }), /which is outside outputDir/);
  for (const filePath of variantPaths) await stat(filePath);

  await writeFile(manifestPath, JSON.stringify({ version: 2, images: { broken: { source: "broken" } } }));
  await assert.rejects(pruneImages({ rootDir }), /has an unexpected entry for broken/);
  for (const filePath of variantPaths) await stat(filePath);

  await writeFile(manifestPath, JSON.stringify({ version: 2, images: [] }));
  await assert.rejects(pruneImages({ rootDir }), /has no images object/);
  await writeFile(manifestPath, `${JSON.stringify(original, null, 2)}\n`);
  for (const filePath of variantPaths) await stat(filePath);
});

test("prune cleans an empty manifest but keeps output and cache directories", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const outputDir = path.join(rootDir, ".imagedist");
  await mkdir(path.join(outputDir, "aa"), { recursive: true });
  await writeFile(path.join(outputDir, "aa", "stale.webp"), "stale");
  await mkdir(path.join(rootDir, ".astro-image-cdn"), { recursive: true });
  await writeFile(path.join(rootDir, ".astro-image-cdn", "manifest.json"), `${JSON.stringify({ version: 2, images: {} }, null, 2)}\n`);

  const result = await pruneImages({ rootDir });
  assert.equal(result.removed, 1);
  assert.equal(result.kept, 0);
  assert.equal(result.bytesFreed, 5);
  assert.equal(result.removedDirectories, 1);
  assert.ok(await stat(outputDir));
  assert.ok(await stat(path.join(rootDir, ".astro-image-cdn")));
  assert.deepEqual(await readdir(outputDir), []);
});

test("rejects an outputDir equal to or containing rootDir independent of sources", async (t) => {
  const container = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-prune-container-"));
  const externalCacheDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-prune-cache-"));
  t.after(() => Promise.all([
    rm(container, { recursive: true, force: true }),
    rm(externalCacheDir, { recursive: true, force: true }),
  ]));
  const rootDir = path.join(container, "project");
  const sourcePath = path.join(rootDir, "src", "images", "sample.png");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await sharp({ create: { width: 32, height: 16, channels: 3, background: "#527faa" } }).png().toFile(sourcePath);
  const markerPath = path.join(rootDir, "project-marker.txt");
  await writeFile(markerPath, "must not be deleted");
  const sourceBytes = await readFile(sourcePath);

  for (const outputDir of [rootDir, container]) {
    await assert.rejects(
      pruneImages({ rootDir, sources: [], outputDir, cacheDir: externalCacheDir }),
      /outputDir must not equal or contain rootDir/,
      `${outputDir} must be rejected even when no sources are configured`,
    );
  }
  assert.equal(await readFile(markerPath, "utf8"), "must not be deleted");
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assert.deepEqual(await readdir(externalCacheDir), [], "validation must reject before creating or locking the cache");
});

test("validates referenced variants exist without following symlinks before deleting anything", async (t) => {
  const { rootDir } = await createProject();
  const externalDir = `${rootDir}-referenced-external`;
  t.after(() => Promise.all([
    rm(rootDir, { recursive: true, force: true }),
    rm(externalDir, { recursive: true, force: true }),
  ]));
  await processImages(processingOptions(rootDir));
  const outputDir = path.join(rootDir, ".imagedist");
  const manifestPath = path.join(rootDir, ".astro-image-cdn", "manifest.json");
  const entry = JSON.parse(await readFile(manifestPath, "utf8")).images["src/images/sample.png"];
  const variantPaths = entry.variants.map(({ file }) => path.join(outputDir, file));
  const variantBytes = await readFile(variantPaths[0]);
  const orphanPath = path.join(outputDir, "qq", "orphan.webp");
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await writeFile(orphanPath, "unreferenced but must survive refusals");

  await rm(variantPaths[0]);
  await assert.rejects(pruneImages({ rootDir }), /references missing or unsafe file/);
  assert.equal(await readFile(orphanPath, "utf8"), "unreferenced but must survive refusals");
  await stat(variantPaths[1]);

  await writeFile(variantPaths[0], variantBytes);
  await mkdir(externalDir, { recursive: true });
  const externalFile = path.join(externalDir, "target.webp");
  await writeFile(externalFile, "referenced symlink target must remain");
  await rm(variantPaths[0]);
  await symlink(externalFile, variantPaths[0]);
  await assert.rejects(pruneImages({ rootDir }), /references missing or unsafe file/);
  assert.equal(await readFile(externalFile, "utf8"), "referenced symlink target must remain");
  assert.equal(await readFile(orphanPath, "utf8"), "unreferenced but must survive refusals");

  await rm(variantPaths[0]);
  await writeFile(variantPaths[0], variantBytes);
  const prefixDirectory = path.dirname(variantPaths[0]);
  await rename(prefixDirectory, `${prefixDirectory}-backup`);
  await mkdir(path.join(externalDir, "prefix"), { recursive: true });
  const externalVariant = path.join(externalDir, "prefix", path.basename(variantPaths[0]));
  await writeFile(externalVariant, "referenced variant in a symlinked directory must remain");
  await symlink(path.join(externalDir, "prefix"), prefixDirectory, "dir");
  await assert.rejects(pruneImages({ rootDir }), /references missing or unsafe file/);
  assert.equal(await readFile(externalVariant, "utf8"), "referenced variant in a symlinked directory must remain");
  assert.equal(await readFile(orphanPath, "utf8"), "unreferenced but must survive refusals");
});

test("rejects unsafe output directories and serializes concurrent prunes", async (t) => {
  const { rootDir } = await createProject();
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, "public"));
  await mkdir(path.join(rootDir, "deliverables", "public"), { recursive: true });
  await assert.rejects(
    pruneImages({ rootDir, outputDir: "public/generated" }),
    /must be outside Astro's public directory, including through symlinks/,
  );
  await assert.rejects(
    pruneImages({ rootDir, outputDir: "src/generated" }),
    /must not overlap a scanned source directory, including through symlinks/,
  );
  await assert.rejects(
    pruneImages({ rootDir, outputDir: ".shared", cacheDir: ".shared/cache" }),
    /outputDir and cacheDir must not overlap/,
  );
  await assert.rejects(
    pruneImages({ rootDir, outputDir: "deliverables", publicDir: "deliverables/public" }),
    /outputDir must not overlap Astro's public directory/,
  );

  await processImages(processingOptions(rootDir));
  const results = await Promise.allSettled([pruneImages({ rootDir }), pruneImages({ rootDir })]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Another astro-image-cdn process is already writing/);
  assert.equal(fulfilled[0].value.removed, 0);
  await assert.rejects(stat(path.join(rootDir, ".imagedist", ".astro-image-cdn.lock")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(rootDir, ".astro-image-cdn", ".astro-image-cdn.lock")), { code: "ENOENT" });
});
