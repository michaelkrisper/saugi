// Per-client limits for the relays: without them anyone could drive Roborock's
// API from the server's address until Roborock blocks it.

/**
 * Token bucket per key: `capacity` requests at once, refilled evenly over
 * `perMs`. Returns a function that takes one token and tells whether there was one.
 */
export function createLimiter({ capacity, perMs, maxKeys = 10_000, now = Date.now }) {
  const buckets = new Map();
  return (key) => {
    const at = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxKeys) {
        // Full again means forgotten; if that frees nothing, the oldest goes.
        for (const [k, b] of buckets) if (at - b.at >= perMs) buckets.delete(k);
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
      }
      bucket = { tokens: capacity, at };
      buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + ((at - bucket.at) * capacity) / perMs);
    bucket.at = at;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}

/**
 * Who a request counts against: the address the proxy saw (it sets
 * CF-Connecting-IP itself, a client cannot), IPv6 by its /64 since one
 * customer owns all of it.
 */
export function clientKey(incoming) {
  const ip = String(
    incoming.headers['cf-connecting-ip'] ?? incoming.socket.remoteAddress ?? '',
  ).toLowerCase();
  if (!ip.includes(':')) return ip;
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1);
  const [head, tail] = ip.split('::');
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(':') : [];
    while (groups.length + rest.length < 8) groups.push('0');
    groups.push(...rest);
  }
  return groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':');
}
