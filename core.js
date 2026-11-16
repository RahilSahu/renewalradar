/*
 * RenewalRadar core logic.
 *
 * Pure functions for date and cycle math, renewal projections, totals
 * grouped by currency, and input validation. No DOM, no storage, no
 * network. Works in the browser as window.RenewalCore and in Node via
 * module.exports, so the exact code the UI runs is the code the tests
 * exercise.
 */
(function (global) {
  'use strict';

  var CYCLES = ['weekly', 'monthly', 'quarterly', 'half-yearly', 'yearly', 'one-time'];
  var CURRENCIES = ['INR', 'USD', 'EUR', 'GBP'];
  var CATEGORIES = [
    'Entertainment',
    'SaaS and Apps',
    'Utilities',
    'Insurance',
    'Finance',
    'Health',
    'Education',
    'Other'
  ];
  var STATUSES = ['active', 'paused'];
  var STORAGE_KEY = 'renewalradar.items.v1';

  // How many times a cycle fires per year. One-time items never add to
  // recurring burn, so their factor is 0.
  var PER_YEAR = {
    weekly: 52,
    monthly: 12,
    quarterly: 4,
    'half-yearly': 2,
    yearly: 1,
    'one-time': 0
  };
  var CYCLE_MONTHS = { monthly: 1, quarterly: 3, 'half-yearly': 6, yearly: 12 };

  /* ---------------- dates (all math in UTC, dates are YYYY-MM-DD) -------- */

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function parseDate(str) {
    if (typeof str !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
    if (!m) return null;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var da = Number(m[3]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    var d = new Date(Date.UTC(y, mo - 1, da));
    // Reject overflow dates such as 2026-02-30, which Date.UTC rolls over.
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
      return null;
    }
    return d;
  }

  function isValidDateStr(str) {
    return parseDate(str) !== null;
  }

  function formatDate(d) {
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function todayStr(now) {
    var d = now instanceof Date ? now : new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function addDays(dateStr, days) {
    var d = parseDate(dateStr);
    if (!d) throw new Error('Invalid date: ' + dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return formatDate(d);
  }

  function daysInMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }

  // Add whole months, clamping the day to the target month's length.
  // Jan 31 + 1 month is Feb 28 (or Feb 29 in a leap year), never Mar 2 or 3.
  function addMonthsClamped(dateStr, months) {
    var d = parseDate(dateStr);
    if (!d) throw new Error('Invalid date: ' + dateStr);
    var day = d.getUTCDate();
    var total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
    var y = Math.floor(total / 12);
    var mo = total - y * 12;
    var clampedDay = Math.min(day, daysInMonth(y, mo));
    return formatDate(new Date(Date.UTC(y, mo, clampedDay)));
  }

  // Move a date forward by `steps` occurrences of a cycle. Month-based
  // cycles are always computed from the given anchor date, so a monthly
  // item anchored on Jan 31 lands on Feb 28 and then Mar 31, not Mar 28.
  function addCycle(dateStr, cycle, steps) {
    var n = steps == null ? 1 : steps;
    if (!parseDate(dateStr)) throw new Error('Invalid date: ' + dateStr);
    if (cycle === 'weekly') return addDays(dateStr, 7 * n);
    if (cycle === 'one-time') return dateStr;
    if (Object.prototype.hasOwnProperty.call(CYCLE_MONTHS, cycle)) {
      return addMonthsClamped(dateStr, CYCLE_MONTHS[cycle] * n);
    }
    throw new Error('Unknown cycle: ' + cycle);
  }

  function daysLeft(dateStr, today) {
    var a = parseDate(dateStr);
    var b = parseDate(today);
    if (!a || !b) throw new Error('Invalid date');
    return Math.round((a.getTime() - b.getTime()) / 86400000);
  }

  /* ---------------- renewal projection ---------------------------------- */

  // First occurrence of a recurring item on or after `dateStr`, together
  // with how many cycle steps from the stored anchor that is.
  function firstOnOrAfter(item, dateStr) {
    var anchor = item.nextDate;
    if (anchor >= dateStr) return { date: anchor, steps: 0 };
    var k = 1;
    var cur = addCycle(anchor, item.cycle, k);
    while (cur < dateStr && k < 100000) {
      k += 1;
      cur = addCycle(anchor, item.cycle, k);
    }
    return { date: cur, steps: k };
  }

  // The date this item next charges on, relative to `today`. Recurring
  // items roll forward to the first occurrence on or after today. A
  // one-time item keeps its stored date, even if it is in the past (that
  // is what makes it overdue).
  function effectiveNext(item, today) {
    if (item.cycle === 'one-time') return item.nextDate;
    return firstOnOrAfter(item, today).date;
  }

  // All charge dates in the half-open window [startStr, endStr).
  function occurrencesBetween(item, startStr, endStr) {
    if (item.cycle === 'one-time') {
      return item.nextDate >= startStr && item.nextDate < endStr ? [item.nextDate] : [];
    }
    var first = firstOnOrAfter(item, startStr);
    var out = [];
    var date = first.date;
    var k = first.steps;
    while (date < endStr && out.length <= 10000) {
      out.push(date);
      k += 1;
      date = addCycle(item.nextDate, item.cycle, k);
    }
    return out;
  }

  /* ---------------- money ------------------------------------------------ */

  // Recurring cost normalized to one month. One-time items return 0:
  // they are a single charge, not a burn rate.
  function monthlyAmount(item) {
    var perYear = PER_YEAR[item.cycle] || 0;
    return ((Number(item.amount) || 0) * perYear) / 12;
  }

  function yearlyAmount(item) {
    var perYear = PER_YEAR[item.cycle] || 0;
    return (Number(item.amount) || 0) * perYear;
  }

  function emptyBucket() {
    return { monthly: 0, yearly: 0, due30: 0 };
  }

  // Totals for active items only, always grouped per currency. Currencies
  // are never summed together. due30 is the sum of the actual charges
  // projected to land in the window from today through today + 30 days
  // (inclusive), including one-time items due in that window.
  function computeTotals(items, today) {
    var byCurrency = {};
    var activeCount = 0;
    var end30 = addDays(today, 31); // exclusive end, so today + 30 is included
    items.forEach(function (item) {
      if (item.status !== 'active') return;
      activeCount += 1;
      var bucket = byCurrency[item.currency] || (byCurrency[item.currency] = emptyBucket());
      bucket.monthly += monthlyAmount(item);
      bucket.yearly += yearlyAmount(item);
      var due = occurrencesBetween(item, today, end30).length * (Number(item.amount) || 0);
      bucket.due30 += due;
    });
    return { byCurrency: byCurrency, activeCount: activeCount };
  }

  // Monthly spend per category for one currency, largest first, with each
  // category's share of that currency's monthly total as a percentage.
  function categoryBreakdown(items, currency) {
    var totals = {};
    var grand = 0;
    items.forEach(function (item) {
      if (item.status !== 'active' || item.currency !== currency) return;
      var m = monthlyAmount(item);
      if (m <= 0) return;
      totals[item.category] = (totals[item.category] || 0) + m;
      grand += m;
    });
    return Object.keys(totals)
      .map(function (cat) {
        return {
          category: cat,
          monthly: totals[cat],
          share: grand > 0 ? (totals[cat] / grand) * 100 : 0
        };
      })
      .sort(function (a, b) {
        return b.monthly - a.monthly;
      });
  }

  /* ---------------- lists -------------------------------------------------- */

  function badgeFor(days) {
    if (days < 0) return 'overdue';
    if (days <= 7) return 'soon';
    return 'upcoming';
  }

  // Active items with their effective next charge, most urgent first.
  // Overdue one-time items (negative days left) sort to the top.
  function renewingSoon(items, today) {
    return items
      .filter(function (item) {
        return item.status === 'active';
      })
      .map(function (item) {
        var date = effectiveNext(item, today);
        var left = daysLeft(date, today);
        return { item: item, date: date, daysLeft: left, badge: badgeFor(left) };
      })
      .sort(function (a, b) {
        if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
        return b.item.amount - a.item.amount;
      });
  }

  // Every projected charge from today through today + `days` (inclusive),
  // for active items, sorted by date. Defaults to the next 90 days.
  function upcomingCharges(items, today, days) {
    var span = days == null ? 90 : days;
    var end = addDays(today, span + 1);
    var out = [];
    items.forEach(function (item) {
      if (item.status !== 'active') return;
      occurrencesBetween(item, today, end).forEach(function (date) {
        out.push({
          itemId: item.id,
          name: item.name,
          category: item.category,
          date: date,
          amount: item.amount,
          currency: item.currency,
          daysLeft: daysLeft(date, today)
        });
      });
    });
    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return 0;
    });
    return out;
  }

  function filterItems(items, opts) {
    var options = opts || {};
    var q = (options.query || '').trim().toLowerCase();
    var cat = options.category || 'All';
    return items.filter(function (item) {
      if (cat !== 'All' && item.category !== cat) return false;
      if (!q) return true;
      var hay = (
        item.name +
        ' ' +
        (item.paymentLabel || '') +
        ' ' +
        (item.notes || '') +
        ' ' +
        item.category
      ).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /* ---------------- validation -------------------------------------------- */

  var idCounter = 0;
  function createId() {
    idCounter += 1;
    return (
      'it_' +
      Date.now().toString(36) +
      '_' +
      idCounter.toString(36) +
      Math.floor(Math.random() * 1679616).toString(36)
    );
  }

  // Validate and normalize one item. Returns { ok, errors, value }.
  // Missing currency, cycle, category, and status fall back to defaults;
  // present-but-invalid values are errors.
  function validateItem(input) {
    var errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, errors: ['Item must be an object.'], value: null };
    }

    var name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) errors.push('Name is required.');
    if (name.length > 80) errors.push('Name must be 80 characters or fewer.');

    var amount = typeof input.amount === 'string' ? Number(input.amount) : input.amount;
    if (typeof amount !== 'number' || !isFinite(amount)) {
      errors.push('Amount must be a number.');
    } else if (amount <= 0) {
      errors.push('Amount must be greater than zero.');
    } else if (amount > 1000000000) {
      errors.push('Amount is too large.');
    }

    var currency = input.currency == null ? 'INR' : input.currency;
    if (CURRENCIES.indexOf(currency) === -1) {
      errors.push('Currency must be one of: ' + CURRENCIES.join(', ') + '.');
    }

    var cycle = input.cycle == null ? 'monthly' : input.cycle;
    if (CYCLES.indexOf(cycle) === -1) {
      errors.push('Cycle must be one of: ' + CYCLES.join(', ') + '.');
    }

    var category = input.category == null ? 'Other' : input.category;
    if (CATEGORIES.indexOf(category) === -1) {
      errors.push('Category must be one of: ' + CATEGORIES.join(', ') + '.');
    }

    var nextDate = typeof input.nextDate === 'string' ? input.nextDate.trim() : '';
    if (!isValidDateStr(nextDate)) {
      errors.push('Next renewal date must be a valid date in YYYY-MM-DD format.');
    }

    var status = input.status == null ? 'active' : input.status;
    if (STATUSES.indexOf(status) === -1) {
      errors.push('Status must be "active" or "paused".');
    }

    var paymentLabel = input.paymentLabel == null ? '' : String(input.paymentLabel).trim();
    if (paymentLabel.length > 60) errors.push('Payment label must be 60 characters or fewer.');

    var notes = input.notes == null ? '' : String(input.notes).trim();
    if (notes.length > 500) errors.push('Notes must be 500 characters or fewer.');

    // Payment history, added in v1.1. Items saved by v1.0 have no
    // history field at all; they load with an empty history, so the
    // migration is lossless. Entries are stored most recent first.
    var history = [];
    if (input.history != null) {
      if (!Array.isArray(input.history)) {
        errors.push('History must be an array of past payments.');
      } else {
        input.history.forEach(function (h, idx) {
          if (!h || typeof h !== 'object' || Array.isArray(h)) {
            errors.push('History entry ' + (idx + 1) + ' must be an object.');
            return;
          }
          var hDate = typeof h.date === 'string' ? h.date.trim() : '';
          var hAmount = typeof h.amount === 'string' ? Number(h.amount) : h.amount;
          if (!isValidDateStr(hDate)) {
            errors.push('History entry ' + (idx + 1) + ' has an invalid date.');
          } else if (typeof hAmount !== 'number' || !isFinite(hAmount) || hAmount <= 0) {
            errors.push('History entry ' + (idx + 1) + ' has an invalid amount.');
          } else {
            history.push({ date: hDate, amount: Math.round(hAmount * 100) / 100 });
          }
        });
        history.sort(function (a, b) {
          return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
        });
      }
    }

    if (errors.length) return { ok: false, errors: errors, value: null };
    return {
      ok: true,
      errors: [],
      value: {
        id: typeof input.id === 'string' && input.id ? input.id : createId(),
        name: name,
        amount: Math.round(amount * 100) / 100,
        currency: currency,
        cycle: cycle,
        category: category,
        nextDate: nextDate,
        paymentLabel: paymentLabel,
        notes: notes,
        status: status,
        history: history
      }
    };
  }

  /* ---------------- mark as renewed --------------------------------------- */

  // Record a payment against an item and roll its next renewal forward.
  // `payment` may carry { date, amount }; the date defaults to `today`
  // and the amount to the item's tracked amount. Returns
  // { ok, errors, item, priceChanged, previousAmount } and never mutates
  // the input item. When the paid amount differs from the tracked
  // amount, the item amount is updated and priceChanged is true. For
  // recurring items the stored next date becomes the first occurrence
  // after the paid one: if the payment covers the currently effective
  // next charge, it rolls one more cycle; otherwise it rolls to the
  // first occurrence after today. One-time items keep their date.
  function markRenewed(item, payment, today) {
    var p = payment || {};
    var errors = [];
    var date = typeof p.date === 'string' && p.date.trim() ? p.date.trim() : today;
    if (!isValidDateStr(date)) errors.push('Payment date must be a valid date in YYYY-MM-DD format.');
    if (!isValidDateStr(today)) errors.push('Today must be a valid date in YYYY-MM-DD format.');

    var rawAmount = p.amount == null ? Number(item.amount) : p.amount;
    var amount = typeof rawAmount === 'string' ? Number(rawAmount) : rawAmount;
    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
      errors.push('Payment amount must be a number greater than zero.');
    }
    if (errors.length) return { ok: false, errors: errors, item: null, priceChanged: false, previousAmount: null };

    var paid = Math.round(amount * 100) / 100;
    var previousAmount = Math.round((Number(item.amount) || 0) * 100) / 100;
    var priceChanged = paid !== previousAmount;

    var history = (Array.isArray(item.history) ? item.history.slice() : []).concat([
      { date: date, amount: paid }
    ]);
    history.sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });

    var nextDate = item.nextDate;
    if (item.cycle !== 'one-time') {
      var info = firstOnOrAfter(item, today);
      if (date >= info.date || info.date <= today) {
        nextDate = addCycle(item.nextDate, item.cycle, info.steps + 1);
      } else {
        nextDate = info.date;
      }
    }

    var updated = {};
    Object.keys(item).forEach(function (k) {
      updated[k] = item[k];
    });
    updated.amount = paid;
    updated.nextDate = nextDate;
    updated.history = history;
    return { ok: true, errors: [], item: updated, priceChanged: priceChanged, previousAmount: previousAmount };
  }

  // Validate a parsed JSON import payload: either a bare array of items
  // or an object with an "items" array. Strict: if any item is invalid,
  // the whole import fails and every problem is reported with its
  // position, so a bad file never half-loads.
  function validateImport(data) {
    var list = null;
    if (Array.isArray(data)) {
      list = data;
    } else if (data && typeof data === 'object' && Array.isArray(data.items)) {
      list = data.items;
    }
    if (!list) {
      return {
        ok: false,
        errors: ['File must contain a JSON array of items, or an object with an "items" array.'],
        items: []
      };
    }
    var items = [];
    var errors = [];
    list.forEach(function (raw, idx) {
      var r = validateItem(raw);
      if (r.ok) {
        items.push(r.value);
      } else {
        r.errors.forEach(function (e) {
          errors.push('Item ' + (idx + 1) + ': ' + e);
        });
      }
    });
    if (errors.length) return { ok: false, errors: errors, items: [] };
    return { ok: true, errors: [], items: items };
  }

  /* ---------------- demo data --------------------------------------------- */

  // Fictional sample subscriptions, dated relative to `today` so the
  // dashboard always shows a realistic spread of urgency. Used only when
  // the user clicks "Load demo data".
  function demoItems(today) {
    var defs = [
      { name: 'StreamFlix', amount: 649, currency: 'INR', cycle: 'monthly', category: 'Entertainment', inDays: 3, paymentLabel: 'HDFC card' },
      { name: 'MusicWave', amount: 119, currency: 'INR', cycle: 'monthly', category: 'Entertainment', inDays: 6, paymentLabel: 'UPI AutoPay' },
      { name: 'CloudDesk Pro', amount: 120, currency: 'USD', cycle: 'yearly', category: 'SaaS and Apps', inDays: 12, paymentLabel: 'SBI card' },
      { name: 'City Power Utility', amount: 1450, currency: 'INR', cycle: 'monthly', category: 'Utilities', inDays: 9, paymentLabel: 'Bank auto-debit' },
      { name: 'SafeLife Term Insurance', amount: 18500, currency: 'INR', cycle: 'yearly', category: 'Insurance', inDays: 41, paymentLabel: 'Net banking' },
      { name: 'GymFlex', amount: 1500, currency: 'INR', cycle: 'monthly', category: 'Health', inDays: 15, paymentLabel: 'HDFC card' },
      { name: 'Domain renewal (example.in)', amount: 899, currency: 'INR', cycle: 'yearly', category: 'SaaS and Apps', inDays: 64, paymentLabel: 'SBI card' }
    ];
    return defs.map(function (d) {
      var nextDate = addDays(today, d.inDays);
      // A couple of demo items carry past payments so the history view
      // and price-change display have something real to show.
      var history = [];
      if (d.name === 'StreamFlix') {
        history = [
          { date: addCycle(nextDate, 'monthly', -1), amount: d.amount },
          { date: addCycle(nextDate, 'monthly', -2), amount: 499 }
        ];
      } else if (d.name === 'MusicWave') {
        history = [{ date: addCycle(nextDate, 'monthly', -1), amount: d.amount }];
      } else if (d.name === 'GymFlex') {
        history = [
          { date: addCycle(nextDate, 'monthly', -1), amount: d.amount },
          { date: addCycle(nextDate, 'monthly', -2), amount: d.amount }
        ];
      }
      return validateItem({
        name: d.name,
        amount: d.amount,
        currency: d.currency,
        cycle: d.cycle,
        category: d.category,
        nextDate: nextDate,
        paymentLabel: d.paymentLabel,
        notes: 'Demo item',
        status: 'active',
        history: history
      }).value;
    });
  }

  /* ---------------- category colors --------------------------------------- */

  // One stable color per category, used by the monogram tiles, chips,
  // breakdown bars, and timeline markers so a category looks the same
  // everywhere in the UI.
  var CATEGORY_COLORS = {
    Entertainment: '#f26d8d',
    'SaaS and Apps': '#5b8def',
    Utilities: '#f2b04a',
    Insurance: '#9a6ee8',
    Finance: '#35c48d',
    Health: '#4ac8f2',
    Education: '#f2784b',
    Other: '#95a5b8'
  };

  function categoryColor(category) {
    return CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;
  }

  /* ---------------- quick-add catalog -------------------------------------- */

  // Common services with a typical price. The amounts are starting
  // points only: the add form labels them as typical prices the user
  // should replace with what they actually pay.
  var QUICK_ADD = [
    { name: 'Netflix', category: 'Entertainment', cycle: 'monthly', amount: 649, currency: 'INR' },
    { name: 'Spotify', category: 'Entertainment', cycle: 'monthly', amount: 119, currency: 'INR' },
    { name: 'YouTube Premium', category: 'Entertainment', cycle: 'monthly', amount: 139, currency: 'INR' },
    { name: 'Amazon Prime', category: 'Entertainment', cycle: 'yearly', amount: 1499, currency: 'INR' },
    { name: 'Disney+ Hotstar', category: 'Entertainment', cycle: 'yearly', amount: 1499, currency: 'INR' },
    { name: 'iCloud+', category: 'SaaS and Apps', cycle: 'monthly', amount: 75, currency: 'INR' },
    { name: 'Google One', category: 'SaaS and Apps', cycle: 'monthly', amount: 130, currency: 'INR' },
    { name: 'ChatGPT Plus', category: 'SaaS and Apps', cycle: 'monthly', amount: 1999, currency: 'INR' },
    { name: 'GitHub Copilot', category: 'SaaS and Apps', cycle: 'monthly', amount: 900, currency: 'INR' },
    { name: 'Microsoft 365', category: 'SaaS and Apps', cycle: 'yearly', amount: 6899, currency: 'INR' },
    { name: 'Adobe Creative Cloud', category: 'SaaS and Apps', cycle: 'monthly', amount: 4230, currency: 'INR' },
    { name: 'Notion', category: 'SaaS and Apps', cycle: 'monthly', amount: 830, currency: 'INR' },
    { name: 'House Rent', category: 'Utilities', cycle: 'monthly', amount: 15000, currency: 'INR' },
    { name: 'Gym', category: 'Health', cycle: 'monthly', amount: 1500, currency: 'INR' }
  ];

  /* ---------------- statement CSV parsing ----------------------------------- */

  // A tolerant CSV reader: quoted fields, escaped quotes (""), embedded
  // commas and newlines inside quotes, CRLF or LF line endings.
  function parseCSV(text, delimiter) {
    var delim = delimiter || ',';
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var s = String(text == null ? '' : text);
    var i = 0;
    function endField() {
      row.push(field);
      field = '';
    }
    function endRow() {
      endField();
      rows.push(row);
      row = [];
    }
    while (i < s.length) {
      var ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            inQuotes = false;
            i += 1;
          }
        } else {
          field += ch;
          i += 1;
        }
      } else if (ch === '"' && field === '') {
        inQuotes = true;
        i += 1;
      } else if (ch === delim) {
        endField();
        i += 1;
      } else if (ch === '\r') {
        if (s[i + 1] === '\n') i += 1;
        endRow();
        i += 1;
      } else if (ch === '\n') {
        endRow();
        i += 1;
      } else {
        field += ch;
        i += 1;
      }
    }
    if (field !== '' || row.length) endRow();
    return rows;
  }

  function normalizeHeader(cell) {
    return String(cell == null ? '' : cell)
      .toLowerCase()
      .replace(/[^a-z]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  var DATE_HEADERS = ['date', 'transaction date', 'txn date', 'value date', 'tran date', 'posting date', 'trans date'];
  var DESC_HEADERS = [
    'narration',
    'description',
    'particulars',
    'remarks',
    'transaction details',
    'transaction remarks',
    'details',
    'desc'
  ];
  var DEBIT_HEADERS = [
    'debit',
    'debit amount',
    'withdrawal amt',
    'withdrawal',
    'withdrawals',
    'withdrawal amount',
    'amount debited',
    'dr',
    'paid out',
    'money out',
    'debit inr'
  ];
  var CREDIT_HEADERS = [
    'credit',
    'credit amount',
    'deposit amt',
    'deposit',
    'deposit amount',
    'amount credited',
    'cr',
    'money in'
  ];
  var AMOUNT_HEADERS = ['amount', 'transaction amount', 'amount inr', 'amount rs', 'amt'];
  var TYPE_HEADERS = ['type', 'dr cr', 'cr dr', 'transaction type', 'debit credit'];

  function findColumn(headers, candidates) {
    for (var i = 0; i < headers.length; i++) {
      if (candidates.indexOf(headers[i]) !== -1) return i;
    }
    return -1;
  }

  var MONTH_NAMES = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };

  // Parse the many date shapes bank exports use into YYYY-MM-DD.
  // Day-first for numeric dates, matching Indian bank exports.
  function parseStatementDate(raw) {
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!s) return null;
    var m;
    var iso;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) {
      iso = m[1] + '-' + pad(Number(m[2])) + '-' + pad(Number(m[3]));
    } else if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s))) {
      iso = m[3] + '-' + pad(Number(m[2])) + '-' + pad(Number(m[1]));
    } else if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/.exec(s.trim()))) {
      iso = '20' + m[3] + '-' + pad(Number(m[2])) + '-' + pad(Number(m[1]));
    } else if ((m = /^(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-,]+(\d{4})/.exec(s))) {
      var mon = MONTH_NAMES[m[2].slice(0, 3).toLowerCase()];
      if (!mon) return null;
      iso = m[3] + '-' + pad(mon) + '-' + pad(Number(m[1]));
    } else if ((m = /^([A-Za-z]{3,9})[\s\-](\d{1,2}),?[\s\-](\d{4})/.exec(s))) {
      var mon2 = MONTH_NAMES[m[1].slice(0, 3).toLowerCase()];
      if (!mon2) return null;
      iso = m[3] + '-' + pad(mon2) + '-' + pad(Number(m[2]));
    } else {
      return null;
    }
    return isValidDateStr(iso) ? iso : null;
  }

  // Parse one money cell. Returns { amount, suffix } where amount is a
  // signed number or null when the cell holds no number, and suffix is
  // 'dr', 'cr', or '' when the cell itself carries a Dr/Cr marker such
  // as "1,499.00 Dr". Parentheses mean negative, accounting style.
  function parseMoneyCell(raw) {
    if (raw == null) return { amount: null, suffix: '' };
    var s = String(raw).trim();
    if (!s) return { amount: null, suffix: '' };
    var suffix = '';
    var suf = /(dr|cr)\.?$/i.exec(s.replace(/[,\s]+$/, ''));
    if (suf) {
      suffix = suf[1].toLowerCase();
      s = s.slice(0, suf.index).trim();
    }
    var negative = false;
    if (/^\(.*\)$/.test(s)) {
      negative = true;
      s = s.slice(1, -1);
    }
    s = s.replace(/[^0-9.\-]/g, '');
    if (!s || s === '-' || s === '.') return { amount: null, suffix: suffix };
    var n = Number(s);
    if (!isFinite(n)) return { amount: null, suffix: suffix };
    if (negative) n = -Math.abs(n);
    return { amount: n, suffix: suffix };
  }

  var STATEMENT_FORMAT_HINT =
    'Supported formats: a CSV with a date column (Date, Transaction Date, or Value Date), a description column ' +
    '(Narration, Description, Particulars, or Remarks), and either a Debit or Withdrawal column, or an Amount ' +
    'column with a Dr/Cr or Type column, or signed amounts (negative means money out). HDFC, SBI, ICICI, and ' +
    'Axis exports follow these shapes.';

  // Parse a bank statement CSV into money-out transactions.
  // Returns { ok, error, rowsRead, rowsUsed, transactions } where each
  // transaction is { date, description, amount } with amount positive.
  function parseStatementCSV(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'The file is empty. ' + STATEMENT_FORMAT_HINT, rowsRead: 0, rowsUsed: 0, transactions: [] };
    }
    var delimiters = [',', ';', '\t'];
    var found = null;
    for (var d = 0; d < delimiters.length && !found; d++) {
      var rows = parseCSV(text, delimiters[d]);
      for (var r = 0; r < Math.min(rows.length, 15); r++) {
        var headers = rows[r].map(normalizeHeader);
        var cols = {
          date: findColumn(headers, DATE_HEADERS),
          desc: findColumn(headers, DESC_HEADERS),
          debit: findColumn(headers, DEBIT_HEADERS),
          credit: findColumn(headers, CREDIT_HEADERS),
          amount: findColumn(headers, AMOUNT_HEADERS),
          type: findColumn(headers, TYPE_HEADERS)
        };
        if (cols.date !== -1 && cols.desc !== -1 && (cols.debit !== -1 || cols.amount !== -1)) {
          found = { rows: rows, headerRow: r, cols: cols };
          break;
        }
      }
    }
    if (!found) {
      return {
        ok: false,
        error: 'Could not recognize the statement columns. ' + STATEMENT_FORMAT_HINT,
        rowsRead: 0,
        rowsUsed: 0,
        transactions: []
      };
    }

    var cols = found.cols;
    var transactions = [];
    var rowsRead = 0;
    var sawPositiveAmountOnly = false;
    for (var i = found.headerRow + 1; i < found.rows.length; i++) {
      var row = found.rows[i];
      if (!row || row.every(function (c) { return String(c).trim() === ''; })) continue;
      rowsRead += 1;
      var date = parseStatementDate(row[cols.date]);
      var desc = String(row[cols.desc] == null ? '' : row[cols.desc]).trim();
      if (!date || !desc) continue;

      var out = null;
      if (cols.debit !== -1) {
        var debit = parseMoneyCell(row[cols.debit]);
        if (debit.amount != null && debit.amount > 0) out = debit.amount;
      } else if (cols.amount !== -1) {
        var cell = parseMoneyCell(row[cols.amount]);
        if (cell.amount == null || cell.amount === 0) continue;
        var typeVal = cols.type !== -1 ? normalizeHeader(row[cols.type]) : '';
        var marker = cell.suffix || typeVal;
        if (marker) {
          if (marker === 'dr' || marker === 'debit' || marker === 'withdrawal' || marker === 'out' || marker === 'd') {
            out = Math.abs(cell.amount);
          }
        } else if (cell.amount < 0) {
          out = Math.abs(cell.amount);
        } else {
          sawPositiveAmountOnly = true;
        }
      }
      if (out != null && out > 0) {
        transactions.push({ date: date, description: desc, amount: Math.round(out * 100) / 100 });
      }
    }

    if (!transactions.length && sawPositiveAmountOnly) {
      return {
        ok: false,
        error:
          'Found an Amount column, but nothing in the file shows which rows are money out. ' +
          'Export with a Debit column or a Dr/Cr column, or use signed amounts with money out as negative.',
        rowsRead: rowsRead,
        rowsUsed: 0,
        transactions: []
      };
    }
    return { ok: true, error: null, rowsRead: rowsRead, rowsUsed: transactions.length, transactions: transactions };
  }

  /* ---------------- recurring charge detection ----------------------------- */

  var MERCHANT_NOISE = {
    UPI: 1, POS: 1, NEFT: 1, ACH: 1, NACH: 1, IMPS: 1, RTGS: 1, ECS: 1, SI: 1,
    AUTOPAY: 1, AUTO: 1, DEBIT: 1, CREDIT: 1, PAYMENT: 1, PAYMENTS: 1, PYMT: 1,
    PURCHASE: 1, TRANSACTION: 1, TXN: 1, REF: 1, CHQ: 1, BILL: 1, BILLPAY: 1,
    BBPS: 1, ECOM: 1, WWW: 1, COM: 1, IN: 1, IND: 1, INDIA: 1, PVT: 1, LTD: 1,
    LIMITED: 1, BANK: 1, HDFC: 1, SBI: 1, ICICI: 1, AXIS: 1, KOTAK: 1,
    MUMBAI: 1, DELHI: 1, BANGALORE: 1, BENGALURU: 1, CHENNAI: 1,
    KOLKATA: 1, HYDERABAD: 1, PUNE: 1, AHMEDABAD: 1, JAIPUR: 1, LUCKNOW: 1,
    INDORE: 1, NOIDA: 1, GURGAON: 1, GURUGRAM: 1
  };

  // Reduce a bank narration to a merchant key: uppercase, drop digits
  // (reference numbers, card tails), drop punctuation, and drop the
  // channel and boilerplate words banks wrap around the real name.
  function normalizeMerchant(description) {
    var s = String(description == null ? '' : description).toUpperCase();
    s = s.replace(/[0-9]+/g, ' ');
    s = s.replace(/[^A-Z& ]+/g, ' ');
    var tokens = s.split(/\s+/).filter(function (t) {
      return t.length > 1 && !MERCHANT_NOISE[t];
    });
    return tokens.join(' ').trim();
  }

  function titleCase(str) {
    return String(str || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map(function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(' ');
  }

  function median(values) {
    var sorted = values.slice().sort(function (a, b) {
      return a - b;
    });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  var CADENCE_RANGES = [
    { min: 6, max: 8, cycle: 'weekly' },
    { min: 25, max: 35, cycle: 'monthly' },
    { min: 80, max: 100, cycle: 'quarterly' },
    { min: 170, max: 195, cycle: 'half-yearly' },
    { min: 350, max: 380, cycle: 'yearly' }
  ];

  function inferCadence(gaps) {
    if (!gaps.length) return null;
    var med = median(gaps);
    for (var i = 0; i < CADENCE_RANGES.length; i++) {
      if (med >= CADENCE_RANGES[i].min && med <= CADENCE_RANGES[i].max) return CADENCE_RANGES[i].cycle;
    }
    return null;
  }

  // Group one merchant's transactions into amount clusters: a new
  // transaction joins a cluster when it sits within plus or minus 2
  // percent of the cluster's anchor (its first amount).
  function clusterByAmount(txns) {
    var sorted = txns.slice().sort(function (a, b) {
      return a.amount - b.amount;
    });
    var clusters = [];
    sorted.forEach(function (t) {
      var hit = null;
      for (var i = 0; i < clusters.length; i++) {
        if (Math.abs(t.amount - clusters[i].anchor) <= clusters[i].anchor * 0.02) {
          hit = clusters[i];
          break;
        }
      }
      if (hit) hit.txns.push(t);
      else clusters.push({ anchor: t.amount, txns: [t] });
    });
    return clusters;
  }

  // Find likely subscriptions in money-out transactions. One proposal
  // per merchant, from its largest amount cluster, and only when the
  // cluster has at least 2 charges on a recognizable cadence.
  function detectRecurring(transactions, existingItems) {
    var groups = {};
    (transactions || []).forEach(function (t) {
      var key = normalizeMerchant(t.description);
      if (!key) return;
      (groups[key] || (groups[key] = [])).push(t);
    });

    var trackedKeys = (existingItems || []).map(function (item) {
      return normalizeMerchant(item.name);
    });

    var proposals = [];
    Object.keys(groups).forEach(function (key) {
      var clusters = clusterByAmount(groups[key]);
      clusters.sort(function (a, b) {
        if (b.txns.length !== a.txns.length) return b.txns.length - a.txns.length;
        var lastA = a.txns.map(function (t) { return t.date; }).sort().pop();
        var lastB = b.txns.map(function (t) { return t.date; }).sort().pop();
        return lastA < lastB ? 1 : -1;
      });
      var best = clusters[0];
      if (!best || best.txns.length < 2) return;

      var byDate = best.txns.slice().sort(function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      });
      var gaps = [];
      for (var i = 1; i < byDate.length; i++) {
        gaps.push(daysLeft(byDate[i].date, byDate[i - 1].date));
      }
      var cycle = inferCadence(gaps);
      if (!cycle) return;

      var last = byDate[byDate.length - 1];
      var avgGap = Math.round(gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length);
      var alreadyTracked = trackedKeys.some(function (k) {
        return k && (k === key || k.indexOf(key) === 0 || key.indexOf(k) === 0);
      });
      proposals.push({
        key: key,
        name: titleCase(key),
        amount: Math.round(last.amount * 100) / 100,
        currency: 'INR',
        cycle: cycle,
        nextDate: addCycle(last.date, cycle, 1),
        occurrences: byDate.length,
        avgGapDays: avgGap,
        lastDate: last.date,
        alreadyTracked: alreadyTracked
      });
    });

    proposals.sort(function (a, b) {
      if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
      return a.lastDate < b.lastDate ? 1 : -1;
    });
    return proposals;
  }

  /* ---------------- calendar export (.ics) ---------------------------------- */

  function icsEscape(text) {
    return String(text == null ? '' : text)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }

  var ICS_RRULES = {
    weekly: 'FREQ=WEEKLY',
    monthly: 'FREQ=MONTHLY',
    quarterly: 'FREQ=MONTHLY;INTERVAL=3',
    'half-yearly': 'FREQ=MONTHLY;INTERVAL=6',
    yearly: 'FREQ=YEARLY'
  };

  function icsDate(dateStr) {
    return dateStr.replace(/-/g, '');
  }

  function icsStamp(now) {
    var d = now instanceof Date ? now : new Date();
    return (
      d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      'T' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      'Z'
    );
  }

  // One VEVENT per active item at its effective next renewal, with an
  // RRULE matching the item's cycle (none for one-time items) and a
  // VALARM 3 days before. Pure string building: the browser turns the
  // result into a Blob download, so reminders need no server.
  function generateICS(items, today, now) {
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//RenewalRadar//Renewal Reminders//EN',
      'CALSCALE:GREGORIAN'
    ];
    var stamp = icsStamp(now);
    (items || []).forEach(function (item) {
      if (item.status !== 'active') return;
      var start = effectiveNext(item, today);
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + item.id + '@renewalradar');
      lines.push('DTSTAMP:' + stamp);
      lines.push('DTSTART;VALUE=DATE:' + icsDate(start));
      var rrule = ICS_RRULES[item.cycle];
      if (rrule) lines.push('RRULE:' + rrule);
      lines.push(
        'SUMMARY:' +
          icsEscape(item.name + ' renewal (' + item.currency + ' ' + (Math.round(item.amount * 100) / 100) + ')')
      );
      lines.push('DESCRIPTION:' + icsEscape('RenewalRadar reminder: ' + item.name + ' renews today.'));
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push('TRIGGER:-P3D');
      lines.push('DESCRIPTION:' + icsEscape(item.name + ' renews in 3 days.'));
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  var api = {
    CYCLES: CYCLES,
    CURRENCIES: CURRENCIES,
    CATEGORIES: CATEGORIES,
    STATUSES: STATUSES,
    STORAGE_KEY: STORAGE_KEY,
    parseDate: parseDate,
    isValidDateStr: isValidDateStr,
    formatDate: formatDate,
    todayStr: todayStr,
    addDays: addDays,
    addMonthsClamped: addMonthsClamped,
    addCycle: addCycle,
    daysLeft: daysLeft,
    effectiveNext: effectiveNext,
    occurrencesBetween: occurrencesBetween,
    monthlyAmount: monthlyAmount,
    yearlyAmount: yearlyAmount,
    computeTotals: computeTotals,
    categoryBreakdown: categoryBreakdown,
    badgeFor: badgeFor,
    renewingSoon: renewingSoon,
    upcomingCharges: upcomingCharges,
    filterItems: filterItems,
    validateItem: validateItem,
    validateImport: validateImport,
    createId: createId,
    demoItems: demoItems,
    markRenewed: markRenewed,
    CATEGORY_COLORS: CATEGORY_COLORS,
    categoryColor: categoryColor,
    QUICK_ADD: QUICK_ADD,
    parseCSV: parseCSV,
    parseStatementDate: parseStatementDate,
    parseStatementCSV: parseStatementCSV,
    normalizeMerchant: normalizeMerchant,
    inferCadence: inferCadence,
    detectRecurring: detectRecurring,
    generateICS: generateICS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.RenewalCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
