import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export const DEV_ASSET_PREFIX = "/_astro-image-cdn/";

const CONTENT_TYPES = {
  avif: "image/avif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml; charset=utf-8",
  webp: "image/webp",
};

function notFound(response) {
  response.statusCode = 404;
  response.end("Not found");
}

function createAssetMiddleware(outputDir) {
  return async (request, response, next) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://astro-image-cdn.local").pathname;
    } catch {
      return next();
    }
    if (!pathname.startsWith(DEV_ASSET_PREFIX)) return next();

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      response.statusCode = 405;
      response.end("Method not allowed");
      return;
    }

    let relativePath;
    try {
      relativePath = decodeURIComponent(pathname.slice(DEV_ASSET_PREFIX.length));
    } catch {
      return notFound(response);
    }
    const segments = relativePath.split("/");
    if (!relativePath || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
      return notFound(response);
    }

    let filePath = outputDir;
    try {
      for (const [index, segment] of segments.entries()) {
        filePath = path.join(filePath, segment);
        const fileInfo = await lstat(filePath);
        const isFile = index === segments.length - 1;
        if (fileInfo.isSymbolicLink() || (isFile ? !fileInfo.isFile() : !fileInfo.isDirectory())) {
          return notFound(response);
        }
      }
      const data = await readFile(filePath);
      const extension = path.extname(filePath).slice(1).toLowerCase();
      response.statusCode = 200;
      response.setHeader("Content-Type", CONTENT_TYPES[extension] ?? "application/octet-stream");
      response.setHeader("Content-Length", data.byteLength);
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.end(request.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return notFound(response);
      return next(error);
    }
  };
}

export function installDevAssetMiddleware(server, outputDir) {
  server.middlewares.use(createAssetMiddleware(path.resolve(outputDir)));
}
