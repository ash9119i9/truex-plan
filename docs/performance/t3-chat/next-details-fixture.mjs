// Isolated actual-component browser fixture; no Truex/API/provider requests.
// node docs/performance/t3-chat/next-details-fixture.mjs [--port 4494]
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const require = createRequire(resolve(root, "platform/package.json"));
const { build } = require("esbuild");
const beforeRef = "d6e3f45a45e6948873b8a64d0a9453fb2c2f4307";
const owned = [
  "thinking-block.tsx",
  "chat-messages.tsx",
  "session-activity.tsx",
  "streaming-markdown.tsx",
];
const entry = `
import React, { useState } from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChatMessages} from './components/chat-messages';
import {SessionActivity} from './components/session-activity';
const answer='Exact answer λ\\n\\n\u0060\u0060\u0060txt\\n  first λ  \\nlast & <tag>\\n\\n\u0060\u0060\u0060\\n\\n| A | B |\\n|---|---|\\n| narrow | '+ 'wide'.repeat(80)+' |';
const prompt='Long prompt λ\\n'.repeat(90);
window.fixtureMetrics={eventProjections:0};
function events(status,version){
 const result=Array.from({length:12},(_,i)=>({type:'activity.updated',seq:i,cursor:String(i),at:'2026-10-05T00:00:00Z',threadId:'fixture',data:{label:'Activity '+i+' version '+version}}));
 result.push({type:'turn.completed',seq:20,cursor:'20',at:'2026-10-05T00:00:01Z',threadId:'fixture',turnId:'turn-fixture',data:{turn:{status}}});
 return new Proxy(result,{get(target,key,receiver){if(key==='map'||key==='forEach')window.fixtureMetrics.eventProjections++;return Reflect.get(target,key,receiver)}});
}
function App(){
 const [state,setState]=useState({version:0,open:true,status:'failed',reasoning:'fixture reasoning '.repeat(50000),running:false});
 window.fixture={set:update=>flushSync(()=>setState(previous=>({...previous,...update}))),answer:state.answer??answer,prompt};
 const entries=[{kind:'message',id:'prompt',role:'user',text:prompt},{kind:'thinking',id:'reasoning',turnId:'turn-fixture',text:state.reasoning,done:!state.running},{kind:'message',id:'answer',role:'assistant',text:state.answer??answer,turnId:'turn-fixture',done:true}];
 return <><main id="fixture-chat"><ChatMessages entries={entries} agentName="Fixture" running={false}/></main><aside id="fixture-activity"><SessionActivity events={events(state.status,state.version)} plan={[]} timings={[]} goal={null} goalReview={null} open={state.open}/></aside></>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
async function bundle(before) {
  return (
    await build({
      stdin: {
        contents: entry,
        resolveDir: resolve(root, "frontend"),
        sourcefile: "next-details-fixture.jsx",
        loader: "jsx",
      },
      bundle: true,
      minify: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      tsconfig: resolve(root, "frontend/tsconfig.json"),
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.NEXT_PUBLIC_PLATFORM_URL": '"http://fixture.invalid"',
      },
      plugins: before
        ? [
            {
              name: "baseline-details",
              setup(build) {
                build.onLoad(
                  {
                    filter:
                      /components\/(thinking-block|chat-messages|session-activity|streaming-markdown)\.tsx$/,
                  },
                  (args) => ({
                    contents: execFileSync(
                      "git",
                      [
                        "show",
                        beforeRef + ":" + args.path.slice(root.length + 1),
                      ],
                      { cwd: root, encoding: "utf8" },
                    ),
                    loader: "tsx",
                  }),
                );
              },
            },
          ]
        : [],
    })
  ).outputFiles[0].text;
}
const [before, after] = await Promise.all([bundle(true), bundle(false)]);
const styles = await Promise.all(
  [
    "frontend/app/chat.css",
    "frontend/styles/v2/tokens.css",
    "frontend/styles/v2/base.css",
    "frontend/styles/v2/chat.css",
    "frontend/styles/v2/session.css",
  ].map((path) => readFile(resolve(root, path), "utf8")),
);
const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 4494;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/bundle.js") {
    response.writeHead(200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-store",
    });
    response.end(url.searchParams.has("before") ? before : after);
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  });
  response.end(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
      styles.join("\n") +
      '\nbody{margin:0;padding:12px}main{max-width:760px;margin:auto}aside{max-width:480px;margin:24px auto}*{box-sizing:border-box}.grow{min-width:0}</style></head><body><div id="root"></div><script src="/bundle.js' +
      (url.searchParams.has("before") ? "?before=1" : "") +
      '"></script></body></html>',
  );
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      url: "http://127.0.0.1:" + port,
      beforeRef,
      scope:
        "Synthetic isolated actual React components; production React; no API/provider; no production Next route or layout measurements",
    }),
  ),
);
