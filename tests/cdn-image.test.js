import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import sharp from "sharp";
import { build, dev } from "astro";
import astroImageCdn from "../src/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integrationEntrypoint = pathToFileURL(path.join(packageRoot, "src", "index.js")).href;
const componentEntrypoint = pathToFileURL(path.join(packageRoot, "src", "CdnImage.astro")).href;

async function createProject(t, { width = 840, height = 560 } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-cdn-image-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const imageDir = path.join(rootDir, "src", "assets");
  const pageDir = path.join(rootDir, "src", "pages");
  await symlink(path.join(packageRoot, "node_modules"), path.join(rootDir, "node_modules"), "dir");
  await mkdir(imageDir, { recursive: true });
  await mkdir(pageDir, { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: "#476e91" } })
    .png()
    .toFile(path.join(imageDir, "sample.png"));
  return { rootDir, imageDir, pageDir };
}

async function writeConfig(rootDir, options) {
  await writeFile(path.join(rootDir, "astro.config.mjs"), `
    import astroImageCdn from ${JSON.stringify(integrationEntrypoint)};
    export default {
      integrations: [astroImageCdn(${JSON.stringify(options)})]
    };
  `);
}

async function writePage(rootDir) {
  await writeFile(path.join(rootDir, "src", "pages", "index.astro"), `
    ---
    import CdnImage from ${JSON.stringify(componentEntrypoint)};
    import sample from "../assets/sample.png";
    ---
    <CdnImage src={sample} alt="A landscape" sizes="(max-width: 600px) 100vw, 50vw" />
  `);
}

function readPicture(html) {
  const picture = html.match(/<picture\b[^>]*>([\s\S]*?)<\/picture>/)?.[0];
  assert.ok(picture, "expected a <picture> element in the rendered HTML");
  const tags = [...picture.matchAll(/<(source|img)\b[^>]*>/g)].map((match) => match[0]);
  return { picture, tags, sources: tags.filter((tag) => tag.startsWith("<source")), img: tags.find((tag) => tag.startsWith("<img")) };
}

function attr(tag, name) {
  return tag?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function srcsetUrls(srcset) {
  return srcset.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]);
}

test("CdnImage renders config-ordered picture markup in a real build", async (t) => {
  const { rootDir } = await createProject(t);
  await writeConfig(rootDir, {
    baseUrl: "https://cdn.example.test/photos",
    widths: [256, 640],
    formats: ["avif", "webp"],
    quality: 65,
    includeSourceFormat: false,
  });
  await writePage(rootDir);
  await build({ root: rootDir, logLevel: "silent" });

  const html = await readFile(path.join(rootDir, "dist", "index.html"), "utf8");
  const { picture, tags, sources, img } = readPicture(html);
  assert.deepEqual(tags.map((tag) => tag.match(/^<(\w+)/)[1]), ["source", "source", "img"]);
  assert.equal(attr(sources[0], "type"), "image/avif");
  assert.equal(attr(sources[1], "type"), "image/webp");
  assert.match(attr(img, "src"), /_840\.webp$/);

  for (const srcset of [attr(sources[0], "srcset"), attr(sources[1], "srcset"), attr(img, "srcset")]) {
    assert.ok(srcset, "expected a srcset on every picture child");
    assert.match(srcset, /_256\./);
    assert.match(srcset, /_640\./);
    assert.deepEqual(srcset.match(/\b\d+w\b/g), ["256w", "640w"]);
  }

  assert.equal(attr(img, "alt"), "A landscape");
  assert.equal(attr(img, "width"), "840");
  assert.equal(attr(img, "height"), "560");
  assert.equal(attr(img, "sizes"), "(max-width: 600px) 100vw, 50vw");
  for (const source of sources) {
    assert.equal(attr(source, "sizes"), "(max-width: 600px) 100vw, 50vw");
  }

  const allUrls = [attr(img, "src"), ...srcsetUrls(attr(sources[0], "srcset")), ...srcsetUrls(attr(sources[1], "srcset")), ...srcsetUrls(attr(img, "srcset"))];
  for (const url of allUrls) {
    assert.ok(url.startsWith("https://cdn.example.test/photos/"), url);
  }
  assert.equal(/\bstyle=/.test(picture), false, "no inline styles should be emitted");
  assert.equal(/astro-/.test(picture), false, "no scoped Astro classes should be emitted");

  const manifest = JSON.parse(await readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json"), "utf8"));
  const entry = manifest.images["src/assets/sample.png"];
  assert.ok(entry, "the imported source should be recorded in the private manifest");
  assert.deepEqual(entry.variants.map((variant) => `${variant.width}.${variant.format}`).sort(), [
    "256.avif", "256.webp", "640.avif", "640.webp", "840.avif", "840.webp",
  ]);
});

test("CdnImage follows changed integration config without prop changes", async (t) => {
  const { rootDir } = await createProject(t);
  await writeConfig(rootDir, {
    baseUrl: "https://cdn.example.test/photos",
    widths: [128, 512],
    formats: ["webp", "jpeg"],
    includeSourceFormat: false,
  });
  await writePage(rootDir);
  await build({ root: rootDir, logLevel: "silent" });

  const html = await readFile(path.join(rootDir, "dist", "index.html"), "utf8");
  const { tags, sources, img } = readPicture(html);
  assert.deepEqual(tags.map((tag) => tag.match(/^<(\w+)/)[1]), ["source", "source", "img"]);
  assert.equal(attr(sources[0], "type"), "image/webp");
  assert.equal(attr(sources[1], "type"), "image/jpeg");
  assert.match(attr(img, "src"), /_840\.jpeg$/);
  assert.equal(html.includes("image/avif"), false);
  for (const srcset of [attr(sources[0], "srcset"), attr(sources[1], "srcset"), attr(img, "srcset")]) {
    assert.deepEqual(srcset.match(/\b\d+w\b/g), ["128w", "512w"]);
  }
});

test("CdnImage emits a single native-width candidate for a narrow source", async (t) => {
  const { rootDir } = await createProject(t, { width: 100, height: 50 });
  await writeConfig(rootDir, {
    baseUrl: "https://cdn.example.test/photos",
    widths: [256, 640],
    formats: ["avif", "webp"],
  });
  await writePage(rootDir);
  await build({ root: rootDir, logLevel: "silent" });

  const html = await readFile(path.join(rootDir, "dist", "index.html"), "utf8");
  const { sources, img } = readPicture(html);
  for (const srcset of [attr(sources[0], "srcset"), attr(sources[1], "srcset"), attr(img, "srcset")]) {
    assert.deepEqual(srcset.match(/\b\d+w\b/g), ["100w"]);
  }
  assert.equal(attr(img, "width"), "100");
  assert.equal(attr(img, "height"), "50");
});

test("CdnImage uses local dev URLs and writes a private manifest in astro dev", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "astro-image-cdn-cdn-image-dev-"));
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
    .toFile(path.join(imageDir, "sample.png"));
  await writeConfig(rootDir, { baseUrl: "https://cdn.example.test", widths: [48], formats: ["avif", "webp"] });
  await writePage(rootDir);

  server = await dev({
    root: rootDir,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const pageUrl = `http://127.0.0.1:${server.address.port}/`;
  const pageResponse = await fetch(pageUrl);
  assert.equal(pageResponse.status, 200);
  const { tags, sources, img } = readPicture(await pageResponse.text());
  assert.deepEqual(tags.map((tag) => tag.match(/^<(\w+)/)[1]), ["source", "source", "img"]);
  assert.equal(attr(sources[0], "type"), "image/avif");
  assert.equal(attr(sources[1], "type"), "image/webp");
  assert.equal(attr(img, "alt"), "A landscape");
  assert.equal(attr(img, "width"), "96");
  assert.equal(attr(img, "height"), "64");
  assert.equal(attr(img, "sizes"), "(max-width: 600px) 100vw, 50vw");
  assert.deepEqual(attr(img, "srcset").match(/\b\d+w\b/g), ["48w"]);
  const allUrls = [attr(img, "src"), ...tags.flatMap((tag) => {
    const srcset = attr(tag, "srcset");
    return srcset ? srcsetUrls(srcset) : [];
  })];
  assert.ok(allUrls.length > 0, "expected at least one image URL in dev HTML");
  for (const url of allUrls) {
    assert.ok(url.startsWith("/_astro-image-cdn/"), url);
    assert.equal(url.startsWith("https://cdn.example.test/"), false);
  }

  const imageResponse = await fetch(new URL(allUrls[0], pageUrl));
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get("content-type"), /^image\//);
  assert.ok((await imageResponse.arrayBuffer()).byteLength > 0);
  const manifest = JSON.parse(await readFile(path.join(rootDir, ".astro-image-cdn", "manifest.json"), "utf8"));
  assert.ok(manifest.images["src/assets/sample.png"]);
});

test("CdnImage export surface exposes only the documented props", async () => {
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./CdnImage"], {
    types: "./src/cdn-image.d.ts",
    import: "./src/CdnImage.astro",
  });
  assert.equal(pkg.version, "0.5.0");

  const source = await readFile(path.join(packageRoot, "src", "CdnImage.astro"), "utf8");
  const props = source.match(/export interface Props \{([\s\S]*?)\}/)?.[1];
  assert.ok(props, "expected an exported Props interface");
  assert.deepEqual([...props.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]), ["src", "alt", "sizes"]);
});
