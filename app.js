/*
 * RenewalRadar UI.
 *
 * All state lives in localStorage under Core.STORAGE_KEY. Nothing is
 * sent anywhere. All math is delegated to core.js (window.RenewalCore)
 * so the UI and the tests share one implementation.
 */
(function () {
  'use strict';

  var Core = window.RenewalCore;

  var CYCLE_LABELS = {
    weekly: 'per week',
    monthly: 'per month',
    quarterly: 'per quarter',
    'half-yearly': 'every 6 months',
    yearly: 'per year',
    'one-time': 'one-time'
  };
  var CYCLE_NAMES = {
    weekly: 'Weekly',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    'half-yearly': 'Half-yearly',
    yearly: 'Yearly',
    'one-time': 'One-time'
  };
  var LOCALES = { INR: 'en-IN', USD: 'en-US', EUR: 'en-IE', GBP: 'en-GB' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  var items = [];
  var activeCategory = 'All';
  var searchQuery = '';
  var breakdownCurrency = null;
  var bannerTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------------- formatting ---------------- */

  function fmtMoney(amount, currency) {
    var fmt = new Intl.NumberFormat(LOCALES[currency] || 'en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
    return fmt.format(amount);
  }

  function fmtDate(dateStr) {
    var parts = dateStr.split('-');
    return Number(parts[2]) + ' ' + MONTHS[Number(parts[1]) - 1] + ' ' + parts[0];
  }

  function badgeText(entry) {
    if (entry.daysLeft < 0) return Math.abs(entry.daysLeft) + 'd overdue';
    if (entry.daysLeft === 0) return 'Today';
    if (entry.daysLeft === 1) return 'Tomorrow';
    return 'in ' + entry.daysLeft + 'd';
  }

  /* ---------------- storage ---------------- */

  function load() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(Core.STORAGE_KEY);
    } catch (e) {
      raw = null;
    }
    if (!raw) {
      items = [];
      return;
    }
    try {
      var parsed = JSON.parse(raw);
      var result = Core.validateImport(parsed);
      if (result.ok) {
        items = result.items;
      } else {
        items = [];
        showBanner('Your saved data could not be read, so RenewalRadar started empty. ' + result.errors.join(' '), false);
      }
    } catch (e) {
      items = [];
      showBanner('Your saved data was corrupted, so RenewalRadar started empty.', false);
    }
  }

  function save() {
    try {
      window.localStorage.setItem(Core.STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      showBanner('Could not save. Your browser storage may be full or blocked.', false);
    }
  }

  /* ---------------- banner ---------------- */

  function showBanner(message, isSuccess) {
    var banner = $('banner');
    banner.textContent = message;
    banner.className = 'banner' + (isSuccess ? ' success' : '');
    banner.hidden = false;
    if (bannerTimer) window.clearTimeout(bannerTimer);
    if (isSuccess) {
      bannerTimer = window.setTimeout(function () {
        banner.hidden = true;
      }, 5000);
    }
  }

  function hideBanner() {
    $('banner').hidden = true;
  }

  /* ---------------- rendering ---------------- */

  function statLines(container, byCurrency, key) {
    container.textContent = '';
    var currencies = Object.keys(byCurrency);
    if (!currencies.length) {
      container.appendChild(el('div', 'stat-line', ''));
      container.firstChild.appendChild(el('span', 'stat-amount', '0'));
      return;
    }
    currencies.sort().forEach(function (cur) {
      var line = el('div', 'stat-line');
      line.appendChild(el('span', 'stat-amount', fmtMoney(byCurrency[cur][key], cur)));
      line.appendChild(el('span', 'stat-cur', cur));
      container.appendChild(line);
    });
  }

  function renderStats(today) {
    var totals = Core.computeTotals(items, today);
    statLines($('statMonthly'), totals.byCurrency, 'monthly');
    statLines($('statYearly'), totals.byCurrency, 'yearly');
    statLines($('statDue'), totals.byCurrency, 'due30');
    var active = $('statActive');
    active.textContent = '';
    var line = el('div', 'stat-line');
    line.appendChild(el('span', 'stat-amount', String(totals.activeCount)));
    active.appendChild(line);
  }

  function renderSoon(today) {
    var list = $('soonList');
    list.textContent = '';
    var entries = Core.renewingSoon(items, today);
    $('soonEmpty').hidden = entries.length > 0;
    entries.slice(0, 8).forEach(function (entry) {
      var item = entry.item;
      var row = el('li', 'soon-row');
      var main = el('div', 'soon-main');
      main.appendChild(el('div', 'soon-name', item.name));
      var meta = fmtDate(entry.date) + ' · ' + item.category;
      if (item.paymentLabel) meta += ' · ' + item.paymentLabel;
      main.appendChild(el('div', 'soon-meta', meta));
      row.appendChild(main);
      row.appendChild(el('span', 'soon-amount', fmtMoney(item.amount, item.currency)));
      var badge = el('span', 'badge badge-' + entry.badge, badgeText(entry));
      row.appendChild(badge);
      list.appendChild(row);
    });
  }

  function renderBreakdown() {
    var select = $('breakdownCurrency');
    var present = Core.CURRENCIES.filter(function (cur) {
      return items.some(function (i) {
        return i.currency === cur && i.status === 'active';
      });
    });
    if (!present.length) present = ['INR'];
    if (!breakdownCurrency || present.indexOf(breakdownCurrency) === -1) {
      breakdownCurrency = present.indexOf('INR') !== -1 ? 'INR' : present[0];
    }
    select.textContent = '';
    present.forEach(function (cur) {
      var opt = el('option', null, cur);
      opt.value = cur;
      if (cur === breakdownCurrency) opt.selected = true;
      select.appendChild(opt);
    });

    var rows = Core.categoryBreakdown(items, breakdownCurrency);
    var bars = $('breakdownBars');
    bars.textContent = '';
    $('breakdownEmpty').hidden = rows.length > 0;
    rows.forEach(function (row) {
      var wrap = el('div', 'bar-row');
      var head = el('div', 'bar-head');
      head.appendChild(el('span', null, row.category));
      head.appendChild(
        el('span', 'bar-amount', fmtMoney(row.monthly, breakdownCurrency) + ' / mo · ' + Math.round(row.share) + '%')
      );
      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill');
      fill.style.width = Math.max(2, Math.round(row.share)) + '%';
      track.appendChild(fill);
      wrap.appendChild(head);
      wrap.appendChild(track);
      bars.appendChild(wrap);
    });
  }

  function renderUpcoming(today) {
    var charges = Core.upcomingCharges(items, today, 90);
    var container = $('upcomingList');
    container.textContent = '';
    $('upcomingEmpty').hidden = charges.length > 0;

    var groups = {};
    var order = [];
    charges.forEach(function (charge) {
      var key = charge.date.slice(0, 7);
      if (!groups[key]) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(charge);
    });

    order.forEach(function (key) {
      var group = el('div', 'upcoming-group');
      var parts = key.split('-');
      var title = MONTHS_LONG[Number(parts[1]) - 1] + ' ' + parts[0];
      var totals = {};
      groups[key].forEach(function (c) {
        totals[c.currency] = (totals[c.currency] || 0) + c.amount;
      });
      var totalText = Object.keys(totals)
        .sort()
        .map(function (cur) {
          return fmtMoney(totals[cur], cur);
        })
        .join(' · ');
      group.appendChild(el('h3', null, title + ' · ' + totalText));
      groups[key].forEach(function (charge) {
        var row = el('div', 'charge-row');
        row.appendChild(el('span', 'charge-date', fmtDate(charge.date)));
        row.appendChild(el('span', 'charge-name', charge.name));
        row.appendChild(el('span', 'charge-amount', fmtMoney(charge.amount, charge.currency)));
        group.appendChild(row);
      });
      container.appendChild(group);
    });
  }

  function renderItems(today) {
    var filtered = Core.filterItems(items, { query: searchQuery, category: activeCategory });
    var sorted = filtered.slice().sort(function (a, b) {
      var da = Core.effectiveNext(a, today);
      var db = Core.effectiveNext(b, today);
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      if (da !== db) return da < db ? -1 : 1;
      return a.name < b.name ? -1 : 1;
    });

    var list = $('itemsList');
    list.textContent = '';
    $('itemsEmpty').hidden = sorted.length > 0;

    sorted.forEach(function (item) {
      var row = el('li', 'item-row' + (item.status === 'paused' ? ' is-paused' : ''));
      var main = el('div', 'item-main');
      var top = el('div', 'item-top');
      top.appendChild(el('span', 'item-name', item.name));
      top.appendChild(el('span', 'item-cat', item.category));
      if (item.status === 'paused') top.appendChild(el('span', 'item-paused-tag', 'Paused'));
      main.appendChild(top);

      var next = Core.effectiveNext(item, today);
      var meta = 'Next: ' + fmtDate(next);
      if (item.cycle !== 'one-time') meta += ' (stored date ' + fmtDate(item.nextDate) + ')';
      if (item.paymentLabel) meta += ' · ' + item.paymentLabel;
      main.appendChild(el('div', 'item-meta', meta));
      if (item.notes) main.appendChild(el('div', 'item-notes', item.notes));
      row.appendChild(main);

      var side = el('div', 'item-side');
      side.appendChild(el('div', 'item-amount', fmtMoney(item.amount, item.currency)));
      side.appendChild(el('div', 'item-cycle', CYCLE_LABELS[item.cycle] || item.cycle));
      var actions = el('div', 'item-actions');
      var editBtn = el('button', 'btn btn-ghost btn-small', 'Edit');
      editBtn.type = 'button';
      editBtn.addEventListener('click', function () {
        openModal(item);
      });
      var delBtn = el('button', 'btn btn-ghost btn-small', 'Delete');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function () {
        if (window.confirm('Delete "' + item.name + '"? This cannot be undone.')) {
          items = items.filter(function (i) {
            return i.id !== item.id;
          });
          save();
          render();
        }
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      side.appendChild(actions);
      row.appendChild(side);
      list.appendChild(row);
    });
  }

  function renderChips() {
    var row = $('chipRow');
    row.textContent = '';
    ['All'].concat(Core.CATEGORIES).forEach(function (cat) {
      var chip = el('button', 'chip' + (cat === activeCategory ? ' active' : ''), cat);
      chip.type = 'button';
      chip.addEventListener('click', function () {
        activeCategory = cat;
        render();
      });
      row.appendChild(chip);
    });
  }

  function render() {
    var today = Core.todayStr();
    var hasItems = items.length > 0;
    $('emptyState').hidden = hasItems;
    $('dashboard').hidden = !hasItems;
    if (!hasItems) return;
    renderStats(today);
    renderSoon(today);
    renderBreakdown();
    renderUpcoming(today);
    renderChips();
    renderItems(today);
  }

  /* ---------------- modal form ---------------- */

  function fillSelect(select, values, labels) {
    select.textContent = '';
    values.forEach(function (v) {
      var opt = el('option', null, labels ? labels[v] : v);
      opt.value = v;
      select.appendChild(opt);
    });
  }

  function openModal(item) {
    var form = $('itemForm');
    form.reset();
    $('formErrors').hidden = true;
    $('fId').value = item ? item.id : '';
    $('formTitle').textContent = item ? 'Edit item' : 'Add item';
    if (item) {
      $('fName').value = item.name;
      $('fAmount').value = item.amount;
      $('fCurrency').value = item.currency;
      $('fCycle').value = item.cycle;
      $('fCategory').value = item.category;
      $('fNextDate').value = item.nextDate;
      $('fStatus').value = item.status;
      $('fPaymentLabel').value = item.paymentLabel || '';
      $('fNotes').value = item.notes || '';
    } else {
      $('fCurrency').value = 'INR';
      $('fCycle').value = 'monthly';
      $('fCategory').value = 'Other';
      $('fStatus').value = 'active';
      $('fNextDate').value = Core.todayStr();
    }
    $('modalOverlay').hidden = false;
    $('fName').focus();
  }

  function closeModal() {
    $('modalOverlay').hidden = true;
  }

  function onFormSubmit(event) {
    event.preventDefault();
    var input = {
      id: $('fId').value || undefined,
      name: $('fName').value,
      amount: $('fAmount').value,
      currency: $('fCurrency').value,
      cycle: $('fCycle').value,
      category: $('fCategory').value,
      nextDate: $('fNextDate').value,
      status: $('fStatus').value,
      paymentLabel: $('fPaymentLabel').value,
      notes: $('fNotes').value
    };
    var result = Core.validateItem(input);
    var errorsBox = $('formErrors');
    if (!result.ok) {
      errorsBox.textContent = result.errors.join('\n');
      errorsBox.hidden = false;
      return;
    }
    var value = result.value;
    var existing = -1;
    items.forEach(function (it, idx) {
      if (it.id === value.id) existing = idx;
    });
    if (existing >= 0) {
      items[existing] = value;
    } else {
      items.push(value);
    }
    save();
    closeModal();
    hideBanner();
    render();
  }

  /* ---------------- data actions ---------------- */

  function onExport() {
    var payload = {
      app: 'renewalradar',
      version: 1,
      exportedAt: new Date().toISOString(),
      items: items
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'renewalradar-export.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function onImportFile(event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    file
      .text()
      .then(function (text) {
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          showBanner('Import failed: that file is not valid JSON.', false);
          return;
        }
        var result = Core.validateImport(data);
        if (!result.ok) {
          showBanner('Import failed:\n' + result.errors.join('\n'), false);
          return;
        }
        var message =
          'Import ' +
          result.items.length +
          ' item' +
          (result.items.length === 1 ? '' : 's') +
          '? This replaces your current ' +
          items.length +
          ' item' +
          (items.length === 1 ? '' : 's') +
          '.';
        if (!window.confirm(message)) return;
        items = result.items;
        breakdownCurrency = null;
        save();
        render();
        showBanner('Imported ' + result.items.length + ' items.', true);
      })
      .catch(function () {
        showBanner('Import failed: the file could not be read.', false);
      });
  }

  function onClear() {
    if (!items.length) return;
    if (!window.confirm('Clear all RenewalRadar data from this browser? Export a backup first if you need one.')) {
      return;
    }
    items = [];
    breakdownCurrency = null;
    save();
    render();
    showBanner('All data cleared.', true);
  }

  function onDemo() {
    if (items.length && !window.confirm('Load demo data? This replaces your current items.')) return;
    items = Core.demoItems(Core.todayStr());
    breakdownCurrency = null;
    save();
    render();
    showBanner('Demo data loaded. The 7 demo items are fictional examples.', true);
  }

  /* ---------------- init ---------------- */

  function init() {
    fillSelect($('fCurrency'), Core.CURRENCIES);
    fillSelect($('fCycle'), Core.CYCLES, CYCLE_NAMES);
    fillSelect($('fCategory'), Core.CATEGORIES);

    $('addBtn').addEventListener('click', function () {
      openModal(null);
    });
    $('emptyAddBtn').addEventListener('click', function () {
      openModal(null);
    });
    $('demoBtn').addEventListener('click', onDemo);
    $('exportBtn').addEventListener('click', onExport);
    $('importFile').addEventListener('change', onImportFile);
    $('clearBtn').addEventListener('click', onClear);
    $('cancelBtn').addEventListener('click', closeModal);
    $('itemForm').addEventListener('submit', onFormSubmit);
    $('modalOverlay').addEventListener('click', function (event) {
      if (event.target === $('modalOverlay')) closeModal();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('modalOverlay').hidden) closeModal();
    });
    $('searchInput').addEventListener('input', function (event) {
      searchQuery = event.target.value;
      renderItems(Core.todayStr());
    });
    $('breakdownCurrency').addEventListener('change', function (event) {
      breakdownCurrency = event.target.value;
      renderBreakdown();
    });

    load();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
