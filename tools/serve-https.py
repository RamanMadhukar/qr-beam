#!/usr/bin/env python3
"""Serves www/ over HTTPS on your local network, so phones can use the camera.

Browsers only allow the camera on https:// pages (or localhost). On first run this
makes a self-signed certificate (kept in .cert/), so each phone shows a privacy
warning once that you accept.

Run with: npm run phone
"""
import http.server
import os
import pathlib
import socket
import ssl
import subprocess
import sys

PORT = int(os.environ.get("PORT", "8443"))
ROOT = pathlib.Path(__file__).resolve().parent.parent
WWW = ROOT / "www"
CERT_DIR = ROOT / ".cert"
CERT = CERT_DIR / "cert.pem"
KEY = CERT_DIR / "key.pem"
IPS_FILE = CERT_DIR / "ips.txt"


def lan_addresses():
    ips = set()
    try:
        # No packets are sent; this just asks which interface would be used.
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("10.255.255.255", 1))
        ips.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def ensure_certificate(ips):
    known = IPS_FILE.read_text().split() if IPS_FILE.exists() else []
    if CERT.exists() and KEY.exists() and set(ips) <= set(known):
        return
    CERT_DIR.mkdir(exist_ok=True)
    san = ", ".join(["DNS:localhost", "IP:127.0.0.1"] + ["IP:" + ip for ip in ips])
    config = CERT_DIR / "openssl.cnf"
    config.write_text(
        "[req]\n"
        "distinguished_name = dn\n"
        "x509_extensions = v3\n"
        "prompt = no\n"
        "[dn]\n"
        "CN = QR Beam local development\n"
        "[v3]\n"
        "subjectAltName = " + san + "\n"
        "basicConstraints = CA:FALSE\n"
        "keyUsage = digitalSignature, keyEncipherment\n"
        "extendedKeyUsage = serverAuth\n"
    )
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
         "-keyout", str(KEY), "-out", str(CERT), "-config", str(config)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    IPS_FILE.write_text("\n".join(ips) + "\n")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
        ".wasm": "application/wasm",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WWW), **kwargs)

    def end_headers(self):
        # Always serve the latest files while developing.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    context = None

    def get_request(self):
        sock, addr = self.socket.accept()
        # Handshake in the worker thread, so one slow phone can't stall the others.
        return self.context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), addr

    def process_request_thread(self, request, client_address):
        try:
            request.do_handshake()
        except (ssl.SSLError, OSError):
            # Usually a browser declining the self-signed certificate; it retries after you accept.
            self.shutdown_request(request)
            return
        super().process_request_thread(request, client_address)

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ssl.SSLError, ConnectionError)):
            return
        super().handle_error(request, client_address)


def main():
    ips = lan_addresses()
    ensure_certificate(ips)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(CERT), str(KEY))
    Server.context = context
    server = Server(("0.0.0.0", PORT), Handler)

    print("QR Beam is running over HTTPS.\n")
    if ips:
        print("On your phone (same Wi-Fi as this computer), open:")
        for ip in ips:
            print("  https://%s:%d/#receive" % (ip, PORT))
    print("On this computer: https://localhost:%d/\n" % PORT)
    print("The first time, the browser says the connection is not private. That is this")
    print("self-signed development certificate. To continue:")
    print("  iPhone (Safari): Show Details > visit this website > Visit Website")
    print("  Android (Chrome): Advanced > Proceed")
    print("\nStop with Ctrl+C.\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
