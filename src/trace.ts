/**
 * Structured tracing helpers. Every SRE data-plane call, token acquisition, and OBO
 * exchange logs a request and a response line so the full flow can be reconstructed
 * from the container logs. Token bodies are never logged; only non-secret claims that
 * are needed to trace identity (audience, authorized party, scopes, object id) are.
 */

/** Emit one structured trace line. Always JSON so it is greppable in docker logs. */
export function trace(event: string, data: Record<string, unknown> = {}): void {
  let payload: string;
  try {
    payload = JSON.stringify({ event, ts: new Date().toISOString(), ...data });
  } catch {
    payload = JSON.stringify({ event, ts: new Date().toISOString(), traceSerializeError: true });
  }
  console.log(payload);
}

/**
 * Decode the non-secret claims of a JWT for tracing. Does NOT verify the signature and
 * NEVER returns the raw token. Returns the identity-relevant claims (aud, iss, azp/appid,
 * scp/roles, oid, upn/preferred_username, tid, exp) so a bot-app token can be compared to
 * the portal's token when diagnosing why an OBO exchange does or does not execute.
 */
export function decodeTokenClaims(token: string | undefined | null): Record<string, unknown> {
  if (!token || typeof token !== "string") {
    return { present: false };
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return { present: true, decodable: false };
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(json) as Record<string, unknown>;
    return {
      present: true,
      decodable: true,
      aud: claims.aud,
      iss: claims.iss,
      azp: claims.azp,
      appid: claims.appid,
      appidacr: claims.appidacr,
      idtyp: claims.idtyp,
      scp: claims.scp,
      roles: claims.roles,
      oid: claims.oid,
      upn: claims.upn ?? claims.preferred_username ?? claims.unique_name,
      tid: claims.tid,
      ver: claims.ver,
      exp: claims.exp
    };
  } catch {
    return { present: true, decodable: false };
  }
}

/** Truncate a response body for logging so a large payload does not flood the logs. */
export function truncateBody(body: string, limit = 4000): string {
  if (body.length <= limit) {
    return body;
  }
  return `${body.slice(0, limit)}…[truncated ${body.length - limit} chars]`;
}
