import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import sharp from "sharp";
import { build, dev } from "astro";
import astroImageCdn from "../src/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integrationEntrypoint = pathToFileURL(path.join(packageRoot, "src", "index.js")).href;

test("rejects CDN base URLs containing credentials without echoing them", () => {
  for (const baseUrl of [
    "https://user:secret@cdn.example.test/images",
    "https://:secret@cdn.example.test/images",
    "https://@cdn.example.test/images",
  ]) {
    assert.throws(
      () => astroImageCdn({ baseUrl }),
      (error) => error instanceof TypeError
        && /must not include username or password credentials/.test(error.message)
        && !error.message.includes("secret")
        && !error.message.includes("user:"),
    );
  }
});

test("build setup does not scan sources or modify a pre-existing public manifest", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-legacy-manifest-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, "src"), { recursive: true });
  await sharp({ create: { width: 32, height: 16, channels: 3, background: "#476e91" } })
    .png()
    .toFile(path.join(rootDir, "src", "sample.png"));

  const outputDir = path.join(rootDir, ".imagedist");
  const legacyManifestPath = path.join(outputDir, "manifest.json");
  const legacyManifest = "another app's manifest; do not overwrite";
  await mkdir(outputDir, { recursive: true });
  await writeFile(legacyManifestPath, legacyManifest);

  const integration = astroImageCdn({ baseUrl: "https://cdn.example.test" });
  let configUpdates = 0;
  integration.hooks["astro:config:setup"]({
    config: { root: pathToFileURL(`${rootDir}${path.sep}`), image: {} },
    command: "build",
    updateConfig() { configUpdates++; },
  });

  assert.equal(configUpdates, 1, "the normal integration still installs its build image service");
  assert.equal(integration.hooks["astro:build:start"], undefined, "build start must not pre-scan sources");
  assert.equal(await readFile(legacyManifestPath, "utf8"), legacyManifest);
  await assert.rejects(stat(path.join(rootDir, ".astro-image-cdn", "manifest.json")), { code: "ENOENT" });
});

test("Astro Image, Picture, and getImage build to external variants and warm without rewriting cache", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-astro-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const imageDir = path.join(rootDir, "src", "assets");
  const duplicateImageDir = path.join(rootDir, "src", "other");
  const pageDir = path.join(rootDir, "src", "pages");
  await symlink(path.join(packageRoot, "node_modules"), path.join(rootDir, "node_modules"), "dir");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(imageDir, { recursive: true }),
    mkdir(duplicateImageDir, { recursive: true }),
    mkdir(pageDir, { recursive: true }),
  ]));
  await sharp({ create: { width: 840, height: 560, channels: 3, background: "#476e91" } })
    .png()
    .toFile(path.join(imageDir, "sample.png"));
  await sharp({ create: { width: 840, height: 560, channels: 3, background: "#b95342" } })
    .png()
    .toFile(path.join(duplicateImageDir, "sample.png"));
  await writeFile(path.join(imageDir, "unrequested.png"), "not an image; no Astro asset API requests this file");

  const config = `
    import astroImageCdn from ${JSON.stringify(integrationEntrypoint)};
    export default {
      integrations: [astroImageCdn({
        baseUrl: "https://cdn.example.test/photos",
        widths: [256, 640],
        formats: ["avif", "webp"],
        quality: 65
      })]
    };
  `;
  await writeFile(path.join(rootDir, "astro.config.mjs"), config);
  await writeFile(path.join(pageDir, "index.astro"), `
    ---
    import { Image, Picture, getImage } from "astro:assets";
    import sample from "../assets/sample.png";
    import duplicateSample from "../other/sample.png";
    const [generated, generatedDuplicate] = await Promise.all([
      getImage({ src: sample, width: 640, format: "webp" }),
      getImage({ src: duplicateSample, width: 640, format: "webp" }),
    ]);
    ---
    <html><body>
      <Image id="native-image" src={sample} widths={[256, 640]} format="webp" alt="Native Image" />
      <Image id="native-default" src={sample} alt="Native default format" />
      <Image id="oversized-image" src={sample} width={1200} alt="Requested wider than source" />
      <Image id="duplicate-image" src={duplicateSample} widths={[256, 640]} format="webp" alt="Second Native Image" />
      <Picture id="native-picture" src={sample} widths={[256, 640]} formats={["avif", "webp"]} alt="Native Picture" />
      <div id="get-image" data-src={generated.src}></div>
      <div id="get-image-duplicate" data-src={generatedDuplicate.src}></div>
    </body></html>
  `);

  const runBuild = () => build({ root: rootDir, logLevel: "silent" });
  await runBuild();

  const outputDir = path.join(rootDir, ".imagedist");
  const cacheDir = path.join(rootDir, ".astro-image-cdn");
  const manifestPath = path.join(cacheDir, "manifest.json");
  await assert.rejects(stat(path.join(outputDir, "manifest.json")), { code: "ENOENT" });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest.images["src/assets/sample.png"];
  const duplicateEntry = manifest.images["src/other/sample.png"];
  assert.ok(entry, "the imported source should be resolved to its project-relative path");
  assert.ok(duplicateEntry, "a duplicate basename in another directory should retain its distinct identity");
  assert.equal(manifest.images["src/assets/unrequested.png"], undefined, "unrequested files must not be inspected or processed");
  assert.deepEqual(entry.variants.map(({ width, format }) => `${width}.${format}`), [
    "256.avif", "256.webp", "256.png", "640.avif", "640.webp", "640.png", "840.avif", "840.webp", "840.png",
  ]);

  const html = await readFile(path.join(rootDir, "dist", "index.html"), "utf8");
  assert.match(html, /https:\/\/cdn\.example\.test\/photos\/[a-f0-9]{2}\/[a-f0-9]+_256\.webp/);
  assert.match(html, /https:\/\/cdn\.example\.test\/photos\/[a-f0-9]{2}\/[a-f0-9]+_256\.avif/);
  assert.match(html, /https:\/\/cdn\.example\.test\/photos\/[a-f0-9]{2}\/[a-f0-9]+_640\.webp/);
  assert.match(html, /src="https:\/\/cdn\.example\.test\/photos\/[a-f0-9]{2}\/[a-f0-9]+_840\.webp" id="native-default"/);
  const oversizedImage = html.match(/<img\b[^>]*id="oversized-image"[^>]*>/)?.[0];
  assert.ok(oversizedImage);
  assert.match(oversizedImage, /\bwidth="840"/);
  assert.match(oversizedImage, /\bheight="560"/);
  assert.match(html, /id="get-image" data-src="https:\/\/cdn\.example\.test\/photos\//);
  const firstGetImageUrl = html.match(/id="get-image" data-src="([^"]+)"/)?.[1];
  const duplicateGetImageUrl = html.match(/id="get-image-duplicate" data-src="([^"]+)"/)?.[1];
  assert.ok(firstGetImageUrl);
  assert.ok(duplicateGetImageUrl);
  assert.notEqual(firstGetImageUrl, duplicateGetImageUrl);

  const variantPaths = [...entry.variants, ...duplicateEntry.variants].map(({ file }) => path.join(outputDir, file));
  const before = await Promise.all(variantPaths.map((filePath) => stat(filePath)));
  const manifestStatBefore = await stat(manifestPath);
  const manifestTextBefore = await readFile(manifestPath, "utf8");
  const cachePath = path.join(cacheDir, "cache.json");
  const cacheStatBefore = await stat(cachePath);
  const cacheTextBefore = await readFile(cachePath, "utf8");
  await runBuild();
  const after = await Promise.all(variantPaths.map((filePath) => stat(filePath)));
  const manifestStatAfter = await stat(manifestPath);
  const manifestTextAfter = await readFile(manifestPath, "utf8");
  const cacheStatAfter = await stat(cachePath);
  const cacheTextAfter = await readFile(cachePath, "utf8");
  assert.deepEqual(after.map(({ mtimeMs }) => mtimeMs), before.map(({ mtimeMs }) => mtimeMs));
  assert.equal(manifestStatAfter.mtimeMs, manifestStatBefore.mtimeMs);
  assert.equal(manifestTextAfter, manifestTextBefore);
  assert.equal(cacheStatAfter.mtimeMs, cacheStatBefore.mtimeMs);
  assert.equal(cacheTextAfter, cacheTextBefore);

  const distFiles = await readdir(path.join(rootDir, "dist"), { recursive: true });
  assert.equal(distFiles.some((file) => /\.(?:avif|webp)$/.test(file)), false, "optimized variants must not be written into dist");
  assert.ok(await stat(path.join(cacheDir, "cache.json")));
});

test("devOnly leaves build configuration and processing untouched, then serves requested images locally in dev", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-dev-only-"));
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const imageDir = path.join(rootDir, "src", "assets");
  const pageDir = path.join(rootDir, "src", "pages");
  await symlink(path.join(packageRoot, "node_modules"), path.join(rootDir, "node_modules"), "dir");
  await mkdir(imageDir, { recursive: true });
  await mkdir(pageDir, { recursive: true });
  await sharp({ create: { width: 96, height: 64, channels: 3, background: "#527faa" } })
    .png()
    .toFile(path.join(imageDir, "requested.png"));
  await writeFile(path.join(imageDir, "unrequested.png"), "not an image");
  await writeFile(path.join(rootDir, "astro.config.mjs"), `
    import astroImageCdn from ${JSON.stringify(integrationEntrypoint)};
    export default {
      integrations: [astroImageCdn({ baseUrl: "https://cdn.example.test", devOnly: true, widths: [48], formats: ["webp"] })]
    };
  `);
  await writeFile(path.join(pageDir, "index.astro"), `
    ---
    import { Image } from "astro:assets";
    import requested from "../assets/requested.png";
    ---
    <Image src={requested} width={48} format="webp" alt="Requested image" />
  `);

  await build({ root: rootDir, logLevel: "silent" });
  await assert.rejects(stat(path.join(rootDir, ".imagedist")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(rootDir, ".astro-image-cdn")), { code: "ENOENT" });
  assert.match(await readFile(path.join(rootDir, "dist", "index.html"), "utf8"), /<img[^>]+src="\/_astro\//);

  server = await dev({
    root: rootDir,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const address = server.address;
  const pageUrl = `http://127.0.0.1:${address.port}/`;
  const pageResponse = await fetch(pageUrl);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  const localImagePath = html.match(/<img[^>]+src="([^\"]*\/_astro-image-cdn\/[a-f0-9]{2}\/[a-f0-9]+_48\.webp)"/)?.[1];
  assert.ok(localImagePath, "dev HTML should point to the local generated-asset route rather than the CDN");
  assert.equal(localImagePath.startsWith("https://cdn.example.test/"), false);

  const imageResponse = await fetch(new URL(localImagePath, pageUrl));
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/webp");
  assert.ok((await imageResponse.arrayBuffer()).byteLength > 0);
  const manifest = JSON.parse(await readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.images), ["src/assets/requested.png"]);
});

test("respects Astro image.dangerouslyProcessSVG for imported SVGs", async (t) => {
  for (const dangerouslyProcessSVG of [false, true]) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-svg-opt-in-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const imageDir = path.join(rootDir, "src", "assets");
    const pageDir = path.join(rootDir, "src", "pages");
    await symlink(path.join(packageRoot, "node_modules"), path.join(rootDir, "node_modules"), "dir");
    await mkdir(imageDir, { recursive: true });
    await mkdir(pageDir, { recursive: true });
    await writeFile(path.join(imageDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#527faa"/></svg>');
    await writeFile(path.join(rootDir, "astro.config.mjs"), `
      import astroImageCdn from ${JSON.stringify(integrationEntrypoint)};
      export default {
        image: { dangerouslyProcessSVG: ${dangerouslyProcessSVG} },
        integrations: [astroImageCdn({
          baseUrl: "https://cdn.example.test",
          widths: [16],
          formats: ["webp"]
        })]
      };
    `);
    await writeFile(path.join(pageDir, "index.astro"), `
      ---
      import { Image } from "astro:assets";
      import icon from "../assets/icon.svg";
      ---
      <Image id="svg-image" src={icon} ${dangerouslyProcessSVG ? 'format="webp"' : ""} alt="Icon" />
    `);

    await build({ root: rootDir, logLevel: "silent" });
    const manifest = JSON.parse(await readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json"), "utf8"));
    await assert.rejects(stat(path.join(rootDir, ".imagedist", "manifest.json")), { code: "ENOENT" });
    const variants = manifest.images["src/assets/icon.svg"].variants;
    const formats = variants.map(({ format }) => format);
    if (dangerouslyProcessSVG) {
      assert.ok(formats.includes("webp"));
      assert.match(await readFile(path.join(rootDir, "dist", "index.html"), "utf8"), /_32\.webp/);
    } else {
      assert.deepEqual(formats, ["svg"]);
      assert.match(await readFile(path.join(rootDir, "dist", "index.html"), "utf8"), /_32\.svg/);
    }
  }
});

test("fails configuration when persistent output or cache is inside Astro public or build output directories", async (t) => {
  const cases = [
    { options: { outputDir: "dist/.imagedist" }, error: /must be outside Astro's build output directory/ },
    { options: { cacheDir: "dist/.cache" }, error: /must be outside Astro's build output directory/ },
    { options: { outputDir: "public/.imagedist" }, error: /must be outside Astro's public directory/ },
    { options: { cacheDir: "public/.cache" }, error: /must be outside Astro's public directory/ },
    { options: { outputDir: "public-alias/.imagedist" }, publicAlias: true, error: /must be outside Astro's public directory/ },
  ];

  for (const { options, publicAlias, error } of cases) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-output-check-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    await symlink(path.join(packageRoot, "node_modules"), path.join(rootDir, "node_modules"), "dir");
    await mkdir(path.join(rootDir, "public"), { recursive: true });
    if (publicAlias) await symlink(path.join(rootDir, "public"), path.join(rootDir, "public-alias"), "dir");
    const integrationOptions = { baseUrl: "https://cdn.example.test", ...options };
    await writeFile(path.join(rootDir, "astro.config.mjs"), `
      import astroImageCdn from ${JSON.stringify(integrationEntrypoint)};
      export default { publicDir: "./public", integrations: [astroImageCdn(${JSON.stringify(integrationOptions)})] };
    `);
    await assert.rejects(build({ root: rootDir, logLevel: "silent" }), error);
  }
});
