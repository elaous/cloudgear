# Contributing

Thanks for helping with cloudgear. Bug reports, fixes and documentation
improvements are welcome. For a larger change, open an issue first so the
approach can be agreed before you write it.

## Setup

[Bun](https://bun.sh) 1.x is the only tool you need.

```sh
git clone https://github.com/elaous/cloudgear.git
cd cloudgear
bun install
```

## Checks

A pull request MUST pass these:

```sh
bun test              # the full suite (about 5 minutes)
bun run typecheck     # tsc --noEmit
bun run lint          # biome lint .
```

`bun test tests/<file>.test.ts` runs one file while you work. Add or update a
test for every behavior change; fixtures for the analyzer live in
`tests/fixtures/`.

## Continuous integration

A pull request runs only the tests that your change can affect:
`scripts/changed-tests.ts` maps each changed file under `src/` and `packages/`
to its tests and to the tests of the modules that import it. The full suite
runs instead when a change touches `package.json`, `bun.lock`, `tsconfig*.json`,
`scripts/`, `.github/workflows/`, `tests/fixtures/` or a shared module, and a
nightly run covers everything. A change to documentation alone runs no tests.
Type checking and linting always run.

To see what CI will run for your branch:

```sh
git diff --name-only origin/main...HEAD | bun scripts/changed-tests.ts
```

## Code style

- Code explains itself through names and structure. Comments are for behavior
  a careful reader would not expect, or a constraint a refactor MUST keep, in
  about ten words or fewer.
- Do not narrate the change in source comments; put that context in the pull
  request description.
- Commit subjects are imperative ("Add X", not "Added X").
- In documentation and pull request descriptions, state obligations with
  RFC 2119 keywords (MUST, SHOULD, MAY).

## Pull requests

Keep a pull request to one change, describe what and why, and fill in the
template. Do not commit secrets, `.env` files, generated `.cloudgear/`
directories or `cloudgear.prototxt`.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE), and you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security problems as described in
[SECURITY.md](SECURITY.md), not in public issues.
