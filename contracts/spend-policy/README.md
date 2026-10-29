# Checkrail spend policy (Soroban)

A Stellar account that an AI payables agent can spend from but cannot abuse.

Checkrail Pay already enforces its autopilot limits in its own database. This contract moves the same limits onto the chain, so they hold even if the server is compromised or the model is confused:

| Rule | Who can change it | Enforced at |
|---|---|---|
| Per-payment cap | owner | propose and release |
| Rolling 24-hour cap (scheduled payments count; spend is kept per hour, so a payment counts for 24 to 25 hours and the stored list holds at most 25 entries) | owner | propose and release |
| Payee allow-list | owner only | propose and release |
| Cancel window before money moves (at least 60 seconds; zero is refused) | owner | release |
| Cancel a scheduled payment | owner | until release |
| Sweep a proposal nobody released (it lapses 3 days after its window and stops holding the daily cap) | anyone | after it lapses |
| Pause | owner or agent (the safe direction) | propose and release |
| Resume | owner only | |
| One payment per id (idempotency) | nobody | propose |
| Replace the agent key (the owner and the agent must be different keys) | owner | |
| Withdraw the whole balance | owner, any time | |

The agent key can only `propose`. Anyone can call `release` once the window has passed, and every check runs again at that moment. The business funds the contract with its own PYUSD or USDC and stays its owner, so Checkrail never holds funds.

## Status

Written and unit-tested (20 tests: caps, rolling window, allow-list, cancel, pause and resume, idempotency, lowered limits applying at release, a failed transfer leaving the payment pending, owner-only and agent-only authorisation, a flood of tiny payments leaving the spend list bounded, no zero cancel window, owner and agent kept apart, agent key rotation, proposals that lapse and can be swept, storage time-to-live topped up on use). Owner-side changes (payees, limits, agent key, withdrawals) emit events so a monitor can alert on them. Not yet deployed to testnet: the build environment it was written in has no network path to Stellar. The app does not call it yet; wiring it in as the Stellar rail's execution path is the proposed SCF work.

## Test

    cd contracts/spend-policy
    cargo test

## Build and deploy to testnet (on a machine with network access)

    rustup target add wasm32v1-none
    cargo install --locked stellar-cli
    cd contracts/spend-policy
    stellar contract build
    stellar keys generate owner --network testnet --fund
    stellar keys generate agent --network testnet --fund
    stellar contract id asset --asset PYUSD:GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G --network testnet

Then deploy with USD 500 per payment, USD 2,000 a day and a 10-minute window (amounts have 7 decimals):

    stellar contract deploy \
      --wasm target/wasm32v1-none/release/checkrail_spend_policy.wasm \
      --source owner --network testnet \
      -- --owner "$(stellar keys address owner)" --agent "$(stellar keys address agent)" \
         --token <the C... id printed above> \
         --per_payment_cap 5000000000 --daily_cap 20000000000 --cancel_window 600

Fund the contract with testnet PYUSD, allow a payee with `set_payee` (signed by owner), `propose` a payment (signed by agent), wait ten minutes, then `release` it and open the transaction in a testnet explorer.
