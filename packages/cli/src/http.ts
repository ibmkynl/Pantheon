function wrapFetchError(err: unknown, url: string): never {
  const msg = String(err);
  if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
    throw new Error('Pantheon servers are not running. Start them with: pantheon');
  }
  throw err instanceof Error ? err : new Error(msg);
}

export async function post<T = unknown>(url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) { wrapFetchError(err, url); }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function get<T = unknown>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) { wrapFetchError(err, url); }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
