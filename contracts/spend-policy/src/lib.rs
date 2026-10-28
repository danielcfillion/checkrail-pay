#![no_std]
//! Checkrail spend policy: a Stellar account an AI payables agent can spend from but cannot abuse.
//!
//! The business funds this contract with its own stablecoin (PYUSD or USDC) and stays its owner. The agent key that
//! Checkrail Pay runs can only *propose* a payment. The chain itself then enforces what the app enforces today in its
//! database:
//!
//! * a per-payment cap and a rolling 24-hour cap (scheduled payments count against it),
//! * a payee allow-list that only the owner can change,
//! * a cancel window: a proposed payment can be released only after it, and the owner can cancel it until then,
//! * an owner pause key (the agent may also pause, the safe direction, but only the owner can resume),
//! * idempotency: a payment id can be used once, so a retried proposal never pays twice.
//!
//! Release is permissionless after the window: anyone (a keeper, the app's heartbeat) can trigger it, and every check
//! runs again at that moment. A compromised server or a confused model therefore cannot overspend, pay a stranger or
//! skip the window, because the contract refuses. The owner can always withdraw the balance: Checkrail never holds funds.

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN, Env, String, Vec};

const DAY: u64 = 86_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Paused = 1,
    NotAllowed = 2,
    OverPaymentCap = 3,
    OverDailyCap = 4,
    DuplicateId = 5,
    UnknownPayment = 6,
    NotPending = 7,
    WindowOpen = 8,
    BadAmount = 9,
    BadLimits = 10,
    NotOwnerOrAgent = 11,
    MemoTooLong = 12,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub owner: Address,
    pub agent: Address,
    pub token: Address,
    pub per_payment_cap: i128,
    pub daily_cap: i128,
    pub cancel_window: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Pending,
    Released,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payment {
    pub payee: Address,
    pub amount: i128,
    pub proposed_at: u64,
    pub release_at: u64,
    pub status: Status,
    pub memo: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Spend {
    pub at: u64,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    Paused,
    Pending,
    Spends,
    Allowed(Address),
    Payment(BytesN<32>),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposed {
    #[topic]
    pub id: BytesN<32>,
    pub payee: Address,
    pub amount: i128,
    pub release_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    #[topic]
    pub id: BytesN<32>,
    pub payee: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cancelled {
    #[topic]
    pub id: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedChanged {
    pub paused: bool,
    pub by: Address,
}

#[contract]
pub struct SpendPolicy;

fn cfg(env: &Env) -> Config {
    env.storage().instance().get(&Key::Config).unwrap()
}

fn paused(env: &Env) -> bool {
    env.storage().instance().get(&Key::Paused).unwrap_or(false)
}

fn pending_total(env: &Env) -> i128 {
    env.storage().instance().get(&Key::Pending).unwrap_or(0)
}

/// Released spend in the last 24 hours, with older entries dropped so storage stays bounded.
fn recent_spends(env: &Env) -> (Vec<Spend>, i128) {
    let now = env.ledger().timestamp();
    let all: Vec<Spend> = env.storage().instance().get(&Key::Spends).unwrap_or(Vec::new(env));
    let mut kept = Vec::new(env);
    let mut total: i128 = 0;
    for s in all.iter() {
        if s.at + DAY > now {
            total += s.amount;
            kept.push_back(s);
        }
    }
    (kept, total)
}

fn is_allowed(env: &Env, payee: &Address) -> bool {
    env.storage().persistent().get(&Key::Allowed(payee.clone())).unwrap_or(false)
}

fn check_limits(per_payment_cap: i128, daily_cap: i128) -> Result<(), Error> {
    if per_payment_cap <= 0 || daily_cap <= 0 || per_payment_cap > daily_cap {
        return Err(Error::BadLimits);
    }
    Ok(())
}

#[contractimpl]
impl SpendPolicy {
    pub fn __constructor(env: Env, owner: Address, agent: Address, token: Address, per_payment_cap: i128, daily_cap: i128, cancel_window: u64) -> Result<(), Error> {
        check_limits(per_payment_cap, daily_cap)?;
        env.storage().instance().set(&Key::Config, &Config { owner, agent, token, per_payment_cap, daily_cap, cancel_window });
        Ok(())
    }

    /// The agent proposes a payment. Nothing moves until `release` after the cancel window.
    pub fn propose(env: Env, id: BytesN<32>, payee: Address, amount: i128, memo: String) -> Result<u64, Error> {
        let c = cfg(&env);
        c.agent.require_auth();
        if paused(&env) {
            return Err(Error::Paused);
        }
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        if memo.len() > 64 {
            return Err(Error::MemoTooLong);
        }
        if env.storage().persistent().has(&Key::Payment(id.clone())) {
            return Err(Error::DuplicateId);
        }
        if !is_allowed(&env, &payee) {
            return Err(Error::NotAllowed);
        }
        if amount > c.per_payment_cap {
            return Err(Error::OverPaymentCap);
        }
        let (_, spent) = recent_spends(&env);
        let pending = pending_total(&env);
        if spent + pending + amount > c.daily_cap {
            return Err(Error::OverDailyCap);
        }
        let now = env.ledger().timestamp();
        let release_at = now + c.cancel_window;
        env.storage().persistent().set(&Key::Payment(id.clone()), &Payment { payee: payee.clone(), amount, proposed_at: now, release_at, status: Status::Pending, memo });
        env.storage().instance().set(&Key::Pending, &(pending + amount));
        Proposed { id, payee, amount, release_at }.publish(&env);
        Ok(release_at)
    }

    /// Anyone may release a payment once its window has passed. Every check runs again here.
    pub fn release(env: Env, id: BytesN<32>) -> Result<(), Error> {
        let c = cfg(&env);
        let key = Key::Payment(id.clone());
        let mut p: Payment = env.storage().persistent().get(&key).ok_or(Error::UnknownPayment)?;
        if p.status != Status::Pending {
            return Err(Error::NotPending);
        }
        if paused(&env) {
            return Err(Error::Paused);
        }
        let now = env.ledger().timestamp();
        if now < p.release_at {
            return Err(Error::WindowOpen);
        }
        if !is_allowed(&env, &p.payee) {
            return Err(Error::NotAllowed);
        }
        if p.amount > c.per_payment_cap {
            return Err(Error::OverPaymentCap);
        }
        let (mut spends, spent) = recent_spends(&env);
        if spent + p.amount > c.daily_cap {
            return Err(Error::OverDailyCap);
        }
        // State first, then the transfer: if the transfer fails the whole invocation is rolled back.
        p.status = Status::Released;
        env.storage().persistent().set(&key, &p);
        env.storage().instance().set(&Key::Pending, &(pending_total(&env) - p.amount));
        spends.push_back(Spend { at: now, amount: p.amount });
        env.storage().instance().set(&Key::Spends, &spends);
        token::Client::new(&env, &c.token).transfer(&env.current_contract_address(), &p.payee, &p.amount);
        Released { id, payee: p.payee, amount: p.amount }.publish(&env);
        Ok(())
    }

    /// The owner cancels a proposed payment during (or after) its window, before release.
    pub fn cancel(env: Env, id: BytesN<32>) -> Result<(), Error> {
        let c = cfg(&env);
        c.owner.require_auth();
        let key = Key::Payment(id.clone());
        let mut p: Payment = env.storage().persistent().get(&key).ok_or(Error::UnknownPayment)?;
        if p.status != Status::Pending {
            return Err(Error::NotPending);
        }
        p.status = Status::Cancelled;
        env.storage().persistent().set(&key, &p);
        env.storage().instance().set(&Key::Pending, &(pending_total(&env) - p.amount));
        Cancelled { id }.publish(&env);
        Ok(())
    }

    /// Owner or agent can pause (the safe direction). Proposals and releases stop until the owner resumes.
    pub fn pause(env: Env, by: Address) -> Result<(), Error> {
        let c = cfg(&env);
        if by != c.owner && by != c.agent {
            return Err(Error::NotOwnerOrAgent);
        }
        by.require_auth();
        env.storage().instance().set(&Key::Paused, &true);
        PausedChanged { paused: true, by }.publish(&env);
        Ok(())
    }

    pub fn resume(env: Env) {
        let c = cfg(&env);
        c.owner.require_auth();
        env.storage().instance().set(&Key::Paused, &false);
        PausedChanged { paused: false, by: c.owner }.publish(&env);
    }

    /// Only the owner adds or removes payees, so a changed payout address needs the owner, not the agent.
    pub fn set_payee(env: Env, payee: Address, allowed: bool) {
        cfg(&env).owner.require_auth();
        if allowed {
            env.storage().persistent().set(&Key::Allowed(payee), &true);
        } else {
            env.storage().persistent().remove(&Key::Allowed(payee));
        }
    }

    pub fn set_limits(env: Env, per_payment_cap: i128, daily_cap: i128, cancel_window: u64) -> Result<(), Error> {
        let mut c = cfg(&env);
        c.owner.require_auth();
        check_limits(per_payment_cap, daily_cap)?;
        c.per_payment_cap = per_payment_cap;
        c.daily_cap = daily_cap;
        c.cancel_window = cancel_window;
        env.storage().instance().set(&Key::Config, &c);
        Ok(())
    }

    /// The owner can always take the money back. Checkrail never holds funds.
    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        let c = cfg(&env);
        c.owner.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        token::Client::new(&env, &c.token).transfer(&env.current_contract_address(), &to, &amount);
        Ok(())
    }

    pub fn config(env: Env) -> Config {
        cfg(&env)
    }

    pub fn payment(env: Env, id: BytesN<32>) -> Option<Payment> {
        env.storage().persistent().get(&Key::Payment(id))
    }

    pub fn spent_last_24h(env: Env) -> i128 {
        recent_spends(&env).1
    }

    pub fn scheduled_total(env: Env) -> i128 {
        pending_total(&env)
    }

    pub fn is_paused(env: Env) -> bool {
        paused(&env)
    }

    pub fn is_payee(env: Env, payee: Address) -> bool {
        is_allowed(&env, &payee)
    }
}

#[cfg(test)]
mod test;
