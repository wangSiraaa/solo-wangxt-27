async function request(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.message;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg ?? data ?? res.status));
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
};

/** 前端幂等键：同一表单未改内容重复点击不会生成新键 */
export function idemKey(prefix, payload) {
  return `${prefix}:${JSON.stringify(payload)}`;
}
