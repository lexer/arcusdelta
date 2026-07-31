# CLAUDE.md

Project-specific rules for working in this repository.

## AI

- Clear context after every commit
- Store necessary context in the plan

## Typescript style

Use google typescript code style https://google.github.io/styleguide/tsguide.html

Follow do's and don'ts https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html

Configure TypeScript to be strict:

strict: true
noImplicitAny
strictNullChecks
noUncheckedIndexedAccess
exactOptionalPropertyTypes

## Modularization

Keep the code organized in modules by follow industry best practices for TypeScript. 

## Dependency injection

Use [samber/do](https://github.com/samber/do) exclusively for dependency injection. Do not introduce other DI frameworks or hand-rolled DI containers. Use v2 version.

## Development workflow

- Implement iteratively: make small, atomic changes rather than large sweeping ones.
- Before committing any change, run the full test suite and linters, and ensure they pass.

## Arcus SDK

https://github.com/arcus-xyz/arcus-spot-sdk

## Production Wallet

Read seed phrase from .env called SEED

## Robinhood Chain

JSON-RPC endpoint for Robinhood Chain mainnet. REQUIRED for on-chain execution.
RPC_URL="https://rpc.mainnet.chain.robinhood.com"

Chain id (Robinhood Chain mainnet).
CHAIN_ID=4663

## Logging

Log the critical parts of each flow (entry/exit points, external calls, state transitions, error paths) so issues can be debugged from logs alone. Include enough context (e.g. relevant IDs, parameters) in each log line to trace a single request/operation through the system.

## Documentation

For each module concisely document architecture and purpose. Use mermaid for diagrams. Keep documentaton up to date when making changes.

## Git

After commit push to origin
