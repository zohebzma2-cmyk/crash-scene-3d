// Static server for design/ on http://localhost:5180 (prototype at /prototype/).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PORT = Number(process.env.PORT || 5180);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") { res.writeHead(302, { Location: "/prototype/" }); return res.end(); }
    let file = normalize(join(ROOT, path));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403); return res.end(); }
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Prototype: http://localhost:${PORT}/prototype/`));
