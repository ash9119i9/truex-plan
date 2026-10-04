"""Offline worker regressions; run in the pinned image with --network none."""
import asyncio
import json
import os
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path
import read_worker as worker

class Response:
    status = 200
    url = "https://example.com/robots.txt"
    headers = {}
    def __init__(self, chunks):
        self.chunks = chunks
        self.content = self
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def iter_chunked(self, size):
        for chunk in self.chunks:
            await asyncio.sleep(0)
            yield chunk

def session(response, seen):
    class Session:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def get(self, url, **kwargs):
            seen.append((url, kwargs))
            return response
    return Session

class RobotsTests(unittest.IsolatedAsyncioTestCase):
    async def test_late_disallow_rules_are_read_before_decision(self):
        seen = []
        response = Response([b"User-agent: *\n", b"Disallow: /restricted\n"])
        with patch("aiohttp.ClientSession", session(response, seen)):
            with self.assertRaisesRegex(worker.ReadFailure, "READ_BLOCKED"):
                await worker.robots("https://example.com/restricted")
        self.assertEqual(seen[0][1]["proxy"], worker.PROXY)
        self.assertFalse(seen[0][1]["allow_redirects"])

    async def test_oversized_robots_fail_closed(self):
        response = Response([b"#" * 16384] * 17)
        with patch("aiohttp.ClientSession", session(response, [])):
            with self.assertRaisesRegex(worker.ReadFailure, "READ_UNAVAILABLE"):
                await worker.robots("https://example.com/")

    async def test_private_robots_redirect_is_blocked(self):
        response = Response([b"User-agent: *\nAllow: /\n"])
        response.url = "http://127.0.0.1/robots.txt"
        with patch("aiohttp.ClientSession", session(response, [])):
            with self.assertRaisesRegex(worker.ReadFailure, "READ_BLOCKED"):
                await worker.robots("https://example.com/")

    async def test_utf16_bounds_and_fixed_browser_config(self):
        configs = []
        class Config:
            def __init__(self, **kwargs):
                configs.append(kwargs)
        class Crawler:
            def __init__(self, **kwargs):
                self.crawler_strategy = types.SimpleNamespace(set_hook=lambda *args: None)
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def arun(self, **kwargs):
                return types.SimpleNamespace(redirected_url="https://example.com/", url="https://example.com/",
                    redirected_status_code=200, status_code=200, success=True, error_message=None,
                    response_headers={"content-type": "text/html"}, markdown=types.SimpleNamespace(raw_markdown="😀😀abc"), metadata={"title": "Page"})
        sdk = types.SimpleNamespace(AsyncWebCrawler=Crawler, BrowserConfig=Config, CrawlerRunConfig=Config,
                                    CacheMode=types.SimpleNamespace(DISABLED="disabled"))
        async def allow(*args): pass
        with patch.dict(sys.modules, {"crawl4ai": sdk}), patch.object(worker, "robots", allow):
            value = await worker.extract({"url": "https://example.com/", "maxChars": 3})
        self.assertEqual(value["markdown"], "😀")
        self.assertEqual(value["totalChars"], 7)
        self.assertTrue(value["truncated"])
        browser = configs[0]
        self.assertEqual(browser["proxy_config"], {"server": worker.PROXY})
        self.assertIn("--proxy-bypass-list=<-loopback>", browser["extra_args"])
        self.assertFalse(browser["ignore_https_errors"])
        self.assertFalse(configs[1]["check_robots_txt"])

class URLTests(unittest.TestCase):
    def test_private_targets_and_credentialed_urls_rejected(self):
        for url in ("http://127.0.0.1/", "http://[::1]/", "http://[::ffff:8.8.8.8]/", "https://user:secret@example.com/", "file:///etc/passwd", "http://crawl4ai:11235/", "http://metadata.internal/", "http://example.com:443/"):
            with self.assertRaises(worker.ReadFailure, msg=url): worker.valid_url(url)

class CleanupTests(unittest.IsolatedAsyncioTestCase):
    async def run_api(self, program, cancel=False):
        with patch.dict(os.environ, {"CRAWL4AI_API_TOKEN": "test-token-" + "x" * 40}):
            import worker_api as api
        class Request:
            url = types.SimpleNamespace(path="/read")
            async def stream(self):
                yield json.dumps({"url": "https://example.com/", "maxChars": 100}).encode()
            async def is_disconnected(self): return False
        original_spawn = asyncio.create_subprocess_exec
        original_stop = api.stop_process
        started, stopping, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        processes, directories = [], []
        async def spawn(*args, **kwargs):
            directories.append(kwargs["env"]["HOME"])
            process = await original_spawn(sys.executable, "-c", program, **kwargs)
            processes.append(process)
            started.set()
            return process
        async def stop(process):
            stopping.set()
            if cancel: await release.wait()
            await original_stop(process)
        with patch.object(asyncio, "create_subprocess_exec", spawn), patch.object(api, "stop_process", stop):
            pending = asyncio.create_task(api.read(Request()))
            await asyncio.wait_for(started.wait(), 2)
            if cancel:
                pending.cancel()
                await asyncio.wait_for(stopping.wait(), 2)
                # First cancellation starts finally; a second arrives DURING kill.
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError): await pending
                self.assertTrue(api.cleanups)
                release.set()
                await asyncio.wait_for(asyncio.gather(*api.cleanups), 3)
            else:
                response = await asyncio.wait_for(pending, 3)
                self.assertEqual(response.status_code, 200)
        self.assertEqual(api.active, 0)
        self.assertFalse(Path(directories[0]).exists())
        self.assertIsNotNone(processes[0].returncode)

    async def test_success_removes_all_scratch(self):
        await self.run_api("import os,sys,json,pathlib; sys.stdin.read(); pathlib.Path(os.environ['HOME'],'artifact').write_text('page'); print(json.dumps({'provider':'crawl4ai'}))")

    async def test_request_cancellation_during_kill_still_removes_scratch(self):
        await self.run_api("import sys,time; sys.stdin.read(); time.sleep(60)", cancel=True)


class CrawlTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_dom_links_are_bounded_normalized_and_crawl_never_fetches_twice(self):
        calls = []
        class Config:
            def __init__(self, **kwargs): pass
        class Crawler:
            def __init__(self, **kwargs): self.crawler_strategy = types.SimpleNamespace(set_hook=lambda *args: None)
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def arun(self, **kwargs):
                calls.append(kwargs["url"])
                return types.SimpleNamespace(redirected_url="https://example.com/", url="https://example.com/",
                    redirected_status_code=200, status_code=200, success=True, error_message=None,
                    response_headers={"content-type": "text/html"}, markdown=types.SimpleNamespace(raw_markdown="Page"), metadata={"title": "Page"},
                    links={"internal": [{"href": href} for href in ["/one#part", "/one#duplicate", "https://example.com:443/two", "/image.png", "javascript:alert(1)", "https://user:pass@example.com/", "http://127.0.0.1/"]], "external": [{"href": "https://other.com/"}]})
        sdk=types.SimpleNamespace(AsyncWebCrawler=Crawler,BrowserConfig=Config,CrawlerRunConfig=Config,CacheMode=types.SimpleNamespace(DISABLED="disabled"))
        async def allow(*args): pass
        with patch.dict(sys.modules,{"crawl4ai":sdk}), patch.object(worker,"robots",allow):
            result=await worker.extract({"url":"https://example.com/","maxChars":100,"allowedHost":"example.com"})
        self.assertEqual(calls,["https://example.com/"])
        self.assertEqual(result["links"],["https://example.com/one","https://example.com/two"])

    async def test_cross_host_top_document_is_failed_in_cdp_before_continue(self):
        commands, hooks = [], {}
        class Config:
            def __init__(self, **kwargs): pass
        class Session:
            async def send(self, name, value=None):
                commands.append((name,value))
                if name=="Page.getFrameTree": return {"frameTree":{"frame":{"id":"main"}}}
            def on(self,name,handler): self.handler=handler
        session=Session()
        class Context:
            async def new_cdp_session(self,page): return session
        class Page:
            def on(self,*args): pass
        class Crawler:
            def __init__(self,**kwargs): self.crawler_strategy=types.SimpleNamespace(set_hook=lambda name,callback:hooks.update({name:callback}))
            async def __aenter__(self): return self
            async def __aexit__(self,*args): pass
            async def arun(self,**kwargs):
                await hooks["on_page_context_created"](Page(),Context())
                await session.handler({"frameId":"main","requestId":"redirect","request":{"url":"https://other.com/page"}})
                return types.SimpleNamespace(error_message=None)
        sdk=types.SimpleNamespace(AsyncWebCrawler=Crawler,BrowserConfig=Config,CrawlerRunConfig=Config,CacheMode=types.SimpleNamespace(DISABLED="disabled"))
        async def allow(*args): pass
        with patch.dict(sys.modules,{"crawl4ai":sdk}),patch.object(worker,"robots",allow):
            with self.assertRaisesRegex(worker.ReadFailure,"READ_BLOCKED"):
                await worker.extract({"url":"https://example.com/","maxChars":100,"allowedHost":"example.com"})
        self.assertIn(("Fetch.failRequest",{"requestId":"redirect","errorReason":"BlockedByClient"}),commands)
        self.assertFalse(any(name=="Fetch.continueRequest" for name,value in commands))

    async def test_robots_cross_host_redirect_is_rejected_before_second_fetch(self):
        response=Response([])
        response.status=302
        response.headers={"Location":"https://other.com/robots.txt"}
        seen=[]
        with patch("aiohttp.ClientSession",session(response,seen)):
            with self.assertRaisesRegex(worker.ReadFailure,"READ_BLOCKED"):
                await worker.robots("https://example.com/","example.com")
        self.assertEqual(len(seen),1)

    async def test_private_endpoint_rejects_browser_options_and_host_overrides(self):
        with patch.dict(os.environ,{"CRAWL4AI_API_TOKEN":"test-token-"+"x"*40}): import worker_api as api
        class Request:
            url=types.SimpleNamespace(path="/crawl-page")
            def __init__(self,value): self.value=value
            async def stream(self): yield json.dumps(self.value).encode()
        for value in ({"url":"https://example.com/","maxChars":10,"allowedHost":"other.com"},
                      {"url":"https://example.com/","maxChars":10,"allowedHost":"example.com","browserConfig":{}},
                      {"url":"https://example.com/","maxChars":10,"allowedHost":"example.com","js_code":"x"}):
            response=await api.read(Request(value))
            self.assertEqual(response.status_code,400)

if __name__ == "__main__": unittest.main()
