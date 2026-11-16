'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

const TODAY = '2026-06-15';

function item(overrides) {
  return Object.assign(
    {
      id: 'it_test',
      name: 'Test Sub',
      amount: 100,
      currency: 'INR',
      cycle: 'monthly',
      category: 'Other',
      nextDate: '2026-06-20',
      paymentLabel: '',
      notes: '',
      status: 'active'
    },
    overrides || {}
  );
}

/* ---------------- cycle stepping and month-end clamping ---------------- */

test('monthly step from Jan 31 clamps to Feb 28 in a non-leap year', () => {
  assert.equal(Core.addCycle('2026-01-31', 'monthly', 1), '2026-02-28');
});

test('monthly step from Jan 31 clamps to Feb 29 in a leap year', () => {
  assert.equal(Core.addCycle('2024-01-31', 'monthly', 1), '2024-02-29');
});

test('multi-step monthly from Jan 31 lands back on Mar 31, not Mar 28', () => {
  assert.equal(Core.addCycle('2026-01-31', 'monthly', 2), '2026-03-31');
});

test('yearly step from Feb 29 clamps to Feb 28 in a non-leap year', () => {
  assert.equal(Core.addCycle('2024-02-29', 'yearly', 1), '2025-02-28');
});

test('yearly step from Feb 29 lands on Feb 29 again four years later', () => {
  assert.equal(Core.addCycle('2024-02-29', 'yearly', 4), '2028-02-29');
});

test('quarterly step clamps Aug 31 to Nov 30', () => {
  assert.equal(Core.addCycle('2026-08-31', 'quarterly', 1), '2026-11-30');
});

test('half-yearly step from Jan 31 lands on Jul 31', () => {
  assert.equal(Core.addCycle('2026-01-31', 'half-yearly', 1), '2026-07-31');
});

test('weekly step adds seven days across a month boundary', () => {
  assert.equal(Core.addCycle('2026-06-29', 'weekly', 1), '2026-07-06');
});

test('one-time cycle never moves the date', () => {
  assert.equal(Core.addCycle('2026-06-20', 'one-time', 5), '2026-06-20');
});

test('addCycle rejects an unknown cycle', () => {
  assert.throws(() => Core.addCycle('2026-06-20', 'daily', 1), /Unknown cycle/);
});

/* ---------------- normalization ----------------------------------------- */

test('monthly normalization factors per cycle', () => {
  assert.equal(Core.monthlyAmount(item({ amount: 120, cycle: 'weekly' })), 520); // 120 * 52 / 12
  assert.equal(Core.monthlyAmount(item({ amount: 100, cycle: 'monthly' })), 100);
  assert.equal(Core.monthlyAmount(item({ amount: 900, cycle: 'quarterly' })), 300);
  assert.equal(Core.monthlyAmount(item({ amount: 1200, cycle: 'half-yearly' })), 200);
  assert.equal(Core.monthlyAmount(item({ amount: 1200, cycle: 'yearly' })), 100);
  assert.equal(Core.monthlyAmount(item({ amount: 1200, cycle: 'one-time' })), 0);
});

test('yearly normalization factors per cycle', () => {
  assert.equal(Core.yearlyAmount(item({ amount: 10, cycle: 'weekly' })), 520);
  assert.equal(Core.yearlyAmount(item({ amount: 100, cycle: 'quarterly' })), 400);
  assert.equal(Core.yearlyAmount(item({ amount: 500, cycle: 'one-time' })), 0);
});

/* ---------------- effective next and occurrences ------------------------- */

test('effectiveNext returns the stored date when it is today or later', () => {
  assert.equal(Core.effectiveNext(item({ nextDate: '2026-06-15' }), TODAY), '2026-06-15');
  assert.equal(Core.effectiveNext(item({ nextDate: '2026-06-20' }), TODAY), '2026-06-20');
});

test('effectiveNext rolls a monthly item forward past today', () => {
  // Occurrences: Jan 15, Feb 15, ..., Jun 15 (== today, kept), so Jun 15.
  assert.equal(Core.effectiveNext(item({ nextDate: '2026-01-15' }), TODAY), '2026-06-15');
  // Jun 14 is before today, so the next is Jul 14.
  assert.equal(Core.effectiveNext(item({ nextDate: '2026-01-14' }), TODAY), '2026-07-14');
});

test('effectiveNext preserves the anchor day after clamping (Jan 31)', () => {
  // Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31 -> Jun 30.
  assert.equal(Core.effectiveNext(item({ nextDate: '2026-01-31' }), TODAY), '2026-06-30');
});

test('effectiveNext rolls a weekly item forward by whole weeks', () => {
  // Jun 1 + 7 = Jun 8, + 14 = Jun 15 (today).
  assert.equal(
    Core.effectiveNext(item({ cycle: 'weekly', nextDate: '2026-06-01' }), TODAY),
    '2026-06-15'
  );
});

test('effectiveNext keeps a past one-time date in the past (overdue)', () => {
  assert.equal(
    Core.effectiveNext(item({ cycle: 'one-time', nextDate: '2026-06-01' }), TODAY),
    '2026-06-01'
  );
});

test('occurrencesBetween generates the weekly charges inside a 30 day window', () => {
  const dates = Core.occurrencesBetween(
    item({ cycle: 'weekly', nextDate: '2026-06-15' }),
    '2026-06-15',
    '2026-07-15'
  );
  assert.deepEqual(dates, ['2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13']);
});

test('occurrencesBetween generates three monthly charges in 90 days', () => {
  const dates = Core.occurrencesBetween(
    item({ cycle: 'monthly', nextDate: '2026-06-20' }),
    '2026-06-15',
    '2026-09-14'
  );
  assert.deepEqual(dates, ['2026-06-20', '2026-07-20', '2026-08-20']);
});

test('occurrencesBetween includes a one-time item only inside the window', () => {
  const inside = Core.occurrencesBetween(
    item({ cycle: 'one-time', nextDate: '2026-07-01' }),
    '2026-06-15',
    '2026-09-14'
  );
  assert.deepEqual(inside, ['2026-07-01']);
  const outside = Core.occurrencesBetween(
    item({ cycle: 'one-time', nextDate: '2026-12-01' }),
    '2026-06-15',
    '2026-09-14'
  );
  assert.deepEqual(outside, []);
});

/* ---------------- totals -------------------------------------------------- */

test('computeTotals groups by currency and never mixes them', () => {
  const items = [
    item({ id: 'a', amount: 100, currency: 'INR', cycle: 'monthly', nextDate: '2026-06-20' }),
    item({ id: 'b', amount: 1200, currency: 'INR', cycle: 'yearly', nextDate: '2026-07-01' }),
    item({ id: 'c', amount: 10, currency: 'USD', cycle: 'monthly', nextDate: '2026-06-16' })
  ];
  const t = Core.computeTotals(items, TODAY);
  assert.equal(t.activeCount, 3);
  assert.equal(t.byCurrency.INR.monthly, 200); // 100 + 1200 / 12
  assert.equal(t.byCurrency.INR.yearly, 2400); // 1200 + 1200
  assert.equal(t.byCurrency.USD.monthly, 10);
  assert.equal(t.byCurrency.USD.yearly, 120);
  assert.equal(t.byCurrency.EUR, undefined);
});

test('computeTotals excludes paused items from totals and the active count', () => {
  const items = [
    item({ id: 'a', amount: 100, status: 'active' }),
    item({ id: 'b', amount: 999, status: 'paused' })
  ];
  const t = Core.computeTotals(items, TODAY);
  assert.equal(t.activeCount, 1);
  assert.equal(t.byCurrency.INR.monthly, 100);
});

test('computeTotals keeps one-time items out of burn but counts them in due30', () => {
  const items = [
    item({ id: 'a', amount: 500, cycle: 'one-time', nextDate: '2026-06-25' }),
    item({ id: 'b', amount: 500, cycle: 'one-time', nextDate: '2026-09-01' })
  ];
  const t = Core.computeTotals(items, TODAY);
  assert.equal(t.byCurrency.INR.monthly, 0);
  assert.equal(t.byCurrency.INR.yearly, 0);
  assert.equal(t.byCurrency.INR.due30, 500); // only the Jun 25 charge is within 30 days
});

test('computeTotals due30 sums every projected charge, including weekly repeats', () => {
  const items = [item({ id: 'a', amount: 10, cycle: 'weekly', nextDate: '2026-06-15' })];
  const t = Core.computeTotals(items, TODAY);
  // Charges land on Jun 15, 22, 29, Jul 6, and Jul 13 inside the window
  // (today through today + 30 days): 5 charges of 10.
  assert.equal(t.byCurrency.INR.due30, 50);
});

/* ---------------- days left and badges ------------------------------------- */

test('daysLeft handles future, today, and past dates', () => {
  assert.equal(Core.daysLeft('2026-06-20', TODAY), 5);
  assert.equal(Core.daysLeft('2026-06-15', TODAY), 0);
  assert.equal(Core.daysLeft('2026-06-10', TODAY), -5);
});

test('badgeFor boundaries: negative overdue, 0 to 7 soon, 8 plus upcoming', () => {
  assert.equal(Core.badgeFor(-1), 'overdue');
  assert.equal(Core.badgeFor(0), 'soon');
  assert.equal(Core.badgeFor(7), 'soon');
  assert.equal(Core.badgeFor(8), 'upcoming');
});

/* ---------------- lists ------------------------------------------------------ */

test('renewingSoon sorts overdue first, then by days left, and skips paused', () => {
  const items = [
    item({ id: 'later', nextDate: '2026-07-10' }),
    item({ id: 'overdue', cycle: 'one-time', nextDate: '2026-06-10' }),
    item({ id: 'soon', nextDate: '2026-06-18' }),
    item({ id: 'paused', nextDate: '2026-06-16', status: 'paused' })
  ];
  const soon = Core.renewingSoon(items, TODAY);
  assert.deepEqual(
    soon.map((s) => s.item.id),
    ['overdue', 'soon', 'later']
  );
  assert.equal(soon[0].badge, 'overdue');
  assert.equal(soon[0].daysLeft, -5);
});

test('upcomingCharges covers 90 days, sorts by date, and skips paused', () => {
  const items = [
    item({ id: 'a', name: 'Alpha', cycle: 'monthly', nextDate: '2026-06-20', amount: 50 }),
    item({ id: 'b', name: 'Beta', cycle: 'one-time', nextDate: '2026-10-01', amount: 70 }),
    item({ id: 'c', name: 'Gamma', cycle: 'monthly', nextDate: '2026-06-16', amount: 60, status: 'paused' })
  ];
  const charges = Core.upcomingCharges(items, TODAY);
  assert.deepEqual(
    charges.map((c) => c.date),
    ['2026-06-20', '2026-07-20', '2026-08-20']
  );
  assert.ok(charges.every((c) => c.name === 'Alpha'));
});

test('categoryBreakdown reports monthly shares per currency, largest first', () => {
  const items = [
    item({ id: 'a', amount: 300, category: 'Entertainment', currency: 'INR' }),
    item({ id: 'b', amount: 100, category: 'Utilities', currency: 'INR' }),
    item({ id: 'c', amount: 999, category: 'Utilities', currency: 'USD' }),
    item({ id: 'd', amount: 500, category: 'Health', currency: 'INR', cycle: 'one-time' })
  ];
  const rows = Core.categoryBreakdown(items, 'INR');
  assert.deepEqual(
    rows.map((r) => r.category),
    ['Entertainment', 'Utilities']
  );
  assert.equal(rows[0].share, 75);
  assert.equal(rows[1].share, 25);
});

test('filterItems matches query against name and payment label, and filters category', () => {
  const items = [
    item({ id: 'a', name: 'StreamFlix', category: 'Entertainment', paymentLabel: 'HDFC card' }),
    item({ id: 'b', name: 'GymFlex', category: 'Health', paymentLabel: 'UPI' })
  ];
  assert.deepEqual(
    Core.filterItems(items, { query: 'hdfc' }).map((i) => i.id),
    ['a']
  );
  assert.deepEqual(
    Core.filterItems(items, { category: 'Health' }).map((i) => i.id),
    ['b']
  );
  assert.equal(Core.filterItems(items, {}).length, 2);
});

/* ---------------- validation -------------------------------------------------- */

test('validateItem accepts a valid item and applies defaults', () => {
  const r = Core.validateItem({ name: 'StreamFlix', amount: '649', nextDate: '2026-06-20' });
  assert.equal(r.ok, true);
  assert.equal(r.value.amount, 649);
  assert.equal(r.value.currency, 'INR');
  assert.equal(r.value.cycle, 'monthly');
  assert.equal(r.value.category, 'Other');
  assert.equal(r.value.status, 'active');
  assert.ok(r.value.id);
});

test('validateItem rejects a missing name', () => {
  const r = Core.validateItem({ amount: 100, nextDate: '2026-06-20' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Name is required/.test(e)));
});

test('validateItem rejects zero, negative, and non-numeric amounts', () => {
  for (const amount of [0, -5, 'abc', NaN]) {
    const r = Core.validateItem({ name: 'X', amount, nextDate: '2026-06-20' });
    assert.equal(r.ok, false, 'amount should fail: ' + amount);
    assert.ok(r.errors.some((e) => /Amount/.test(e)));
  }
});

test('validateItem rejects an unknown currency and an unknown cycle', () => {
  const badCur = Core.validateItem({ name: 'X', amount: 1, currency: 'JPY', nextDate: '2026-06-20' });
  assert.equal(badCur.ok, false);
  assert.ok(badCur.errors.some((e) => /Currency/.test(e)));
  const badCycle = Core.validateItem({ name: 'X', amount: 1, cycle: 'daily', nextDate: '2026-06-20' });
  assert.equal(badCycle.ok, false);
  assert.ok(badCycle.errors.some((e) => /Cycle/.test(e)));
});

test('validateItem rejects impossible and malformed dates', () => {
  for (const nextDate of ['2026-02-30', '2026-13-01', '20-06-2026', 'not-a-date', '']) {
    const r = Core.validateItem({ name: 'X', amount: 1, nextDate });
    assert.equal(r.ok, false, 'date should fail: ' + nextDate);
  }
  assert.equal(Core.isValidDateStr('2024-02-29'), true);
  assert.equal(Core.isValidDateStr('2026-02-29'), false);
});

test('validateImport accepts an export-shaped payload and a bare array', () => {
  const good = { app: 'renewalradar', version: 1, items: [{ name: 'X', amount: 10, nextDate: '2026-06-20' }] };
  const r1 = Core.validateImport(good);
  assert.equal(r1.ok, true);
  assert.equal(r1.items.length, 1);
  const r2 = Core.validateImport([{ name: 'Y', amount: 5, nextDate: '2026-06-21' }]);
  assert.equal(r2.ok, true);
});

test('validateImport fails the whole file when one item is bad, naming its position', () => {
  const payload = {
    items: [
      { name: 'Good', amount: 10, nextDate: '2026-06-20' },
      { name: 'Bad', amount: -1, nextDate: '2026-06-20' }
    ]
  };
  const r = Core.validateImport(payload);
  assert.equal(r.ok, false);
  assert.equal(r.items.length, 0);
  assert.ok(r.errors.some((e) => /^Item 2: Amount/.test(e)));
});

test('validateImport rejects payloads that are not an array or an items object', () => {
  for (const bad of [null, 42, 'text', { items: 'nope' }, {}]) {
    const r = Core.validateImport(bad);
    assert.equal(r.ok, false, 'payload should fail: ' + JSON.stringify(bad));
  }
});

/* ---------------- demo data ----------------------------------------------------- */

test('demoItems returns 7 valid, active, fictional items dated in the future', () => {
  const demo = Core.demoItems(TODAY);
  assert.equal(demo.length, 7);
  demo.forEach((d) => {
    const r = Core.validateItem(d);
    assert.equal(r.ok, true, d.name);
    assert.equal(d.status, 'active');
    assert.ok(d.nextDate > TODAY, d.name + ' should be dated after today');
  });
});
