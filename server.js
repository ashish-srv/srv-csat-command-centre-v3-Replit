const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { loadEnvFile } = require("./src/lib/env");
const { handleApiRequest } = require("./src/server/api-handler");

loadEnvFile(path.join(__dirname, ".env"));

const host = "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const distRoot = path.resolve(__dirname, "dist");
const maxBodyBytes = 1_000_000;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBodyBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function writeApiResponse(res, result) {
  res.writeHead(result.statusCode || 200, result.headers || {});
  res.end(result.body || "");
}

function requestBaseUrl(req) {
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL.replace(/\/$/, "");
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const requestHost = forwardedHost || req.headers.host;
  const protocol = forwardedProto || "https";
  return `${protocol}://${requestHost}`.replace(/\/$/, "");
}

function safeStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const requested = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.resolve(distRoot, `.${requested}`);
  return candidate === distRoot || candidate.startsWith(`${distRoot}${path.sep}`)
    ? candidate
    : null;
}

function sendFile(req, res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const headers = {
    "content-type": contentTypes[extension] || "application/octet-stream",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "cache-control": filePath.includes(`${path.sep}assets${path.sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache"
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}

async function serveFrontend(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }

  const candidate = safeStaticPath(pathname);
  if (candidate) {
    try {
      const details = await fs.promises.stat(candidate);
      if (details.isFile()) {
        sendFile(req, res, candidate);
        return;
      }
    } catch {
      // React routes fall through to index.html.
    }
  }

  const indexPath = path.join(distRoot, "index.html");
  try {
    await fs.promises.access(indexPath, fs.constants.R_OK);
    sendFile(req, res, indexPath);
  } catch {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Application build not found. Run npm run build before npm start.");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
        ? await readBody(req)
        : {};
      const result = await handleApiRequest({
        method: req.method,
        path: url.pathname,
        searchParams: url.searchParams,
        headers: req.headers,
        body,
        baseUrl: requestBaseUrl(req)
      });
      writeApiResponse(res, result);
      return;
    }

    await serveFrontend(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    writeApiResponse(res, {
      statusCode: error.message === "Invalid JSON body" ? 400 : 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        error: error.message === "Invalid JSON body" ? error.message : "Server error"
      })
    });
  }
});

server.listen(port, host, () => {
  console.log(`SRV CSAT Replit server listening on http://${host}:${port}`);
});

