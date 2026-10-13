# tula-closeline-auth

Closeline auth service: sign-up, sign-in, sessions and tokens, copied from tula-auth

Part of Closeline. The hub repo [`tula-closeline`](https://github.com/Tula-Solutions/tula-closeline)
holds the glossary, decision records, plans, issues and the shared workflow setup.

## Getting started

```bash
# Once per machine, if you have no SSH key on GitHub: fetch the private tula-closeline-*
# libraries over https with your gh login.
gh auth setup-git
git config --global url."https://github.com/Tula-Solutions/".insteadOf "ssh://git@github.com/Tula-Solutions/"

bun install
bun run verify

# Integration tests need the compose Postgres (POSTGRES_PORT=5433 if 5432 is taken).
docker compose up -d --wait
bun run test:integration
docker compose down -v
```

Standards: `AGENTS.md` (this repo) and `.claude/COMMON.md` (shared).
