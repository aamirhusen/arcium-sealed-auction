# sealed_auction

A confidential Solana app built with Arcium: an Anchor program queues computations, and Arcis instructions define the confidential logic.

## Quickstart

```bash
arcium build
arcium test
```

## Layout

| Path | Purpose |
|------|---------|
| `programs/sealed_auction/` | Anchor program: queues computations, handles callbacks |
| `encrypted-ixs/` | Arcis confidential instructions |
| `tests/sealed_auction.ts` | TypeScript integration tests |
| `Arcium.toml` | Localnet and cluster configuration |

## Docs

<https://docs.arcium.com/developers>
