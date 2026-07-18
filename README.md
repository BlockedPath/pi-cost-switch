# pi-cost-switch

Pi extension that estimates **next-turn cost before** you change model or thinking level.

Built-in `/model` and thinking controls only notify after the change. This extension owns a pre-change switch UX with:

- **hit** — warm continuation at the observed cache hit rate (`~85% (assumed)` when unknown)
- **cold** — base uncached total through cache-write-premium upper bound
- **tax** — extra cost from re-billing only the previous cacheable prefix

## Install

### From a local clone (development / sharing a path)

```bash
pi install /absolute/path/to/pi-cost-switch
# or from the package directory:
pi install .
```

### From git (once published)

```bash
pi install git:github.com/BlockedPath/pi-cost-switch
# optional pin:
pi install git:github.com/BlockedPath/pi-cost-switch@v0.1.0
```

### From npm (once published)

```bash
pi install npm:pi-cost-switch
```

### Temporary try without installing

```bash
pi -e /absolute/path/to/pi-cost-switch
```

Reload after install:

```text
/reload
```

## Commands

| Command | What it does |
|---|---|
| `/cost-switch [filter]` | Pick model + thinking with $ estimates, then apply |
| `/cost-estimate [filter]` | Comparison table only (no switch) |
| `/cost-switch status` | Toggle status-bar `next≈… · miss …` |
| `/cost-switch help` | Quick help |

## Status bar

Shows something like:

```text
next≈$0.162 · miss $1.35 · hit ~85% (assumed)
```

- **next≈** — estimated warm (cache-hit) next-turn total
- **miss** — estimated base-cold total if the cache is lost
- **hit** — rate used for the warm estimate (`72%` observed, or `~85% (assumed)` when unknown)

Toggle with `/cost-switch status`.

## How estimates work

| Field | Meaning |
|---|---|
| **hit** | Continue with observed session cache hit rate; shows `~85% (assumed)` when unknown (not `0%`) |
| **cold** | Range: normal uncached total → cache-write premium upper bound |
| **tax** | Extra vs cache-read for the previous cacheable prefix only |

Model switches and reasoning changes are treated as **cache-miss risks**. Output/reasoning is a heuristic from session averages × thinking effort multipliers — not provider-exact.

Subscription / zero-priced models show **`sub`** instead of `$0.00`.

## Dev layout

```text
pi-cost-switch/
├── package.json          # pi-package manifest + test script
├── README.md
├── LICENSE
├── test/
│   ├── estimate.test.ts  # pure cost helper unit tests (node:test)
│   └── hit-rate.test.ts  # observed vs assumed hit-rate policy
└── extensions/
    └── cost-switch/
        ├── index.ts      # extension entrypoint
        ├── estimate.ts   # pure cost math
        ├── format.ts     # pure $ / token formatters
        ├── hit-rate.ts   # observed vs assumed hit-rate policy
        └── rank.ts       # pure model filter/rank
```

### Tests

```bash
npm test
# or:
node --test --experimental-strip-types test/**/*.test.ts
```

Local auto-discovery (optional): symlink into the global extensions tree:

```bash
ln -sfn "$(pwd)/extensions/cost-switch" ~/.pi/agent/extensions/cost-switch
```

Or use `pi install .` so settings point at this package path.

## Security

Like all pi extensions, this runs with full system permissions. Review source before installing third-party copies.

## License

MIT
