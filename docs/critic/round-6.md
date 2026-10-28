# Critic review round 6

# Checkrail Pay critic review, round 6

**Environment.** Everything passes. No project files were changed and `./data` was not created. The server was stopped by pid, child processes included.
- `npx vitest run`: 208 of 208 pass in 18 files.
- `npx tsc --noEmit` and `npm run build`: clean.
- Production server on port 3095 against a scratch database:
  - Every page returns 200, unknown ids return 404, the webhook returns 404 in mock mode, and the tick endpoint answers POST with 200 (GET gets 405).
  - Headless Chromium ran the demo flow with no console or page errors: pay Maria 0921; approve Ana (toast "Approved and ready to pay.", no refusal), then Pay with PayPal; upload Rosa's invoice with "Invoice attached from Rosa, please pay." (clean, ready to pay, no Concerns); Autopilot on (countdown 9:58 and Cancel showed); Daily close sign-off.
- Harnesses and output are in `/tmp/claude-0/-home-claude/11b88efa-03f4-5292-ba70-6074dd94746e/scratchpad/r6/` (`h1.ts` is the round-5 attack set re-run, plus `h2.ts`, `h3.ts`, `judge.py`, `refuse.py` and `mob.py`).

## Round-5 follow-ups that do not hold

None.
1. **File names.** A guesthouse bill saved as `Phuong Transport.pdf` is now labelled "Invoice (uploaded, no reference)". It warns "None of the attached records name Phuong Transport" and is held, the same as under a neutral file name. Claude's document reader is no longer given the file name. The agent's `read_evidence` tool still sees it, but binding never reads it.
2. **Approval refusal.**
   - In the engine: Kalaw bills JOB-PAL3D-0927 after Ana's page was evaluated. The first approve is refused with the Kalaw warning. The second approve succeeds and records `reference_other_vendor|<kalaw>:open`.
   - In the browser: the refusal toast shows and the refreshed page lists the Kalaw warning. Approving again works.
   - There is no spurious refusal in the normal flow, in either order (Ana approved before or after Maria is paid). No loop.
3. **Open/committed fingerprint.** Ana is approved while Bayan's payment on the same reference is open. Bayan is then paid. Ana's payment is refused with "New since approval: … (settled)". After a re-approve it pays.
   - Approving after Bayan was already paid needs no second look.
   - On Autopilot, a clean payment is refused at release once another payee bills its reference, and it goes back to a person.
4. **`request_names_vendor`.**
   - It fires on none of the 37 seeded obligations (with extras on), and not on the hosted demo story.
   - The four demo PDFs with the documented covering lines give approved, approved, awaiting approval (cap) and blocked, on Assist and on Autopilot. Autopilot sent only Maria 0921, Rosa and Maria's trip sheet.
   - These requests all count as naming the payee: "Rosa's", "Ms. Villanueva", lower case, the vendor's email, Vietnamese "anh Phương".
   - "Pay our Cebu guide" and "Invoice attached, please pay." warn, as intended. The /demo page and the demo-documents README describe this correctly.
5. **Mobile.** No horizontal overflow at 390px on any of the 38 page loads I checked:
   - all top-level pages, the not-found page and the four story obligations plus Rosa;
   - every vendor page;
   - an element-level scan that skips scroll containers.

## Must fix

None. Nothing I tried moves money wrongly or would embarrass the entry on the hosted mock demo.

## Should fix

1. **Two payees on one reference can bounce each other forever if both are approved before either is paid.**
   - **Case:** approve Ana, approve Bayan, pay Ana, pay Bayan. Ana is refused because Bayan is now committed, and she drops back to awaiting approval. That flips her fingerprint to "open", so Bayan's approval (given over "Ana: committed") is refused too.
   - Repeating the same order loops: I ran three cycles and both were refused every time. It ends only if the person pays right after re-approving.
   - No money moves wrongly. It only bites in an anomaly case, but it reads as a broken loop.
   - **Fix:** treat an acknowledged `X:committed` as covering `X:open`. Only open to committed is new information.

## Nice to have

- **README count.** README:20 still says "fifteen checks", and its list leaves out "the request names the payee". There are now sixteen rule ids.
- **"What the page showed" is the last `policy.evaluated` entry, not what this viewer saw.**
  - The refused approval itself, a first approver's run (with dual approval) or an execute refusal moves that baseline forward.
  - So a second tab, or a second approver whose page was loaded earlier, can approve over a warning they never saw.
  - This is negligible for a single-operator demo. Having the page send the fingerprints it rendered would close it.
- **Refused approvals are not audited.** A refused approve attempt writes only a `policy.evaluated` entry, with no record of who tried. An `approval.refused` entry would make the trail complete.
- **No direct unit test of `request_names_vendor`.** It is covered only through the F3 and F4 payee tests. A policy-level test (named in full, by part of the name, not named) would pin it.
- **Known gap still behaves as documented.** N2, N3 and N4 still clear and are sent by autopilot when the request names the payee: binding checks the name, not the role. The README now states this.

SATISFIED


---

## What was done about round 6 (16 Oct)

Round 6 was SATISFIED. Applied anyway:

- Two payees approved on one reference no longer void each other: an acknowledged "other payment committed" covers the same payment now "open" (`fingerprintCovered` in src/lib/domain/types.ts). Test: approve Ana, approve Bayan, pay both over three rounds; both are paid with at most two fresh looks.
- The obligation page sends the warning fingerprints it rendered with Approve, so an approval is checked against what that viewer saw, not the last evaluation on record (second tab, second approver).
- A refused approval is audited as `approval.refused` with the actor and the unseen warnings.
- Direct policy tests for `request_names_vendor`.
- README says sixteen checks and lists the request rule; counts are 213 tests in 18 files.

The loop ends here: rounds 5 and 6 both returned SATISFIED with no Must-fix, and every Should-fix from both is applied and tested.
