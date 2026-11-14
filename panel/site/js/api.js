// Calls to the panel API (panel/worker). Throws an Error with the server's message on failure.
export async function api(method, path) {
  const res = await fetch(`/api${path}`, { method });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
