# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Snowbow19/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Snowbow19/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in TypeScript on Node 22, standard library only: git smart HTTP (upload-pack v2 / receive-pack v0), REST v3, GraphQL v4 and MCP in a single process, with its own in-memory store. No UI, no git binary, no outside services.

## Run it

```sh
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port, registers it with the environment at `$MAKEFUN_ENV_URL`, serves until the environment says done, then exits 0. The scored surface is `/{owner}/{repo}.git`, `/api/v3`, `/api/graphql` and `/mcp`, plus `GET /healthz`.

## Layout

- `main.ts` — the entry ↔ environment lifecycle (bind, register, wait for done). Kept as the kit starter ships it.
- `app.ts` — the HTTP server: router, auth, and the four surfaces.
- `store.ts` — the in-memory store: repositories, refs, git objects, issues, pull requests, labels.
- `git.ts` — git object serialization, packfiles, pkt-line/sideband framing, protocol v2 upload-pack and v0 receive-pack.
- `rest.ts` — REST v3 resources.
- `graphql.ts` — the GraphQL executor for the documents `gh` and `github-mcp-server` send.
- `mcp.ts` — MCP over Streamable HTTP (JSON-RPC 2.0).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
