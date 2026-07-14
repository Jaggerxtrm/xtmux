# xtmux bridge — read-only remote observation

`ssh <host> xtmux bridge --stdio` speaks newline-delimited JSON (`xtrm.xtmux.bridge.v1`) so a viewer can observe a remote xtmux host. It reads; it never mutates. Transport, authentication, and authorization are OpenSSH's job — xtmux stores no keys and opens no socket.

Full method/error reference lives in the `obs:bridge` row of [json-command-api.md](json-command-api.md). This file is about deploying it **safely**, which is not optional.

## The read-only guarantee is only as strong as the SSH key you grant

The bridge process refuses every mutating method. But that guarantee protects nothing if the SSH credential a viewer uses can also run `xtmux message-send`, `xtmux handoff`, or a plain shell — because then the peer simply doesn't use the bridge. **A viewer key with normal shell access is not a read-only boundary.** The boundary is a server-side forced command on a dedicated key.

### Minimum safe deployment

Mint a key used for nothing else, and pin it to the bridge in the host's `~/.ssh/authorized_keys`:

```
command="exec xtmux bridge --stdio",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,restrict ssh-ed25519 AAAA... viewer-bridge-only
```

- `command="..."` — the key can run **only** the bridge, whatever the client asks for. `$SSH_ORIGINAL_COMMAND` is ignored.
- `no-pty` — no interactive terminal.
- `no-*-forwarding` / `restrict` — no tunnels back into the host's network. `restrict` implies all current `no-*` options and is forward-compatible with future ones; the explicit flags are belt-and-suspenders for older OpenSSH.

With that in place the same key that completes a `bridge.hello` handshake will fail `ssh host id`, fail any mutation command, and cannot open a PTY or a tunnel.

### Verifying the boundary

```
ssh -i viewer-bridge-only host xtmux bridge --stdio   # handshake succeeds
ssh -i viewer-bridge-only host id                     # forced command runs the bridge, not `id`
ssh -i viewer-bridge-only -N -L 9000:localhost:22 host  # rejected: no port forwarding
```

## What the bridge bounds on its own

The forced command is the boundary; these are the in-process limits that keep one connection from degrading the host even with a legitimate key:

- **Default deny.** Methods dispatch from an allowlist. A mutation name is refused (`XTMUX_BRIDGE_READ_ONLY`), an unknown one is refused (`XTMUX_BRIDGE_UNKNOWN_METHOD`), and neither routes to the local CLI.
- **Bounded frames.** Requests cap at 1 MiB, enforced on the unparsed buffer so a peer cannot stall the reader by never sending a newline.
- **Bounded fan-out.** At most a few concurrent `journal.follow` streams per connection (`XTMUX_BRIDGE_RESOURCE_LIMIT` past the cap) — each stream is a poll loop, so the count is capped, not just duplicate ids.
- **Backpressure.** If the peer stops reading, the reader pauses rather than buffering replies without bound.
- **Survivable.** Malformed input is answered and the stream keeps serving; the process exits only on a graceful EOF.
