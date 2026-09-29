/**
 * Where this process's own API answers, once it is listening.
 *
 * The desktop binds an OS-chosen port, so nothing knows the address until
 * the server says. A tool server an agent runs (a grandchild of this
 * process) calls back here for anything that needs this process -- its
 * sign-in, its relay to the cloud -- and is told this address in its
 * environment.
 */

let apiUrl: string | null = null;

export function setDaemonAddress(host: string, port: number): void {
  // A wildcard bind is reachable on loopback; a child never needs another interface.
  const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  apiUrl = `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}/api`;
}

/** `http://127.0.0.1:<port>/api`, or null before the server is listening. */
export function daemonApiUrl(): string | null {
  return apiUrl;
}
