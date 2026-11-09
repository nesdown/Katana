# Contributing

The most useful thing you can do right now: run a bot against a real account and report what happened. The adapters follow each network's documentation but have not all been tried on live accounts.

```bash
pnpm install
pnpm test        # builds, then runs everything, including a real kill -9 crash test
pnpm typecheck
```

## Adding a target

Implement `Target` in `src/targets/`, export it, and add a test in `test/targets.test.ts` that checks the exact HTTP requests against the network's docs.

Three rules protect users:

1. **Set `idempotent: true` only if the network itself rejects duplicates.** Getting this wrong causes double posts.
2. **Use `publishParts`** for threads, so a failure resumes instead of repeating.
3. **Never let a secret reach an error message.** URLs with tokens must be covered by `safeUrl`.

## Adding a source or cut

A source is `{ name, read(ctx) }`. A cut is `{ name, kind, apply(item, ctx) }`. Treat everything from the web as hostile: fetch URLs found in content with `ctx.http.untrustedPage` or `ctx.http.bytes`, which block private networks.

## Style

No em dashes in user-facing text. Write error messages that say what to do next.
