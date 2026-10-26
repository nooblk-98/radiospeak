import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { verifyAccount } from "./accounts.ts";
import type { WebAccount } from "./store.ts";
import { owner, type Viewer } from "./policies.ts";

const COOKIE = "radiospeak_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Signed session cookies for the web panel. The signing key derives from the
 * password, so sessions survive restarts and changing the password signs everyone out.
 * Basic auth stays available for scripts calling the API.
 */
export class WebAuth {
  readonly enabled: boolean;
  #password: Buffer;
  #key: Buffer;
  /** Signed-out session nonces, kept until the session would have expired. */
  #revoked = new Map<string, number>();
  #failures = new Map<string, { count: number; since: number }>();
  #accounts: () => readonly WebAccount[];
  #pending = 0;

  constructor(password: string, accounts: () => readonly WebAccount[] = () => []) {
    this.enabled = password !== "";
    this.#password = Buffer.from(password);
    this.#key = createHmac("sha256", "radiospeak-session").update(password).digest();
    this.#accounts = accounts;
  }

  /** Session cookie for any request; Basic auth only where `allowBasic` (the API). */
  authorized(req: IncomingMessage, allowBasic: boolean): boolean {
    return this.viewer(req,allowBasic) !== undefined;
  }
  viewer(req: IncomingMessage, allowBasic = true): Viewer | undefined {
    if (!this.enabled) return owner;
    const session = this.#session(req);
    return session?.viewer ?? (allowBasic && this.#basic(req) ? owner : undefined);
  }

  /** Checks the password and returns the Set-Cookie header for a new session. */
  async login(req: IncomingMessage, password: string, remember: boolean, username = "owner"): Promise<string> {
    const ip = req.socket.remoteAddress ?? "";
    const now = Date.now();
    const failed = this.#failures.get(ip);
    if (failed && now - failed.since > LOCKOUT_MS) this.#failures.delete(ip);
    else if (failed && failed.count >= MAX_FAILURES) {
      const minutes = Math.ceil((failed.since + LOCKOUT_MS - now) / 60_000);
      throw new AuthError(429, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }
    username = username.trim().toLowerCase() || "owner";
    const account = this.#accounts().find(a => a.username === username);
    if (this.#pending >= 4) throw new AuthError(429,"Sign-in service is busy. Try again shortly.");
    this.#pending++;
    let valid: boolean;
    try { valid = username === "owner" ? sameBytes(Buffer.from(password), this.#password) : account ? await verifyAccount(account,password) : false; }
    finally { this.#pending--; }
    if (!valid) {
      const entry = this.#failures.get(ip) ?? { count: 0, since: now };
      entry.count++;
      this.#failures.set(ip, entry);
      for (const [key,value] of this.#failures) if (now - value.since > LOCKOUT_MS) this.#failures.delete(key);
      if (this.#failures.size > 4096) this.#failures.delete(this.#failures.keys().next().value!);
      throw new AuthError(401, "That password isn't right.");
    }
    this.#failures.delete(ip);
    const expires = now + (remember ? REMEMBER_MS : SESSION_MS);
    const payload = [expires, randomBytes(16).toString("base64url"), Buffer.from(username).toString("base64url"), account?.version ?? "owner"].join(".");
    const token = payload + "." + this.#sign(payload);
    return this.#cookie(req, token, remember ? Math.floor(REMEMBER_MS / 1000) : undefined);
  }

  /** Revokes the request's session and returns a Set-Cookie header that clears it. */
  logout(req: IncomingMessage): string {
    const session = this.#session(req);
    if (session) this.#revoked.set(session.nonce, session.expires);
    for (const [nonce, expires] of this.#revoked) if (expires < Date.now()) this.#revoked.delete(nonce);
    return this.#cookie(req, "", 0);
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#key).update(payload).digest("base64url");
  }

  #session(req: IncomingMessage): { expires: number; nonce: string; viewer: Viewer } | undefined {
    const token = (req.headers.cookie ?? "").split(";").map((c) => c.trim())
      .find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
    const parts = token?.split(".") ?? [];
    if (parts.length !== 3 && parts.length !== 5) return;
    const [expiresText, nonce] = parts;
    const signature = parts.at(-1), payload = parts.slice(0,-1).join(".");
    if (!expiresText || !nonce || !signature) return undefined;
    if (!sameBytes(Buffer.from(signature), Buffer.from(this.#sign(payload)))) return undefined;
    const expires = Number(expiresText);
    if (!(expires > Date.now()) || this.#revoked.has(nonce)) return undefined;
    if (parts.length === 3) return { expires, nonce, viewer: owner };
    const username = Buffer.from(parts[2]!,"base64url").toString();
    if (username === "owner" && parts[3] === "owner") return { expires, nonce, viewer: owner };
    const account = this.#accounts().find(a => a.username === username && a.version === parts[3]);
    return account ? { expires, nonce, viewer: { id: "web:" + username, username, role: account.role } } : undefined;
  }

  #basic(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Basic ")) return false;
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    return sameBytes(Buffer.from(decoded.slice(decoded.indexOf(":") + 1)), this.#password);
  }

  #cookie(req: IncomingMessage, value: string, maxAge: number | undefined): string {
    const secure = (req.socket as { encrypted?: boolean }).encrypted || req.headers["x-forwarded-proto"] === "https";
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax` + (maxAge === undefined ? "" : `; Max-Age=${maxAge}`) + (secure ? "; Secure" : "");
  }
}
