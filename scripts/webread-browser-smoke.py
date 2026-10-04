"""Run inside the deployed reader: python < scripts/webread-browser-smoke.py.

Controlled HTML is supplied at a public navigation URL; the real worker/browser
configuration handles its JavaScript, redirects and private subresources.
"""
import asyncio
import contextlib
import io
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ["HOME"] = "/tmp"
os.environ["CRAWL4AI_BASE_DIRECTORY"] = "/tmp"
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = "/home/appuser/.cache/ms-playwright"

import crawl4ai
import read_worker

hits = []
checks = []
fixture_url = "https://example.com/"
mode = "page"


class Sentinel(BaseHTTPRequestHandler):
    def do_GET(self):
        hits.append(self.path)
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b"PRIVATE_SENTINEL_MUST_NOT_BE_READ")

    def log_message(self, *_):
        pass


original_arun = crawl4ai.AsyncWebCrawler.arun
original_robots = read_worker.robots


async def controlled_robots(url):
    if url == fixture_url:
        return
    return await original_robots(url)


async def controlled_arun(crawler, *args, **kwargs):
    production_hook = crawler.crawler_strategy.hooks["on_page_context_created"]

    async def fixture_hook(page, context, **hook_kwargs):
        await production_hook(page, context, **hook_kwargs)

        async def navigation(route):
            if mode == "redirect":
                await route.fulfill(status=302, headers={"location": "http://127.0.0.1/"})
            else:
                await route.fulfill(status=200, content_type="text/html; charset=utf-8", body="""
                  <html><head><meta charset="utf-8"><title>Controlled browser check</title></head><body>
                  <h1>Rendered worker fixture 😀</h1><p>Unicode content 😀 and public page text.</p>
                  <img src="http://127.0.0.1/private-image">
                  <script>
                    window.done = false;
                    Promise.all(['http://127.0.0.1/private-fetch',
                      'http://169.254.169.254/latest/meta-data/',
                      'http://web-service:4400/health'].map(url =>
                      fetch(url).then(() => 'reachable').catch(() => 'blocked')))
                      .then(values => { window.checks = values; window.done = true; });
                  </script></body></html>
                """)

        await context.route(fixture_url, navigation)
        return page

    async def before_html(page, **_):
        if mode == "page":
            await page.wait_for_function("window.done === true", timeout=8000)
            checks.extend(await page.evaluate("window.checks"))
        return page

    crawler.crawler_strategy.set_hook("on_page_context_created", fixture_hook)
    crawler.crawler_strategy.set_hook("before_retrieve_html", before_html)
    return await original_arun(crawler, *args, **kwargs)


async def main():
    global mode
    sentinel = HTTPServer(("127.0.0.1", 80), Sentinel)
    thread = threading.Thread(target=sentinel.serve_forever, daemon=True)
    thread.start()
    crawl4ai.AsyncWebCrawler.arun = controlled_arun
    read_worker.robots = controlled_robots
    try:
        # Browser worker network has no direct route to the public internet.
        try:
            connection = socket.create_connection(("1.1.1.1", 443), timeout=2)
        except OSError:
            pass
        else:
            connection.close()
            raise AssertionError("Browser container has direct public egress")
        with contextlib.redirect_stdout(io.StringIO()):
            result = await asyncio.wait_for(read_worker.extract({"url": fixture_url, "maxChars": 20000}), 25)
        assert "Rendered worker fixture" in result["markdown"]
        assert "😀" in result["markdown"], repr(result["markdown"])
        assert result["totalChars"] == len(result["markdown"].encode("utf-16-le")) // 2
        assert checks == ["blocked", "blocked", "blocked"], checks
        assert not hits, hits
        mode = "redirect"
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                await asyncio.wait_for(read_worker.extract({"url": fixture_url, "maxChars": 20000}), 25)
            except read_worker.ReadFailure:
                pass
            else:
                raise AssertionError("Private redirect was accepted")
        assert not hits, hits
        print(json.dumps({"private_subresources": "blocked", "private_redirect": "blocked",
                          "loopback_sentinel_hits": len(hits), "direct_egress": "blocked",
                          "javascript_rendering": "passed", "unicode_accounting": "passed"}))
    finally:
        sentinel.shutdown()
        sentinel.server_close()
        crawl4ai.AsyncWebCrawler.arun = original_arun
        read_worker.robots = original_robots


asyncio.run(main())
