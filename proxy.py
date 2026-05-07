"""
Proxy local para el API de la Superintendencia de Bancos (RD).

Resuelve dos cosas que impiden llamar al API directo desde el navegador:
  1. CORS: el API no envía Access-Control-Allow-Origin
  2. Sucuri WAF: bloquea peticiones que no parecen navegador

Uso:
    python3 proxy.py
    # luego abre index.html en tu navegador

Por defecto escucha en http://localhost:8787 y reenvía a:
    https://apis.sb.gob.do/estadisticas/v2/...

La API key puede venir en cualquiera de:
  - Variable de entorno SB_API_KEY
  - Header de la petición Ocp-Apim-Subscription-Key (lo manda el dashboard)
"""

import os
import sys
import mimetypes
import urllib.request
import urllib.error
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://apis.sb.gob.do/estadisticas/v2"
ENV_KEY = os.environ.get("SB_API_KEY", "")
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8787
STATIC_DIR = Path(__file__).resolve().parent
API_PREFIX = "/api"

# Headers para que Sucuri no nos vea como bot
BROWSER_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Origin": "https://desarrollador.sb.gob.do",
    "Referer": "https://desarrollador.sb.gob.do/",
}


class Handler(BaseHTTPRequestHandler):

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Ocp-Apim-Subscription-Key, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # Health check
        if self.path == "/health":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true, "upstream": "' + UPSTREAM.encode() + b'"}')
            return

        # Servir archivos estáticos: /, /index.html, /sb_api_endpoints.md, etc.
        if not self.path.startswith(API_PREFIX):
            return self._serve_static()

        # API: /api/captaciones/localidad?... → UPSTREAM + /captaciones/localidad?...
        url = UPSTREAM + self.path[len(API_PREFIX):]

        # Combinar headers
        headers = dict(BROWSER_HEADERS)
        # API Key: prioriza header de la petición; fallback a variable de entorno
        client_key = self.headers.get("Ocp-Apim-Subscription-Key", "")
        api_key = client_key or ENV_KEY
        if not api_key:
            self.send_response(401)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"falta SB_API_KEY (env o header)"}')
            return
        headers["Ocp-Apim-Subscription-Key"] = api_key

        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                status = r.status
                ct = r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            body = e.read()
            status = e.code
            ct = e.headers.get("Content-Type", "application/json")
        except Exception as e:
            self.send_response(502)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(f'{{"error":"upstream: {e}"}}'.encode())
            return

        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self):
        rel = self.path.lstrip("/").split("?", 1)[0] or "index.html"
        # Bloquear path traversal
        if ".." in rel.split("/"):
            self.send_response(403); self._cors(); self.end_headers(); return
        path = (STATIC_DIR / rel).resolve()
        if not str(path).startswith(str(STATIC_DIR)) or not path.is_file():
            self.send_response(404); self._cors(); self.end_headers()
            self.wfile.write(b"Not found"); return
        ctype, _ = mimetypes.guess_type(str(path))
        ctype = ctype or "application/octet-stream"
        body = path.read_bytes()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.command} {self.path} -> {args[1] if len(args)>1 else ''}\n")


def main():
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"\n  Dashboard:  http://{LISTEN_HOST}:{LISTEN_PORT}/")
    print(f"  API proxy:  http://{LISTEN_HOST}:{LISTEN_PORT}{API_PREFIX}/...  →  {UPSTREAM}")
    print(f"  API key:    {'(env SB_API_KEY)' if ENV_KEY else '(se espera del navegador)'}")
    print(f"  Static:     {STATIC_DIR}")
    print("\n  Ctrl+C para detener.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDetenido.")


if __name__ == "__main__":
    main()
