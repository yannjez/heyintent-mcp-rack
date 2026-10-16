import type { FastifyReply, FastifyRequest } from "fastify";

/** Build a web-standard Request from a Fastify request (body re-serialized when parsed). */
export function toWebRequest(request: FastifyRequest, overridePath?: string): Request {
  const proto = request.headers["x-forwarded-proto"] ?? request.protocol;
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost";
  const url = new URL(overridePath ?? request.url, `${proto}://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else headers.set(name, value);
  }
  const hasBody =
    request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined;
  let body: string | undefined;
  if (hasBody) {
    body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    headers.delete("content-length");
  }
  return new Request(url, {
    method: request.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/** Fastify 5 streams a web Response (status, headers, body) natively. */
export function sendWebResponse(reply: FastifyReply, response: Response) {
  return reply.send(response);
}

export function jsonError(
  reply: FastifyReply,
  status: number,
  message: string,
  extraHeaders?: Record<string, string>,
) {
  if (extraHeaders) reply.headers(extraHeaders);
  return reply.status(status).send({ error: message });
}
