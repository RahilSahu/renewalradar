'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
      status: 'active',
      history: []
    },
    overrides || {}
  );
}

/* ---------------- history and v1 migration -------------------------------- */

test('validateItem defaults history to an empty array for v1-shaped items', () => {
  const r = Core.validateItem({ name: 'Old Sub', amount: 100, nextDate: '2026-06-20' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.history, []);
});

test('validateItem keeps history entries, most recent first, amounts rounded', () => {
  const r = Core.validateItem({
    name: 'Sub',
    amount: 100,
    nextDate: '2026-06-20',
    history: [
      { date: '2026-04-20', amount: 90 },
      { date: '2026-05-20', amount: '95.5' }
    ]
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.history, [
    { date: '2026-05-20', amount: 95.5 },
    { date: '2026-04-20', amount: 90 }
  ]);
});

test('validateItem rejects malformed history entries', () => {
  const badDate = Core.validateItem({
    name: 'Sub', amount: 100, nextDate: '2026-06-20',
    history: [{ date: '20-05-2026', amount: 10 }]
  });
  assert.equal(badDate.ok, false);
  assert.ok(badDate.errors.some((e) => /History entry 1/.test(e)));
  const badAmount = Core.validateItem({
    name: 'Sub', amount: 100, nextDate: '2026-06-20',
    history: [{ date: '2026-05-20', amount: -3 }]
  });
  assert.equal(badAmount.ok, false);
  const notArray = Core.validateItem({
    name: 'Sub', amount: 100, nextDate: '2026-06-20', history: 'lots'
  });
  assert.equal(notArray.ok, false);
});

test('validateImport loads a v1 export losslessly, history defaulted', () => {
  const v1 = {
    app: 'renewalradar',
    version: 1,
    items: [
      {
        id: 'it_old', name: 'Legacy', amount: 250, currency: 'USD', cycle: 'yearly',
        category: 'Finance', nextDate: '2026-12-01', paymentLabel: 'Visa',
        notes: 'from v1', status: 'paused'
      }
    ]
  };
  const r = Core.validateImport(v1);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, 'Legacy');
  assert.equal(r.items[0].amount, 250);
  assert.equal(r.items[0].status, 'paused');
  assert.deepEqual(r.items[0].history, []);
});

/* ---------------- mark as renewed ------------------------------------------ */

test('markRenewed records the payment and rolls to the first occurrence after today', () => {
  const it = item({ nextDate: '2026-06-10', amount: 649 });
  const r = Core.markRenewed(it, {}, TODAY);
  assert.equal(r.ok, true);
  assert.equal(r.item.nextDate, '2026-07-10');
  assert.deepEqual(r.item.history, [{ date: TODAY, amount: 649 }]);
  assert.equal(r.priceChanged, false);
});

test('markRenewed due exactly today rolls one full cycle', () => {
  const it = item({ nextDate: '2026-06-15', cycle: 'monthly' });
  const r = Core.markRenewed(it, {}, TODAY);
  assert.equal(r.item.nextDate, '2026-07-15');
});

test('markRenewed rolls a weekly item to the next week after today', () => {
  const it = item({ nextDate: '2026-06-01', cycle: 'weekly' });
  const r = Core.markRenewed(it, {}, TODAY);
  assert.equal(r.item.nextDate, '2026-06-22');
});

test('markRenewed flags a price change and updates the tracked amount', () => {
  const it = item({ nextDate: '2026-06-10', amount: 499 });
  const r = Core.markRenewed(it, { amount: 649 }, TODAY);
  assert.equal(r.ok, true);
  assert.equal(r.priceChanged, true);
  assert.equal(r.previousAmount, 499);
  assert.equal(r.item.amount, 649);
  assert.equal(r.item.history[0].amount, 649);
});

test('markRenewed prepends to existing history, most recent first', () => {
  const it = item({
    nextDate: '2026-06-10',
    history: [{ date: '2026-05-10', amount: 100 }]
  });
  const r = Core.markRenewed(it, {}, TODAY);
  assert.deepEqual(
    r.item.history.map((h) => h.date),
    ['2026-06-15', '2026-05-10']
  );
});

test('markRenewed keeps the date for one-time items but still records history', () => {
  const it = item({ cycle: 'one-time', nextDate: '2026-06-01' });
  const r = Core.markRenewed(it, {}, TODAY);
  assert.equal(r.ok, true);
  assert.equal(r.item.nextDate, '2026-06-01');
  assert.equal(r.item.history.length, 1);
});

test('markRenewed works when the item has no history field at all (v1 item)', () => {
  const it = item({ nextDate: '2026-06-10' });
  delete it.history;
  const r = Core.markRenewed(it, {}, TODAY);
  assert.equal(r.ok, true);
  assert.equal(r.item.history.length, 1);
});

test('markRenewed does not mutate the input item', () => {
  const it = item({ nextDate: '2026-06-10', amount: 100 });
  const snapshot = JSON.stringify(it);
  Core.markRenewed(it, { amount: 120 }, TODAY);
  assert.equal(JSON.stringify(it), snapshot);
});

test('markRenewed rejects a bad payment amount and a bad payment date', () => {
  const it = item({});
  assert.equal(Core.markRenewed(it, { amount: 0 }, TODAY).ok, false);
  assert.equal(Core.markRenewed(it, { amount: 'abc' }, TODAY).ok, false);
  assert.equal(Core.markRenewed(it, { date: '15/06/2026' }, TODAY).ok, false);
});

/* ---------------- CSV parsing ------------------------------------------------ */

test('parseCSV handles quoted fields with embedded commas and escaped quotes', () => {
  const rows = Core.parseCSV('a,"b,c","say ""hi""",d');
  assert.deepEqual(rows, [['a', 'b,c', 'say "hi"', 'd']]);
});

test('parseCSV handles CRLF line endings and quoted newlines', () => {
  const rows = Core.parseCSV('a,b\r\n"line1\nline2",c\r\nd,e\r\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['line1\nline2', 'c'],
    ['d', 'e']
  ]);
});

test('parseStatementDate reads the common bank export date shapes', () => {
  assert.equal(Core.parseStatementDate('01/09/2026'), '2026-09-01');
  assert.equal(Core.parseStatementDate('01-09-2026'), '2026-09-01');
  assert.equal(Core.parseStatementDate('2026-09-01'), '2026-09-01');
  assert.equal(Core.parseStatementDate('02 Jan 2026'), '2026-01-02');
  assert.equal(Core.parseStatementDate('02-Jan-2026'), '2026-01-02');
  assert.equal(Core.parseStatementDate('Jan 2, 2026'), '2026-01-02');
  assert.equal(Core.parseStatementDate('31/02/2026'), null);
  assert.equal(Core.parseStatementDate('not a date'), null);
});

test('parseStatementCSV reads an HDFC-style export (Narration, Withdrawal Amt.)', () => {
  const csv = fs.readFileSync(path.join(__dirname, 'fixtures', 'statement-hdfc.csv'), 'utf8');
  const r = Core.parseStatementCSV(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.rowsRead, 8);
  // 7 money-out rows: the salary deposit is excluded.
  assert.equal(r.rowsUsed, 7);
  const netflix = r.transactions.filter((t) => /NETFLIX/.test(t.description));
  assert.equal(netflix.length, 3);
  assert.ok(netflix.every((t) => t.amount === 649));
  assert.equal(netflix[0].date, '2026-09-01');
});

test('parseStatementCSV reads an SBI-style export (Txn Date, Description, Debit, Credit)', () => {
  const csv = [
    'Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance',
    '01 Sep 2026,01 Sep 2026,UPI/NETFLIX/111222,REF1,649.00,,5000.00',
    '02 Sep 2026,02 Sep 2026,INTEREST CREDIT,REF2,,25.00,5025.00'
  ].join('\n');
  const r = Core.parseStatementCSV(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.rowsUsed, 1);
  assert.equal(r.transactions[0].amount, 649);
  assert.equal(r.transactions[0].date, '2026-09-01');
});

test('parseStatementCSV reads an Amount column with a Dr/Cr type column', () => {
  const csv = [
    'Date,Description,Amount,Type',
    '2026-09-01,Spotify Premium,119.00,Dr',
    '2026-09-03,Refund from store,500.00,Cr',
    '2026-10-01,Spotify Premium,119.00,Dr'
  ].join('\n');
  const r = Core.parseStatementCSV(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.rowsUsed, 2);
  assert.ok(r.transactions.every((t) => t.amount === 119));
});

test('parseStatementCSV treats negative signed amounts as money out', () => {
  const csv = [
    'Date,Description,Amount',
    '2026-09-01,Gym membership,-1500.00',
    '2026-09-05,Salary,90000.00',
    '2026-10-01,Gym membership,-1500.00'
  ].join('\n');
  const r = Core.parseStatementCSV(csv);
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.rowsUsed, 2);
  assert.ok(r.transactions.every((t) => t.amount === 1500));
});

test('parseStatementCSV fails clearly on unrecognized headers', () => {
  const csv = 'Foo,Bar,Baz\n1,2,3\n';
  const r = Core.parseStatementCSV(csv);
  assert.equal(r.ok, false);
  assert.ok(/Supported formats/.test(r.error));
  assert.ok(/Debit/.test(r.error));
});

test('parseStatementCSV refuses to guess when Amount is all positive with no type column', () => {
  const csv = ['Date,Description,Amount', '2026-09-01,Something,100.00', '2026-09-02,Other,200.00'].join('\n');
  const r = Core.parseStatementCSV(csv);
  assert.equal(r.ok, false);
  assert.ok(/money out/.test(r.error));
});

/* ---------------- merchant normalization -------------------------------------- */

test('normalizeMerchant strips channels, reference numbers, and bank noise', () => {
  assert.equal(Core.normalizeMerchant('UPI/NETFLIX/123456789012/HDFC BANK'), 'NETFLIX');
  assert.equal(Core.normalizeMerchant('POS SPOTIFY 998877'), 'SPOTIFY');
  assert.equal(Core.normalizeMerchant('NEFT/AMAZON PAY INDIA/REF99'), 'AMAZON PAY');
  assert.equal(Core.normalizeMerchant('ACH/GOOGLE *SERVICES/123'), 'GOOGLE SERVICES');
  assert.equal(Core.normalizeMerchant('UPI/MUSICWAVE/777/UPI'), 'MUSICWAVE');
});

/* ---------------- cadence inference ------------------------------------------- */

test('inferCadence maps median gaps to cycles and rejects irregular gaps', () => {
  assert.equal(Core.inferCadence([7]), 'weekly');
  assert.equal(Core.inferCadence([30, 31]), 'monthly');
  assert.equal(Core.inferCadence([91]), 'quarterly');
  assert.equal(Core.inferCadence([182]), 'half-yearly');
  assert.equal(Core.inferCadence([365]), 'yearly');
  assert.equal(Core.inferCadence([19, 69]), null);
  assert.equal(Core.inferCadence([45]), null);
});

/* ---------------- recurring detection ------------------------------------------ */

test('detectRecurring finds Netflix and Spotify in the HDFC fixture end to end', () => {
  const csv = fs.readFileSync(path.join(__dirname, 'fixtures', 'statement-hdfc.csv'), 'utf8');
  const parsed = Core.parseStatementCSV(csv);
  const proposals = Core.detectRecurring(parsed.transactions, []);
  assert.deepEqual(
    proposals.map((p) => p.name),
    ['Netflix', 'Spotify']
  );
  const netflix = proposals[0];
  assert.equal(netflix.amount, 649);
  assert.equal(netflix.currency, 'INR');
  assert.equal(netflix.cycle, 'monthly');
  assert.equal(netflix.occurrences, 3);
  assert.equal(netflix.nextDate, '2026-12-01');
  assert.equal(netflix.alreadyTracked, false);
  const spotify = proposals[1];
  assert.equal(spotify.occurrences, 2);
  assert.equal(spotify.nextDate, '2026-12-10');
});

test('detectRecurring needs at least two charges on a recognizable cadence', () => {
  const single = [{ date: '2026-09-15', description: 'SWIGGY ORDER 4455', amount: 850 }];
  assert.deepEqual(Core.detectRecurring(single, []), []);
  const irregular = [
    { date: '2026-01-01', description: 'UPI/RANDOMSHOP/1', amount: 300 },
    { date: '2026-01-20', description: 'UPI/RANDOMSHOP/2', amount: 300 },
    { date: '2026-03-30', description: 'UPI/RANDOMSHOP/3', amount: 300 }
  ];
  assert.deepEqual(Core.detectRecurring(irregular, []), []);
});

test('detectRecurring clusters amounts within 2 percent and ignores outliers', () => {
  const txns = [
    { date: '2026-09-01', description: 'UPI/CLOUDDESK/1', amount: 649 },
    { date: '2026-10-01', description: 'UPI/CLOUDDESK/2', amount: 649 },
    { date: '2026-10-15', description: 'UPI/CLOUDDESK/3', amount: 5000 },
    { date: '2026-11-01', description: 'UPI/CLOUDDESK/4', amount: 655 }
  ];
  const proposals = Core.detectRecurring(txns, []);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].occurrences, 3);
  assert.equal(proposals[0].amount, 655); // amount of the most recent charge in the cluster
});

test('detectRecurring flags proposals that are already tracked', () => {
  const csv = fs.readFileSync(path.join(__dirname, 'fixtures', 'statement-hdfc.csv'), 'utf8');
  const parsed = Core.parseStatementCSV(csv);
  const proposals = Core.detectRecurring(parsed.transactions, [item({ name: 'Netflix' })]);
  const netflix = proposals.find((p) => p.name === 'Netflix');
  const spotify = proposals.find((p) => p.name === 'Spotify');
  assert.equal(netflix.alreadyTracked, true);
  assert.equal(spotify.alreadyTracked, false);
});

test('detectRecurring infers a yearly cadence from annual charges', () => {
  const txns = [
    { date: '2024-03-10', description: 'INSURANCE PREMIUM SAFELIFE', amount: 18500 },
    { date: '2025-03-10', description: 'INSURANCE PREMIUM SAFELIFE', amount: 18500 },
    { date: '2026-03-12', description: 'INSURANCE PREMIUM SAFELIFE', amount: 18500 }
  ];
  const proposals = Core.detectRecurring(txns, []);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].cycle, 'yearly');
  assert.equal(proposals[0].nextDate, '2027-03-12');
});

/* ---------------- calendar export (.ics) ---------------------------------------- */

test('generateICS emits one event per active item with the right RRULE per cycle', () => {
  const items = [
    item({ id: 'w', cycle: 'weekly', nextDate: '2026-06-20' }),
    item({ id: 'm', cycle: 'monthly', nextDate: '2026-06-20' }),
    item({ id: 'q', cycle: 'quarterly', nextDate: '2026-06-20' }),
    item({ id: 'h', cycle: 'half-yearly', nextDate: '2026-06-20' }),
    item({ id: 'y', cycle: 'yearly', nextDate: '2026-06-20' }),
    item({ id: 'o', cycle: 'one-time', nextDate: '2026-06-20' }),
    item({ id: 'p', cycle: 'monthly', nextDate: '2026-06-20', status: 'paused' })
  ];
  const ics = Core.generateICS(items, TODAY, new Date(Date.UTC(2026, 5, 15, 10, 0, 0)));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 6); // paused item excluded
  assert.ok(ics.includes('RRULE:FREQ=WEEKLY'));
  assert.ok(ics.includes('RRULE:FREQ=MONTHLY\r\n'));
  assert.ok(ics.includes('RRULE:FREQ=MONTHLY;INTERVAL=3'));
  assert.ok(ics.includes('RRULE:FREQ=MONTHLY;INTERVAL=6'));
  assert.ok(ics.includes('RRULE:FREQ=YEARLY'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260620'));
  assert.ok(ics.includes('DTSTAMP:20260615T100000Z'));
});

test('generateICS gives one-time items no RRULE and every event a 3 day alarm', () => {
  const items = [item({ id: 'o', cycle: 'one-time', nextDate: '2026-06-20' })];
  const ics = Core.generateICS(items, TODAY, new Date(Date.UTC(2026, 5, 15)));
  assert.ok(!ics.includes('RRULE'));
  assert.ok(ics.includes('BEGIN:VALARM'));
  assert.ok(ics.includes('TRIGGER:-P3D'));
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
});

test('generateICS escapes commas and semicolons in item names', () => {
  const items = [item({ id: 'x', name: 'Rent, Office; Floor 2', nextDate: '2026-06-20' })];
  const ics = Core.generateICS(items, TODAY, new Date(Date.UTC(2026, 5, 15)));
  assert.ok(ics.includes('Rent\\, Office\\; Floor 2'));
});

/* ---------------- catalog and colors ---------------------------------------------- */

test('quick-add catalog covers the common services and every preset validates', () => {
  const names = Core.QUICK_ADD.map((q) => q.name);
  for (const expected of [
    'Netflix', 'Spotify', 'YouTube Premium', 'Amazon Prime', 'Disney+ Hotstar',
    'iCloud+', 'Google One', 'ChatGPT Plus', 'Microsoft 365',
    'Adobe Creative Cloud', 'Notion', 'House Rent', 'Gym'
  ]) {
    assert.ok(names.includes(expected), 'missing preset: ' + expected);
  }
  assert.ok(names.some((n) => /^GitHub/.test(n)), 'missing GitHub preset');
  Core.QUICK_ADD.forEach((q) => {
    const r = Core.validateItem({
      name: q.name, amount: q.amount, currency: q.currency,
      cycle: q.cycle, category: q.category, nextDate: '2026-06-20'
    });
    assert.equal(r.ok, true, q.name + ': ' + r.errors.join('; '));
  });
});

test('categoryColor gives every category a color and falls back for unknown ones', () => {
  const colors = Core.CATEGORIES.map((c) => Core.categoryColor(c));
  assert.ok(colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
  assert.equal(new Set(colors).size, Core.CATEGORIES.length);
  assert.equal(Core.categoryColor('Nonsense'), Core.CATEGORY_COLORS.Other);
});
