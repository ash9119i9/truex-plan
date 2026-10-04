"""One browser, one public page. All network traffic, including robots, uses the proxy."""
import asyncio
import contextlib
import datetime
import io
import ipaddress
import json
import os
import re
import sys
from urllib.parse import urlsplit, urlunsplit, urljoin
from urllib.robotparser import RobotFileParser

PROXY = "http://browser-egress:3128"
USER_AGENT = "Truex-WebRead/0.1"

class ReadFailure(Exception):
    pass

def valid_url(url):
    if not isinstance(url, str) or len(url) > 2048 or re.search(r"[\x00-\x20\x7f\\]", url):
        raise ReadFailure("READ_BLOCKED")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.port not in (None, 80 if parts.scheme == "http" else 443):
        raise ReadFailure("READ_BLOCKED")
    host = parts.hostname.lower().rstrip(".")
    try:
        address = ipaddress.ip_address(host)
        if not address.is_global or address.is_multicast or address.is_reserved or getattr(address, "ipv4_mapped", None) or (address.version == 6 and address not in ipaddress.ip_network("2000::/3")):
            raise ReadFailure("READ_BLOCKED")
    except ValueError:
        if "." not in host or re.search(r"(?:^|\.)(localhost|local|internal|lan|home|corp|test|invalid|onion|arpa)$", host):
            raise ReadFailure("READ_BLOCKED")
    return parts

async def robots(url, allowed_host=None):
    # Do not enable SDK check_robots_txt: it can fetch without the browser proxy.
    import aiohttp
    parts = valid_url(url)
    target = urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", ""))
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8), trust_env=False) as client:
        for redirect in range(4):
            target_parts = valid_url(target)
            if allowed_host and target_parts.hostname.lower().rstrip(".") != allowed_host:
                raise ReadFailure("READ_BLOCKED")
            async with client.get(target, proxy=PROXY, allow_redirects=False,
                                  headers={"User-Agent": USER_AGENT}) as response:
                response_parts = valid_url(str(response.url))
                if allowed_host and response_parts.hostname.lower().rstrip(".") != allowed_host: raise ReadFailure("READ_BLOCKED")
                if 300 <= response.status < 400:
                    if redirect == 3 or not response.headers.get("Location"):
                        raise ReadFailure("READ_UNAVAILABLE")
                    target = urljoin(target, response.headers["Location"])
                    continue
                if response.status in (401, 403): raise ReadFailure("READ_BLOCKED")
                if response.status in (404, 410): return
                if response.status == 429: raise ReadFailure("READ_RATE_LIMITED")
                if response.status >= 400: raise ReadFailure("READ_UNAVAILABLE")
                raw = bytearray()
                async for chunk in response.content.iter_chunked(16384):
                    raw.extend(chunk)
                    if len(raw) > 256 * 1024: raise ReadFailure("READ_UNAVAILABLE")
                parser = RobotFileParser()
                parser.parse(raw.decode("utf-8", errors="replace").splitlines())
                if not parser.can_fetch(USER_AGENT, url): raise ReadFailure("READ_BLOCKED")
                return

async def extract(value):
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
    valid_url(value["url"])
    allowed_host = value.get("allowedHost")
    if allowed_host and valid_url(value["url"]).hostname.lower().rstrip(".") != allowed_host:
        raise ReadFailure("READ_BLOCKED")
    await robots(value["url"], allowed_host)
    browser = BrowserConfig(browser_type="chromium", headless=True, verbose=False,
        use_persistent_context=False, user_agent=USER_AGENT, ignore_https_errors=False,
        proxy_config={"server": PROXY}, extra_args=[
            "--proxy-server=" + PROXY, "--proxy-bypass-list=<-loopback>", "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-background-networking",
            "--disable-extensions", "--disable-sync", "--no-first-run",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE browser-egress",
        ])
    config = CrawlerRunConfig(cache_mode=CacheMode.DISABLED, page_timeout=20000,
        wait_until="domcontentloaded", delay_before_return_html=0.5, check_robots_txt=False,
        screenshot=False, pdf=False, verbose=False, scan_full_page=False, capture_network_requests=False)
    async with AsyncWebCrawler(config=browser, base_directory=os.environ.get("CRAWL4AI_BASE_DIRECTORY", "/tmp/truex-crawl")) as crawler:
        navigation_failure = None
        checked_robots = {value["url"]}
        final_document = {}
        final_page_url = None
        async def guard_page(page, context, **kwargs):
            # Chromium's Fetch domain pauses EACH redirect. Playwright route()
            # alone only receives the first request in an HTTP redirect chain.
            session = await context.new_cdp_session(page)
            tree = await session.send("Page.getFrameTree")
            main_frame = tree["frameTree"]["frame"]["id"]
            async def guard(event):
                nonlocal navigation_failure
                top = event.get("frameId") == main_frame
                try:
                    target = event["request"]["url"]
                    target_parts = valid_url(target)
                    if top and allowed_host and target_parts.hostname.lower().rstrip(".") != allowed_host:
                        raise ReadFailure("READ_BLOCKED")
                    if "responseStatusCode" in event:
                        status = event["responseStatusCode"]
                        fields = {entry["name"].lower(): entry["value"] for entry in event.get("responseHeaders", [])}
                        if top and not 300 <= status < 400:
                            if status in (401, 403): raise ReadFailure("READ_BLOCKED")
                            if status in (404, 410): raise ReadFailure("READ_NOT_FOUND")
                            if status == 429: raise ReadFailure("READ_RATE_LIMITED")
                            if not 200 <= status < 300: raise ReadFailure("READ_UNAVAILABLE")
                            if fields.get("content-type", "").split(";", 1)[0].strip().lower() not in ("text/html", "application/xhtml+xml"):
                                raise ReadFailure("READ_UNSUPPORTED")
                            length = fields.get("content-length", "")
                            if length.isdigit() and int(length) > 4 * 1024 * 1024: raise ReadFailure("READ_UNSUPPORTED")
                    elif top and target not in checked_robots:
                        await robots(target, allowed_host)
                        checked_robots.add(target)
                except Exception as error:
                    if top: navigation_failure = str(error) if isinstance(error, ReadFailure) else "READ_UNAVAILABLE"
                    with contextlib.suppress(Exception):
                        await session.send("Fetch.failRequest", {"requestId": event["requestId"], "errorReason": "BlockedByClient"})
                    return
                with contextlib.suppress(Exception):
                    await session.send("Fetch.continueRequest", {"requestId": event["requestId"]})
            session.on("Fetch.requestPaused", guard)
            await session.send("Fetch.enable", {"patterns": [
                {"urlPattern": "*", "resourceType": "Document", "requestStage": "Request"},
                {"urlPattern": "*", "resourceType": "Document", "requestStage": "Response"},
            ]})
            def response_seen(response):
                if response.request.is_navigation_request() and response.request.frame == page.main_frame:
                    final_document.update({"url": response.url, "status": response.status, "headers": response.headers})
            page.on("response", response_seen)
            # WebSockets are not needed to extract one HTML page.
            if hasattr(context, "route_web_socket"):
                await context.route_web_socket("**/*", lambda websocket: websocket.close())
            return page
        async def before_return(page, **kwargs):
            nonlocal final_page_url
            final_page_url = page.url
            parts = valid_url(final_page_url)
            if allowed_host and parts.hostname.lower().rstrip(".") != allowed_host:
                raise ReadFailure("READ_BLOCKED")
            if final_page_url not in checked_robots:
                await robots(final_page_url, allowed_host)
                checked_robots.add(final_page_url)
            return page
        crawler.crawler_strategy.set_hook("on_page_context_created", guard_page)
        crawler.crawler_strategy.set_hook("before_return_html", before_return)
        result = await crawler.arun(url=value["url"], config=config)
        if navigation_failure:
            raise ReadFailure(navigation_failure)
        if "ERR_TUNNEL_CONNECTION_FAILED" in (result.error_message or ""):
            raise ReadFailure("READ_BLOCKED")
        final_url = final_page_url or final_document.get("url") or result.redirected_url or result.url
        parts = valid_url(final_url)
        if allowed_host and parts.hostname.lower().rstrip(".") != allowed_host:
            raise ReadFailure("READ_BLOCKED")
        if final_url not in checked_robots: await robots(final_url, allowed_host)
        status = final_document.get("status") or result.redirected_status_code or result.status_code
        if status in (401, 403): raise ReadFailure("READ_BLOCKED")
        if status in (404, 410): raise ReadFailure("READ_NOT_FOUND")
        if status == 429: raise ReadFailure("READ_RATE_LIMITED")
        if not result.success or not isinstance(status, int) or not 200 <= status < 300:
            raise ReadFailure("READ_UNAVAILABLE")
        content_type = next((v for k, v in (final_document.get("headers") or result.response_headers or {}).items() if k.lower() == "content-type"), "")
        if content_type.split(";", 1)[0].lower().strip() not in ("text/html", "application/xhtml+xml"):
            raise ReadFailure("READ_UNSUPPORTED")
        markdown = result.markdown.raw_markdown if result.markdown else ""
        markdown = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", markdown).strip()
        if not markdown: raise ReadFailure("READ_EMPTY")
        # Refuse huge DOM/text instead of claiming a false total length.
        encoded = markdown.encode("utf-16-le")
        total = len(encoded) // 2
        if total > 2 * 1024 * 1024: raise ReadFailure("READ_UNSUPPORTED")
        text = encoded[:value["maxChars"] * 2].decode("utf-16-le", errors="ignore")
        returned = len(text.encode("utf-16-le")) // 2
        title = str((result.metadata or {}).get("title") or urlsplit(final_url).hostname)
        payload = {"provider": "crawl4ai", "requestedUrl": value["url"], "url": final_url,
            "title": re.sub(r"[\x00-\x1f\x7f]", " ", title)[:300],
            "retrievedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "statusCode": status,
            "markdown": text, "totalChars": total, "truncated": total > returned,
            "warnings": ["Page text was truncated to the requested character limit."] if total > returned else []}
        if allowed_host:
            links, seen, link_bytes = [], set(), 0
            # Links come from the SAME Crawl4AI DOM extraction, never another fetch.
            for group in (result.links or {}).values():
                if not isinstance(group, list): continue
                for link in group:
                    if not isinstance(link, dict): continue
                    try:
                        parts = valid_url(urljoin(final_url, link.get("href", "")))
                        if parts.hostname.lower().rstrip(".") != allowed_host: continue
                        if re.search(r"\.(?:pdf|zip|gz|tar|rar|7z|exe|dmg|png|jpe?g|gif|webp|svg|ico|mp[34]|avi|mov|woff2?|ttf|css|js)(?:$)", parts.path, re.I): continue
                        host = parts.hostname.lower().rstrip(".")
                        if ":" in host: host = "[" + host + "]"
                        normalized = urlunsplit((parts.scheme, host, parts.path or "/", parts.query, ""))
                        if normalized not in seen:
                            if link_bytes + len(normalized.encode("utf-8")) > 128 * 1024: continue
                            link_bytes += len(normalized.encode("utf-8"))
                            seen.add(normalized)
                            links.append(normalized)
                        if len(links) >= 1000: break
                    except Exception: continue
                if len(links) >= 1000: break
            payload["links"] = links
        return payload

async def main():
    value = json.loads(sys.stdin.buffer.read(8193))
    try:
        # Crawl4AI SDK progress is discarded; no page URLs, snippets or secrets are logged.
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink):
            result = await asyncio.wait_for(extract(value), 28)
    except ReadFailure as error:
        result = {"code": str(error)}
    except (asyncio.TimeoutError, TimeoutError):
        result = {"code": "READ_TIMEOUT"}
    except Exception:
        result = {"code": "READ_UNAVAILABLE"}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))

if __name__ == "__main__":
    asyncio.run(main())
