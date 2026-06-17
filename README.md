# 🔨 Sealed-Bid Auction on Solana

Front-running-proof auctions using [Arcium](https://arcium.com) MPC.

## The Problem

On-chain auctions are transparent — everyone sees every bid in real time. Bidders snipe at the last second, copy the highest bid, and front-run each other. Fair price discovery is impossible.

## The Solution

Bids are encrypted client-side. Arcium's MPC cluster compares them to find the winner **without ever seeing the bid amounts.** Only the winning bid is revealed. Every losing bid stays encrypted forever.

## How It Works

1. Bidder encrypts their bid (X25519 + Rescue cipher)
2. Encrypted bid submitted to Solana
3. MPC compares it against the current highest — without decrypting either
4. New highest bid returned (still encrypted)
5. Losing bids never exposed on-chain

## Use Cases

- NFT launchpads (fair mint pricing)
- Token launches (no front-running)
- DAO treasury asset sales
- Domain / land auctions in GameFi

## Tech Stack

- Solana + Anchor 1.0.2
- Arcium MPC + Arcis (Rust circuits)
- TypeScript client

## Run

```bash
yarn install
arcium test
```

## License

MIT
