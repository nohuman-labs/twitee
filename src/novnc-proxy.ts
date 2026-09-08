import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { extname, resolve, sep } from "node:path";
import type { LoginService } from "./login-runner.js";

const cookieName = "twitee_login_cap";

export function createNoVncProxy(options: {
  readonly loginService: Pick<LoginService, "authorizeCapability">;
  readonly assetRoot: string;
  readonly targetPort: number;
}): Server {
  const root = resolve(options.assetRoot);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const capability = readCapability(request, url);
    if (!capability || !options.loginService.authorizeCapability(capability)) {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return response.end("Login session is missing or expired.");
    }
    if (url.pathname === "/") {
      response.writeHead(302, {
        location: `/vnc.html?capability=${encodeURIComponent(capability)}`,
        "cache-control": "no-store",
      });
      return response.end();
    }

    let path: string;
    try {
      path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    } catch {
      response.writeHead(404).end();
      return;
    }
    if (!path.startsWith(root + sep)) {
      response.writeHead(404).end();
      return;
    }
    try {
      if (!(await stat(path)).isFile()) throw new Error("not a file");
      const headers: Record<string, string> = {
        "content-type": contentType(path),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      if (url.searchParams.has("capability")) {
        headers["set-cookie"] = `${cookieName}=${encodeURIComponent(capability)}; Path=/; HttpOnly; SameSite=Strict; Secure`;
      }
      response.writeHead(200, headers);
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const capability = readCapability(request, url);
    if (
      url.pathname !== "/websockify" ||
      !capability ||
      !options.loginService.authorizeCapability(capability)
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }

    const target = connect(options.targetPort, "127.0.0.1", () => {
      const headers = request.rawHeaders
        .reduce<string[]>((lines, value, index, values) => {
          if (index % 2 === 0 && value.toLowerCase() !== "cookie") {
            lines.push(`${value}: ${values[index + 1] ?? ""}`);
          }
          return lines;
        }, [])
        .join("\r\n");
      target.write(`${request.method} ${url.pathname} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head.length > 0) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
  });

  return server;
}

function readCapability(request: IncomingMessage, url: URL): string | null {
  const query = url.searchParams.get("capability");
  if (query) return query;
  for (const item of (request.headers.cookie ?? "").split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === cookieName) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}
