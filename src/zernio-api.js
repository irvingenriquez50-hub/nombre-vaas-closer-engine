export class ProviderError extends Error {
  constructor(status, code, message,providerCode=null) { super(message); this.status = status; this.code = code; this.providerCode=providerCode; }
}
export function createZernioClient({ key, fetchImpl = fetch } = {}) {
  return async (path, { method = 'GET', body, idempotencyKey } = {}) => {
    if (!key) throw new ProviderError(503, 'setup_required', 'Falta conectar Zernio en la configuración del servidor.');
    let res;
    try {
      res = await fetchImpl(`https://zernio.com/api/v1${path}`, {
        method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
      });
    } catch { throw new ProviderError(502, 'outcome_unknown', 'No se pudo confirmar la respuesta de Zernio.'); }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.success === false) {
      throw new ProviderError(res.ok ? 502 : res.status, data?.code || 'provider_error',
        `Zernio no completó la operación (${data?.code || res.status}).`,data?.platformError?.error?.code||data?.platformError?.code||null);
    }
    return data;
  };
}
export const zernio = (...args) => createZernioClient({ key: process.env.ZERNIO_API_KEY })(...args);
