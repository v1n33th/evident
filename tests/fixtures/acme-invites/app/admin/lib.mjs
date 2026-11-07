const URL_BASE = process.env.ADMIN_URL ?? 'http://localhost:4174';

export async function admin(path, body = {}) {
  let res;
  try {
    res = await fetch(URL_BASE + path, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    console.error(`Fixture server not running at ${URL_BASE}. Start it with: node server.mjs`);
    process.exit(1);
  }
  const json = await res.json();
  if (!res.ok) {
    console.error(json.error ?? `Request failed (${res.status}).`);
    process.exit(1);
  }
  return json;
}

export const print = (o) => Object.entries(o).forEach(([k, v]) => console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`));
