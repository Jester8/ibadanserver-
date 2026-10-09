// server/scripts/rules.test.ts: npm test. The same numbers as the client's scripts/test-rules.ts, so the two copies of the rules cannot drift apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL_SPAWNS, MIN, POLICE_REASONS, REASONS, STATE, STATE_KINDS, bailFor, fineFor, holdMsFor, stateName } from "../../src/lib/custodyRules";
import { EFCC_HOURS, POKE, efccFilingOpen } from "../../src/lib/socialRules";
import { LOAN, accrue, applyPayment, collateralOf, creditLimit, loanAmounts, newLoan, owedAfter, owedNow, paidValue, repEarned, saleValue, titleIndexOf } from "../../src/lib/moneyRules";
import type { PlotState } from "../../src/lib/protocol";

const mk = (o: Partial<PlotState>): PlotState => ({ ownerId: "me", ownerName: "Me", tier: 0, collectedAt: 0, ...o });

test("shared rules give the numbers in the plan", () => {
// police and EFCC numbers (justice.md) and the new reason
  assert.equal(bailFor("disturbance", 0), 5_000);
  assert.equal(bailFor("disturbance", 2), 10_000);
  assert.equal(bailFor("disturbance", 5), 15_000);
  assert.equal(bailFor("scam", 0, 40_000), 29_000);
  assert.equal(bailFor("fraud", 4, 400_000), 150_000);
  assert.equal(holdMsFor("disturbance", 3), 15 * MIN);
  assert.equal(bailFor("assault", 0), 7_500);
  assert.equal(bailFor("assault", 1), 11_500);
  assert.equal(bailFor("assault", 2), 15_000);
  assert.equal(holdMsFor("assault", 0), 10 * MIN);
  assert.equal(holdMsFor("assault", 4), 15 * MIN);
  assert.equal(fineFor("assault"), 3_750);
  assert.equal(fineFor("scam"), 0);
  assert.equal(REASONS.assault.fee, 1_500);
  assert.ok(CELL_SPAWNS.length >= 3);
  assert.deepEqual(POLICE_REASONS, ["loitering", "disturbance", "assault", "harassment"]);
  assert.ok(POKE.range > POKE.nearUi);
  assert.equal(stateName(STATE.bank), "Omo'badan Bank");
  assert.ok(STATE_KINDS.includes("landsale"));
  

  // EFCC office hours: files 08:00 to 16:50 Ibadan time (WAT = UTC+1)
  const wat = (h: number, m = 0) => Date.UTC(2026, 9, 8, h - 1, m);
  assert.equal(efccFilingOpen(wat(7, 59)), false);
  assert.equal(efccFilingOpen(wat(8)), true);
  assert.equal(efccFilingOpen(wat(16, 49)), true);
  assert.equal(efccFilingOpen(wat(16, 50)), false);
  assert.equal(EFCC_HOURS.close, 17);
  // loans: the worked example (₦50,000, 3 hours)
  const N = 50_000;
  assert.equal(owedAfter(N, 180, 0), 50_000);
  assert.equal(owedAfter(N, 180, 60), 53_000);
  assert.equal(owedAfter(N, 180, 180), 59_000);
  assert.equal(owedAfter(N, 180, 181), 61_600);
  assert.equal(owedAfter(N, 180, 240), 67_500);
  assert.equal(owedAfter(N, 180, 100_000), 100_000);
  assert.equal(owedAfter(N, 60, 60), 53_000);
  assert.equal(owedAfter(N, 360, 360), 68_000);
  const l0 = newLoan(N, 180, 0);
  const p1 = applyPayment(l0, 20_000, 60 * MIN);
  assert.equal(p1.paid, 20_000);
  assert.equal(p1.loan.interest, 0);
  assert.equal(p1.loan.left, 33_000);
  assert.equal(owedNow(p1.loan, 120 * MIN), 33_000 + 1_980);
  const p2 = applyPayment(p1.loan, 1_000_000, 120 * MIN);
  assert.equal(p2.paid, 34_980);
  assert.ok(p2.closed);
  assert.deepEqual(accrue(accrue(l0, 30 * MIN), 90 * MIN), accrue(l0, 90 * MIN));
  assert.equal(accrue(l0, 180 * MIN).lateFee, false);
  assert.equal(accrue(l0, 181 * MIN).lateFee, true);
  assert.equal(applyPayment(l0, 1, 90 * MIN).loan.at, 90 * MIN);
  assert.equal(newLoan(N, 180, 30_000).at, MIN);        // the first minute is charged after a whole minute
  assert.equal(LOAN.seizeFloor, 2_000);
  
  // credit limits
  assert.equal(creditLimit(0, 0), 10_000);
  assert.equal(creditLimit(titleIndexOf(70), 0), 50_000);
  const bung: Record<string, PlotState> = { "bodija-estate-3": mk({ tier: 1 }) };
  assert.equal(paidValue("bodija-estate-3", bung["bodija-estate-3"]), 195_000);
  assert.equal(collateralOf(bung, "me"), 195_000);
  assert.equal(creditLimit(titleIndexOf(70), collateralOf(bung, "me")), 128_000);
  assert.equal(creditLimit(7, 10_000_000), 400_000);
  assert.deepEqual([0, 24, 25, 800].map(titleIndexOf), [0, 0, 1, 7]);
  assert.equal(loanAmounts(8_000).join(), "5000,6000,7000,8000");
  assert.equal(collateralOf({ x: { ...bung["bodija-estate-3"], seized: true } }, "me"), 0);
  
  // selling back to the city
  assert.deepEqual(saleValue("bodija-estate-9", mk({ tier: 3, decor: ["plant", "plant", "plant"] })), { land: 108_000, built: 127_500, decor: 4_500, gross: 240_000 });
  assert.equal(saleValue("moniya-2", mk({ tier: 1 })).gross, 31_500);
  assert.equal(saleValue("dugbe-1", mk({ tier: 1, biz: "mart" })).gross, 342_000);
  assert.equal(saleValue("nowhere-1", mk({})).gross, 0);
  assert.deepEqual([repEarned({ tier: 3 }), repEarned({ tier: 0 }), repEarned({ tier: 1, biz: "shop" })], [58, 10, 20]);
});
