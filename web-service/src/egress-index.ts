import { createEgressProxy } from "./egress-proxy";
const proxy = createEgressProxy();
proxy.server.listen(Number(process.env.EGRESS_PROXY_PORT || 3128), "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => proxy.close());
