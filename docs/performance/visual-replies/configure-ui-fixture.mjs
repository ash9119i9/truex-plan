const id = "12345678-1234-1234-1234-123456789abc";
const visual = {
  id,
  title: "Capacity",
  description: "Interactive capacity fixture",
  height: 260,
  turnId: "fixture-visual-turn",
  callId: "fixture-call",
};
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>h2{margin:0} .chart{display:flex;gap:12px;align-items:end;height:80px} .bar{width:40px;background:var(--viz-series-1)} button{margin-top:12px}</style></head><body><h2>Weekly capacity</h2><p id="value"></p><div class="chart" role="img" aria-label="Capacity bars"><div class="bar" style="height:50%"></div><div class="bar" style="height:80%"></div></div><button class="btn" id="add">Add teammate</button><button class="btn" id="ask">Discuss capacity</button><script>let n=window.openai.widgetState?.modelContent?.team||5;function report(){document.querySelector('#value').textContent=n+' teammates';window.openai.setWidgetState({modelContent:{team:n},privateContent:{}});parent.postMessage({channel:'truex-qa',team:n,theme:document.documentElement.dataset.theme,bg:getComputedStyle(document.body).backgroundColor,ink:getComputedStyle(document.body).color,width:innerWidth,scroll:document.documentElement.scrollWidth},'*')}document.querySelector('#add').onclick=()=>{n++;report()};document.querySelector('#ask').onclick=()=>window.openai.sendFollowUpMessage({prompt:'Explain this capacity',title:'Capacity question'});new MutationObserver(report).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});new ResizeObserver(report).observe(document.body);report();</script></body></html>`;
const data = {
  id: "fixture-a",
  visualizations: [
    { ...visual, html, sourceFormat: "document", mode: "inline" },
  ],
  append: [
    {
      _id: "fixture-visual-user",
      sessionId: "fixture-a",
      role: "user",
      text: "Show capacity",
      turnId: visual.turnId,
      at: "2026-10-07T00:00:00.000Z",
    },
    {
      _id: "fixture-visual",
      sessionId: "fixture-a",
      role: "assistant",
      text: "",
      turnId: visual.turnId,
      visuals: [visual],
      at: "2026-10-07T00:00:01.000Z",
    },
    {
      _id: "fixture-visual-answer",
      sessionId: "fixture-a",
      role: "assistant",
      text: "Explore capacity using the controls.",
      turnId: visual.turnId,
      itemId: "fixture-answer",
      messageIndex: 0,
      at: "2026-10-07T00:00:02.000Z",
    },
  ],
  snapshot: { visuals: [visual] },
};
console.log(
  await (
    await fetch("http://127.0.0.1:4511/__configure", {
      method: "POST",
      body: JSON.stringify(data),
    })
  ).text(),
);
