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
        status: status
      }
    };
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
      return validateItem({
        name: d.name,
        amount: d.amount,
        currency: d.currency,
        cycle: d.cycle,
        category: d.category,
        nextDate: addDays(today, d.inDays),
        paymentLabel: d.paymentLabel,
        notes: 'Demo item',
        status: 'active'
      }).value;
    });
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
    demoItems: demoItems
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.RenewalCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
