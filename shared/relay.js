// Only Roborock hosts may be reached through the relays, so they can't be
// abused as an open proxy.
export const ALLOWED_HOST = /^[a-z0-9-]+\.roborock\.com$/;
