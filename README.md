# pi-cost-switch

Pi extension that estimates **next-turn cost before** you change model or thinking level.

Built-in `/model` and thinking controls only notify after the change. This extension owns a pre-change switch UX with:

- **hit** — warm continuation using the recent cache hit rate
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
next≈$0.162 · miss $1.35
```

- **next≈** — estimated warm (cache-hit) next-turn total
- **miss** — estimated base-cold total if the cache is lost

Toggle with `/cost-switch status`.

## How estimates work

| Field | Meaning |
|---|---|
| **hit** | Continue with recent session cache hit rate (default ~85% if unknown) |
| **cold** | Range: normal uncached total → cache-write premium upper bound |
| **tax** | Extra vs cache-read for the previous cacheable prefix only |

Model switches and reasoning changes are treated as **cache-miss risks**. Output/reasoning is a heuristic from session averages × thinking effort multipliers — not provider-exact.

Subscription / zero-priced models show **`sub`** instead of `$0.00`.

## Dev layout

```text
pi-cost-switch/
├── package.json          # pi-package manifest
├── README.md
├── LICENSE
└── extensions/
    └── cost-switch/
        └── index.ts      # extension entrypoint
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
