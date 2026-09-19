export const base =
  process.env.NEXT_PUBLIC_PLATFORM_URL || "http://localhost:4000";
export async function api(path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
