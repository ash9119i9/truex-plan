import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_APP_CHANNEL,
  mcpAppCsp,
  mcpAppDocument,
} from "../lib/mcp-app-document.ts";

const srcdoc = (doc: string) => {
  const match = /srcdoc="([^"]*)"/.exec(doc);
  assert.ok(match, "has a srcdoc");
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
};

test("the policy is in the page Truex serves, ahead of everything the app sent", () => {
  const doc = mcpAppDocument("<!doctype html><html><body>hi</body></html>");
  const policy = doc.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(policy > 0);
  assert.ok(policy < doc.indexOf("<iframe"));
  assert.ok(doc.includes(`content="${mcpAppCsp}"`));
  for (const rule of [
    "default-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ])
    assert.ok(mcpAppCsp.includes(rule), rule);
  // No remote origin is allowed for anything.
  assert.equal(/https?:|\*/.test(mcpAppCsp), false);
});

test("the app runs in a frame that can only run scripts", () => {
  const doc = mcpAppDocument("<p>x</p>");
  const tag = /<iframe[^>]*>/.exec(doc)![0];
  assert.match(tag, /sandbox="allow-scripts"/);
  for (const power of [
    "allow-same-origin",
    "allow-popups",
    "allow-top-navigation",
    "allow-forms",
    "allow-modals",
    "allow-downloads",
  ])
    assert.equal(doc.includes(power), false, power);
  assert.match(tag, /referrerpolicy="no-referrer"/);
});

test("the app's page is carried intact and cannot break out of its frame", () => {
  const page = `<!-- <head> --><!doctype html><html><head><script>1</script></head><body><b a='x' b="y">&amp; <</b></body></html>`;
  assert.equal(srcdoc(mcpAppDocument(page)), page);
  const attack = `"><script>alert(1)</script><iframe srcdoc="`;
  const doc = mcpAppDocument(attack);
  assert.equal(srcdoc(doc), attack);
  // The attack text appears nowhere as markup, only escaped inside the attribute.
  assert.equal(doc.includes("<script>alert(1)"), false);
  assert.equal(doc.split("<script>").length, 2, "only the relay is a script");
  assert.equal(doc.split("<iframe").length, 2, "only the one frame");
});

test("the relay forwards only between its own app frame and Truex", () => {
  const doc = mcpAppDocument("<p>x</p>");
  const relay = doc.slice(doc.lastIndexOf("<script>"));
  assert.ok(relay.includes("event.source === inner.contentWindow"));
  assert.ok(relay.includes("event.source === parent"));
  assert.ok(relay.includes(`"${MCP_APP_CHANNEL}"`));
  assert.ok(relay.includes('dir: "up"'));
  assert.ok(relay.includes('data.dir === "down"'));
});
