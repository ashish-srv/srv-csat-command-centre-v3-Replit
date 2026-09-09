const http = require("http");
const path = require("path");
const { loadEnvFile } = require("./src/lib/env");
const { handleApiRequest } = require("./src/server/api-handler");

loadEnvFile(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 8787);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function writeResponse(res, result) {
  res.writeHead(result.statusCode || 200, result.headers || {});
  res.end(result.body || "");
}

async function start() {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    appType: "spa",
    server: {
      middlewareMode: true,
      watch: {
        ignored: ["**/.env", "**/.env.*", "**/storage/**", "**/node_modules/**"]
      }
    }
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/")) {
        const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
          ? await readBody(req)
          : {};
        const result = await handleApiRequest({
          method: req.method,
          path: url.pathname,
          searchParams: url.searchParams,
          headers: req.headers,
          body,
          baseUrl: (process.env.PUBLIC_APP_URL || `http://${req.headers.host}`).replace(/\/$/, "")
        });
        writeResponse(res, result);
        return;
      }

      vite.middlewares(req, res, (error) => {
        if (error) {
          vite.ssrFixStacktrace(error);
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(error.stack);
        } else {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
      });
    } catch (error) {
      console.error(error);
      writeResponse(res, {
        statusCode: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Server error", details: error.message })
      });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`CSAT React app running at http://127.0.0.1:${port}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
