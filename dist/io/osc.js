export {};
/* Task: Implement OSC I/O (udp)
Spec: /src/Architecture.md — "OSC"

Acceptance Criteria:
- export function createOsc(opts?: { localPort?: number; remoteAddress?: string; remotePort?: number })
  returns { send(path: string, ...args: (number|string|boolean)[]): void; onMessage(cb:(path:string,args:any[])=>void): void; close(): void }
- Default localPort=57121, remoteAddress='127.0.0.1', remotePort=57120.
- Use 'osc' package with ESM import; UDP ports.
- onMessage: invoke cb for each incoming OSC message (string path + JS array args).
- send: serialize to OSC and send to remote.
- No globals; safe to instantiate once from the daemon and pass ctx.osc to pages.
*/
