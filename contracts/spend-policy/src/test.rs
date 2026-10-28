#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token::StellarAssetClient, token::TokenClient, BytesN, Env, String};

struct Setup<'a> {
    env: Env,
    owner: Address,
    agent: Address,
    guide: Address,
    stranger: Address,
    token: TokenClient<'a>,
    policy: SpendPolicyClient<'a>,
}

const USD: i128 = 10_000_000; // 7 decimals, like PYUSD and USDC on Stellar

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);
    let owner = Address::generate(&env);
    let agent = Address::generate(&env);
    let guide = Address::generate(&env);
    let stranger = Address::generate(&env);
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = TokenClient::new(&env, &sac.address());
    // USD 500 per payment, USD 2,000 a day, 10-minute cancel window: the app's autopilot defaults.
    let id = env.register(SpendPolicy, (&owner, &agent, &sac.address(), 500 * USD, 2_000 * USD, 600u64));
    let policy = SpendPolicyClient::new(&env, &id);
    StellarAssetClient::new(&env, &sac.address()).mint(&id, &(5_000 * USD));
    policy.set_payee(&guide, &true);
    Setup { env, owner, agent, guide, stranger, token, policy }
}

fn pid(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

fn memo(env: &Env, s: &str) -> String {
    String::from_str(env, s)
}

fn later(env: &Env, secs: u64) {
    let t = env.ledger().timestamp();
    env.ledger().set_timestamp(t + secs);
}

#[test]
fn pays_an_allowed_payee_after_the_window() {
    let s = setup();
    let at = s.policy.propose(&pid(&s.env, 1), &s.guide, &(180 * USD), &memo(&s.env, "JOB-HG4D-0921"));
    assert_eq!(at, 1_000_600);
    assert_eq!(s.policy.try_release(&pid(&s.env, 1)), Err(Ok(Error::WindowOpen)));
    later(&s.env, 600);
    s.policy.release(&pid(&s.env, 1));
    assert_eq!(s.token.balance(&s.guide), 180 * USD);
    assert_eq!(s.policy.spent_last_24h(), 180 * USD);
    assert_eq!(s.policy.scheduled_total(), 0);
    assert_eq!(s.policy.payment(&pid(&s.env, 1)).unwrap().status, Status::Released);
}

#[test]
fn only_the_agent_can_propose() {
    let s = setup();
    s.policy.propose(&pid(&s.env, 1), &s.guide, &(10 * USD), &memo(&s.env, "x"));
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.agent);
}

#[test]
fn refuses_strangers_caps_and_bad_amounts() {
    let s = setup();
    assert_eq!(s.policy.try_propose(&pid(&s.env, 1), &s.stranger, &(10 * USD), &memo(&s.env, "x")), Err(Ok(Error::NotAllowed)));
    assert_eq!(s.policy.try_propose(&pid(&s.env, 2), &s.guide, &(501 * USD), &memo(&s.env, "x")), Err(Ok(Error::OverPaymentCap)));
    assert_eq!(s.policy.try_propose(&pid(&s.env, 3), &s.guide, &0, &memo(&s.env, "x")), Err(Ok(Error::BadAmount)));
    assert_eq!(s.policy.try_propose(&pid(&s.env, 4), &s.guide, &(-5), &memo(&s.env, "x")), Err(Ok(Error::BadAmount)));
}

#[test]
fn an_id_pays_once() {
    let s = setup();
    s.policy.propose(&pid(&s.env, 7), &s.guide, &(100 * USD), &memo(&s.env, "x"));
    assert_eq!(s.policy.try_propose(&pid(&s.env, 7), &s.guide, &(100 * USD), &memo(&s.env, "x")), Err(Ok(Error::DuplicateId)));
    later(&s.env, 600);
    s.policy.release(&pid(&s.env, 7));
    assert_eq!(s.policy.try_release(&pid(&s.env, 7)), Err(Ok(Error::NotPending)));
    assert_eq!(s.token.balance(&s.guide), 100 * USD);
}

#[test]
fn scheduled_payments_count_against_the_daily_cap_and_it_rolls() {
    let s = setup();
    for n in 1..=4u8 {
        s.policy.propose(&pid(&s.env, n), &s.guide, &(500 * USD), &memo(&s.env, "x"));
    }
    // Four of USD 500 scheduled: the fifth would pass USD 2,000 even though nothing has been released yet.
    assert_eq!(s.policy.try_propose(&pid(&s.env, 5), &s.guide, &(1 * USD), &memo(&s.env, "x")), Err(Ok(Error::OverDailyCap)));
    later(&s.env, 600);
    for n in 1..=4u8 {
        s.policy.release(&pid(&s.env, n));
    }
    assert_eq!(s.policy.try_propose(&pid(&s.env, 6), &s.guide, &(1 * USD), &memo(&s.env, "x")), Err(Ok(Error::OverDailyCap)));
    // A day after the releases the window has rolled forward.
    later(&s.env, DAY);
    s.policy.propose(&pid(&s.env, 6), &s.guide, &(1 * USD), &memo(&s.env, "x"));
    assert_eq!(s.policy.spent_last_24h(), 0);
}

#[test]
fn the_owner_cancels_inside_the_window_and_nothing_moves() {
    let s = setup();
    s.policy.propose(&pid(&s.env, 1), &s.guide, &(300 * USD), &memo(&s.env, "x"));
    s.policy.cancel(&pid(&s.env, 1));
    assert_eq!(s.env.auths()[0].0, s.owner);
    later(&s.env, 600);
    assert_eq!(s.policy.try_release(&pid(&s.env, 1)), Err(Ok(Error::NotPending)));
    assert_eq!(s.token.balance(&s.guide), 0);
    assert_eq!(s.policy.scheduled_total(), 0);
}

#[test]
fn pause_stops_proposals_and_releases_and_only_the_owner_resumes() {
    let s = setup();
    s.policy.propose(&pid(&s.env, 1), &s.guide, &(50 * USD), &memo(&s.env, "x"));
    s.policy.pause(&s.agent); // the agent may pull the brake
    assert_eq!(s.policy.try_propose(&pid(&s.env, 2), &s.guide, &(50 * USD), &memo(&s.env, "x")), Err(Ok(Error::Paused)));
    later(&s.env, 600);
    assert_eq!(s.policy.try_release(&pid(&s.env, 1)), Err(Ok(Error::Paused)));
    assert_eq!(s.policy.try_pause(&s.stranger), Err(Ok(Error::NotOwnerOrAgent)));
    s.policy.resume();
    assert_eq!(s.env.auths()[0].0, s.owner);
    s.policy.release(&pid(&s.env, 1));
    assert_eq!(s.token.balance(&s.guide), 50 * USD);
}

#[test]
fn removing_a_payee_stops_a_payment_already_scheduled_to_them() {
    let s = setup();
    s.policy.propose(&pid(&s.env, 1), &s.guide, &(50 * USD), &memo(&s.env, "x"));
    s.policy.set_payee(&s.guide, &false);
    later(&s.env, 600);
    assert_eq!(s.policy.try_release(&pid(&s.env, 1)), Err(Ok(Error::NotAllowed)));
}

#[test]
fn a_lowered_cap_applies_at_release() {
    let s = setup();
    s.policy.propose(&pid(&s.env, 1), &s.guide, &(400 * USD), &memo(&s.env, "x"));
    s.policy.set_limits(&(300 * USD), &(1_000 * USD), &600);
    later(&s.env, 600);
    assert_eq!(s.policy.try_release(&pid(&s.env, 1)), Err(Ok(Error::OverPaymentCap)));
    assert_eq!(s.policy.try_set_limits(&(500 * USD), &(100 * USD), &600), Err(Ok(Error::BadLimits)));
}

#[test]
fn the_owner_can_always_withdraw() {
    let s = setup();
    s.policy.withdraw(&s.owner, &(5_000 * USD));
    assert_eq!(s.env.auths()[0].0, s.owner);
    assert_eq!(s.token.balance(&s.owner), 5_000 * USD);
}

#[test]
fn a_failed_transfer_leaves_the_payment_pending() {
    let s = setup();
    s.policy.withdraw(&s.owner, &(5_000 * USD)); // empty the account
    s.policy.propose(&pid(&s.env, 1), &s.guide, &(50 * USD), &memo(&s.env, "x"));
    later(&s.env, 600);
    assert!(s.policy.try_release(&pid(&s.env, 1)).is_err());
    assert_eq!(s.policy.payment(&pid(&s.env, 1)).unwrap().status, Status::Pending);
    assert_eq!(s.policy.scheduled_total(), 50 * USD);
}
