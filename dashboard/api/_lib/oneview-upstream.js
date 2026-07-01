const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class OneViewUpstreamError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "OneViewUpstreamError";
    this.status = status;
    this.code = code;
  }
}

function upstreamErrorCode(status) {
  if (status === 401) return "upstream_authentication_failed";
  if (status === 403) return "upstream_access_forbidden";
  if ([502, 503, 504].includes(status)) return "upstream_unavailable";
  return "upstream_request_failed";
}

export async function fetchOneViewUpstream(route, queryString, config, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const base = config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
    const url = new URL(`${route.upstreamPath.replace(/^\/+/, "")}${queryString}`, base);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "CF-Access-Client-Id": config.accessClientId,
        "CF-Access-Client-Secret": config.accessClientSecret,
      },
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new OneViewUpstreamError(response.status, upstreamErrorCode(response.status));
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new OneViewUpstreamError(502, "upstream_response_too_large");
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new OneViewUpstreamError(502, "upstream_response_too_large");
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new OneViewUpstreamError(502, "upstream_invalid_response");
    }
  } catch (error) {
    if (error instanceof OneViewUpstreamError) throw error;
    if (error?.name === "AbortError") throw new OneViewUpstreamError(504, "upstream_timeout");
    throw new OneViewUpstreamError(502, "upstream_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
