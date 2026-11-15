// Appels HTTP sortants (Google, Apple, OpenAI) — avec délai maximal.
// Sans délai, un amont qui ne répond pas bloquerait la requête API
// indéfiniment. Le proxy de sortie du bac à sable est lu depuis
// l'environnement par fetch (NODE_USE_ENV_PROXY) ; en production
// (serveur hébergé) les appels partent en direct.
const DEFAULT_TIMEOUT_MS = 15000;

export async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const resp = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, ok: resp.ok, data };
}

export async function fetchText(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const resp = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text().catch(() => '');
  return { status: resp.status, ok: resp.ok, text };
}
