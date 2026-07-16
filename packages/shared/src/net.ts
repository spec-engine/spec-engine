// packages/shared/src/net.ts
//
// Runtime-free network predicates shared by every write surface (engine
// `/api/*` and webapp `/editor/*`). Kept in @spec-engine/shared so the two
// packages enforce ONE contract — a rebinding hole patched in one surface but
// not the other would be worse than none.

/**
 * The hostnames a loopback-bound server legitimately answers on. `spec serve`
 * binds 127.0.0.1 exclusively (commands/serve.ts), and Bun's in-process
 * `app.request(path)` forward synthesizes `http://localhost/…`, so a genuine
 * request always arrives with one of these. Anything else is a DNS-rebinding
 * attack: an attacker page whose domain resolves to 127.0.0.1 reaches the
 * loopback server carrying `Host: evil.example`.
 *
 * `URL.hostname` returns the bracketed form for IPv6, so both `::1` and
 * `[::1]` are listed.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * True when `hostname` (a `URL.hostname`, port already stripped) is a loopback
 * name the local server may answer on. Write routes require this in ADDITION
 * to the Origin/Host same-origin check: that check compares two
 * attacker-influenceable headers against each other and so cannot catch a
 * rebind where both agree on a non-loopback host. Pinning the Host to loopback
 * closes the gap because the server never binds a routable interface.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}
