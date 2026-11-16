/*
 * RenewalRadar UI.
 *
 * All state lives in localStorage under Core.STORAGE_KEY. Nothing is
 * sent anywhere: statement files are read with the File API and parsed
 * on this device, and the calendar file is generated as a Blob. All
 * math is delegated to core.js (window.RenewalCore) so the UI and the
 * tests share one implementation.
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
  var renewTargetId = null;
  var pendingProposals = [];
  var expandedHistory = {};
  var priceNotes = {};
  var reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  function monogram(item, sizeClass) {
    var tile = el('span', 'monogram' + (sizeClass ? ' ' + sizeClass : ''));
    var letter = (item.name || '?').trim().charAt(0).toUpperCase() || '?';
    tile.textContent = letter;
    tile.style.background = Core.categoryColor(item.category);
    tile.setAttribute('aria-hidden', 'true');
    return tile;
  }

  /* ---------------- count-up animation ---------------- */

  // Animate a money figure from 0 to its target over about 650 ms.
  // With prefers-reduced-motion, or when the browser has no
  // requestAnimationFrame, the final value is set immediately.
  function animateMoney(node, target, currency) {
    if (node._animFrame) window.cancelAnimationFrame(node._animFrame);
    if (reduceMotion || typeof window.requestAnimationFrame !== 'function') {
      node.textContent = fmtMoney(target, currency);
      return;
    }
    var start = null;
    var duration = 650;
    function frame(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = fmtMoney(target * eased, currency);
      if (t < 1) {
        node._animFrame = window.requestAnimationFrame(frame);
      } else {
        node.textContent = fmtMoney(target, currency);
        node._animFrame = null;
      }
    }
    node._animFrame = window.requestAnimationFrame(frame);
  }

  function animateCount(node, target) {
    if (node._animFrame) window.cancelAnimationFrame(node._animFrame);
    if (reduceMotion || typeof window.requestAnimationFrame !== 'function') {
      node.textContent = String(target);
      return;
    }
    var start = null;
    var duration = 650;
    function frame(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = String(Math.round(target * eased));
      if (t < 1) {
        node._animFrame = window.requestAnimationFrame(frame);
      } else {
        node.textContent = String(target);
        node._animFrame = null;
      }
    }
    node._animFrame = window.requestAnimationFrame(frame);
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
      }, 6000);
    }
  }

  function hideBanner() {
    $('banner').hidden = true;
  }

  /* ---------------- hero and stats ---------------- */

  function renderHero(today) {
    var totals = Core.computeTotals(items, today);
    var box = $('heroMonthly');
    box.textContent = '';
    var currencies = Object.keys(totals.byCurrency).sort();
    if (!currencies.length) {
      var zero = el('div', 'hero-line');
      var zeroAmt = el('span', 'hero-amount', '0');
      zero.appendChild(zeroAmt);
      box.appendChild(zero);
    }
    currencies.forEach(function (cur) {
      var line = el('div', 'hero-line');
      var amt = el('span', 'hero-amount');
      line.appendChild(amt);
      line.appendChild(el('span', 'hero-cur', cur + ' / month'));
      box.appendChild(line);
      animateMoney(amt, totals.byCurrency[cur].monthly, cur);
    });

    var spot = $('heroSpotlight');
    spot.textContent = '';
    var entries = Core.renewingSoon(items, today);
    if (!entries.length) {
      spot.appendChild(el('p', 'spot-none', 'Nothing is due soon. Enjoy the quiet.'));
      return;
    }
    var next = entries[0];
    var card = el('div', 'spot-card');
    card.appendChild(monogram(next.item, 'monogram-lg'));
    var main = el('div', 'spot-main');
    main.appendChild(el('div', 'spot-name', next.item.name));
    main.appendChild(
      el('div', 'spot-meta', fmtDate(next.date) + ' · ' + next.item.category)
    );
    card.appendChild(main);
    var side = el('div', 'spot-side');
    side.appendChild(el('div', 'spot-amount', fmtMoney(next.item.amount, next.item.currency)));
    side.appendChild(el('span', 'badge badge-' + next.badge, badgeText(next)));
    card.appendChild(side);
    spot.appendChild(card);
  }

  function statLines(container, byCurrency, key, animate) {
    container.textContent = '';
    var currencies = Object.keys(byCurrency);
    if (!currencies.length) {
      var line = el('div', 'stat-line');
      line.appendChild(el('span', 'stat-amount', '0'));
      container.appendChild(line);
      return;
    }
    currencies.sort().forEach(function (cur) {
      var line = el('div', 'stat-line');
      var amt = el('span', 'stat-amount');
      line.appendChild(amt);
      line.appendChild(el('span', 'stat-cur', cur));
      container.appendChild(line);
      if (animate) animateMoney(amt, byCurrency[cur][key], cur);
      else amt.textContent = fmtMoney(byCurrency[cur][key], cur);
    });
  }

  function renderStats(today) {
    var totals = Core.computeTotals(items, today);
    statLines($('statYearly'), totals.byCurrency, 'yearly', true);
    statLines($('statDue'), totals.byCurrency, 'due30', true);
    var active = $('statActive');
    active.textContent = '';
    var line = el('div', 'stat-line');
    var num = el('span', 'stat-amount');
    line.appendChild(num);
    active.appendChild(line);
    animateCount(num, totals.activeCount);
  }

  /* ---------------- timeline (next 30 days) ---------------- */

  function renderTimeline(today) {
    var strip = $('timeline');
    strip.textContent = '';
    var charges = Core.upcomingCharges(items, today, 30).filter(function (c) {
      return c.daysLeft >= 0;
    });
    $('timelineEmpty').hidden = charges.length > 0;
    strip.hidden = charges.length === 0;
    if (!charges.length) return;

    var byDate = {};
    charges.forEach(function (c) {
      (byDate[c.date] || (byDate[c.date] = [])).push(c);
    });

    var track = el('div', 'timeline-track');
    Object.keys(byDate)
      .sort()
      .forEach(function (date, idx) {
        var dayCharges = byDate[date];
        var daysLeft = dayCharges[0].daysLeft;
        var biggest = dayCharges.slice().sort(function (a, b) {
          return b.amount - a.amount;
        })[0];
        var marker = el('div', 'tl-marker' + (idx % 2 ? ' tl-alt' : ''));
        var pct = Math.max(2, Math.min(98, (daysLeft / 30) * 100));
        marker.style.left = pct + '%';
        var dot = el('span', 'tl-dot');
        dot.style.background = Core.categoryColor(biggest.category);
        marker.appendChild(dot);
        var totals = {};
        dayCharges.forEach(function (c) {
          totals[c.currency] = (totals[c.currency] || 0) + c.amount;
        });
        var totalText = Object.keys(totals)
          .sort()
          .map(function (cur) {
            return fmtMoney(totals[cur], cur);
          })
          .join(' · ');
        marker.appendChild(el('span', 'tl-amount', totalText));
        marker.appendChild(el('span', 'tl-date', fmtDate(date)));
        marker.title = dayCharges
          .map(function (c) {
            return c.name + ': ' + fmtMoney(c.amount, c.currency);
          })
          .join('\n');
        track.appendChild(marker);
      });
    strip.appendChild(track);

    var axis = el('div', 'tl-axis');
    axis.appendChild(el('span', null, 'Today'));
    axis.appendChild(el('span', null, '15 days'));
    axis.appendChild(el('span', null, '30 days'));
    strip.appendChild(axis);
  }

  /* ---------------- renewing soon and breakdown ---------------- */

  function renderSoon(today) {
    var list = $('soonList');
    list.textContent = '';
    var entries = Core.renewingSoon(items, today);
    $('soonEmpty').hidden = entries.length > 0;
    entries.slice(0, 8).forEach(function (entry) {
      var item = entry.item;
      var row = el('li', 'soon-row');
      row.appendChild(monogram(item));
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
      var color = Core.categoryColor(row.category);
      var wrap = el('div', 'bar-row');
      var head = el('div', 'bar-head');
      var label = el('span', 'bar-label');
      var dot = el('span', 'cat-dot');
      dot.style.background = color;
      label.appendChild(dot);
      label.appendChild(el('span', null, row.category));
      head.appendChild(label);
      head.appendChild(
        el('span', 'bar-amount', fmtMoney(row.monthly, breakdownCurrency) + ' / mo · ' + Math.round(row.share) + '%')
      );
      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill');
      fill.style.width = Math.max(2, Math.round(row.share)) + '%';
      fill.style.background = color;
      track.appendChild(fill);
      wrap.appendChild(head);
      wrap.appendChild(track);
      bars.appendChild(wrap);
    });
  }

  /* ---------------- upcoming charges ---------------- */

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
        var nameWrap = el('span', 'charge-name');
        var dot = el('span', 'cat-dot');
        dot.style.background = Core.categoryColor(charge.category);
        nameWrap.appendChild(dot);
        nameWrap.appendChild(el('span', null, charge.name));
        row.appendChild(nameWrap);
        row.appendChild(el('span', 'charge-amount', fmtMoney(charge.amount, charge.currency)));
        group.appendChild(row);
      });
      container.appendChild(group);
    });
  }

  /* ---------------- items list ---------------- */

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
      row.appendChild(monogram(item, 'monogram-lg'));

      var main = el('div', 'item-main');
      var top = el('div', 'item-top');
      top.appendChild(el('span', 'item-name', item.name));
      var catChip = el('span', 'item-cat');
      var color = Core.categoryColor(item.category);
      catChip.style.borderColor = color;
      catChip.style.color = color;
      catChip.textContent = item.category;
      top.appendChild(catChip);
      if (item.status === 'paused') top.appendChild(el('span', 'item-paused-tag', 'Paused'));
      if (priceNotes[item.id]) {
        top.appendChild(el('span', 'price-tag', priceNotes[item.id]));
      }
      main.appendChild(top);

      var next = Core.effectiveNext(item, today);
      var meta = 'Next: ' + fmtDate(next);
      if (item.cycle !== 'one-time') meta += ' (stored date ' + fmtDate(item.nextDate) + ')';
      if (item.paymentLabel) meta += ' · ' + item.paymentLabel;
      main.appendChild(el('div', 'item-meta', meta));
      if (item.notes) main.appendChild(el('div', 'item-notes', item.notes));

      var history = Array.isArray(item.history) ? item.history : [];
      var histBox = el('div', 'history-box');
      histBox.hidden = !expandedHistory[item.id];
      if (!history.length) {
        histBox.appendChild(el('p', 'muted-note', 'No payments recorded yet. Use Mark renewed when this charge lands.'));
      } else {
        var hList = el('ul', 'history-list');
        history.forEach(function (h) {
          var hRow = el('li', 'history-row');
          hRow.appendChild(el('span', null, fmtDate(h.date)));
          hRow.appendChild(el('span', 'history-amount', fmtMoney(h.amount, item.currency)));
          hList.appendChild(hRow);
        });
        histBox.appendChild(hList);
      }
      main.appendChild(histBox);
      row.appendChild(main);

      var side = el('div', 'item-side');
      side.appendChild(el('div', 'item-amount', fmtMoney(item.amount, item.currency)));
      side.appendChild(el('div', 'item-cycle', CYCLE_LABELS[item.cycle] || item.cycle));
      var actions = el('div', 'item-actions');
      if (item.status === 'active') {
        var renewBtn = el('button', 'btn btn-accent btn-small', 'Mark renewed');
        renewBtn.type = 'button';
        renewBtn.addEventListener('click', function () {
          openRenew(item);
        });
        actions.appendChild(renewBtn);
      }
      var histBtn = el('button', 'btn btn-ghost btn-small', 'History (' + history.length + ')');
      histBtn.type = 'button';
      histBtn.addEventListener('click', function () {
        expandedHistory[item.id] = !expandedHistory[item.id];
        render();
      });
      actions.appendChild(histBtn);
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
          delete priceNotes[item.id];
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
      if (cat !== 'All') {
        var dot = el('span', 'cat-dot');
        dot.style.background = Core.categoryColor(cat);
        chip.insertBefore(dot, chip.firstChild);
      }
      chip.addEventListener('click', function () {
        activeCategory = cat;
        render();
      });
      row.appendChild(chip);
    });
  }

  function buildQuickAdd(container) {
    if (!container) return;
    container.textContent = '';
    Core.QUICK_ADD.forEach(function (preset) {
      var chip = el('button', 'quick-chip');
      chip.type = 'button';
      var tile = el('span', 'monogram monogram-sm');
      tile.textContent = preset.name.charAt(0).toUpperCase();
      tile.style.background = Core.categoryColor(preset.category);
      tile.setAttribute('aria-hidden', 'true');
      chip.appendChild(tile);
      chip.appendChild(el('span', null, preset.name));
      chip.addEventListener('click', function () {
        openModal(null, preset);
      });
      container.appendChild(chip);
    });
  }

  function render() {
    var today = Core.todayStr();
    var hasItems = items.length > 0;
    $('emptyState').hidden = hasItems;
    $('dashboard').hidden = !hasItems;
    if (!hasItems) return;
    renderHero(today);
    renderStats(today);
    renderTimeline(today);
    renderSoon(today);
    renderBreakdown();
    renderUpcoming(today);
    renderChips();
    renderItems(today);
  }

  /* ---------------- item form modal ---------------- */

  function fillSelect(select, values, labels) {
    select.textContent = '';
    values.forEach(function (v) {
      var opt = el('option', null, labels ? labels[v] : v);
      opt.value = v;
      select.appendChild(opt);
    });
  }

  function openModal(item, preset) {
    var form = $('itemForm');
    form.reset();
    $('formErrors').hidden = true;
    $('fId').value = item ? item.id : '';
    $('formTitle').textContent = item ? 'Edit item' : 'Add item';
    $('typicalHint').hidden = !preset;
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
      $('fCurrency').value = preset ? preset.currency : 'INR';
      $('fCycle').value = preset ? preset.cycle : 'monthly';
      $('fCategory').value = preset ? preset.category : 'Other';
      $('fStatus').value = 'active';
      $('fNextDate').value = Core.todayStr();
      if (preset) {
        $('fName').value = preset.name;
        $('fAmount').value = preset.amount;
        $('fNextDate').value = Core.addCycle(Core.todayStr(), preset.cycle, 1);
      }
    }
    $('modalOverlay').hidden = false;
    $('fName').focus();
  }

  function closeModal() {
    $('modalOverlay').hidden = true;
  }

  function onFormSubmit(event) {
    event.preventDefault();
    var existingItem = null;
    items.forEach(function (it) {
      if (it.id === $('fId').value) existingItem = it;
    });
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
      notes: $('fNotes').value,
      history: existingItem && Array.isArray(existingItem.history) ? existingItem.history : []
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

  /* ---------------- mark as renewed ---------------- */

  function openRenew(item) {
    renewTargetId = item.id;
    $('renewItemName').textContent = item.name + ' · tracked at ' + fmtMoney(item.amount, item.currency) + ' ' + (CYCLE_LABELS[item.cycle] || '');
    $('rDate').value = Core.todayStr();
    $('rAmount').value = item.amount;
    $('renewErrors').hidden = true;
    $('renewOverlay').hidden = false;
    $('rAmount').focus();
  }

  function closeRenew() {
    $('renewOverlay').hidden = true;
    renewTargetId = null;
  }

  function onRenewSubmit(event) {
    event.preventDefault();
    var item = null;
    items.forEach(function (it) {
      if (it.id === renewTargetId) item = it;
    });
    if (!item) {
      closeRenew();
      return;
    }
    var result = Core.markRenewed(
      item,
      { date: $('rDate').value, amount: $('rAmount').value },
      Core.todayStr()
    );
    var errorsBox = $('renewErrors');
    if (!result.ok) {
      errorsBox.textContent = result.errors.join('\n');
      errorsBox.hidden = false;
      return;
    }
    items = items.map(function (it) {
      return it.id === item.id ? result.item : it;
    });
    expandedHistory[item.id] = true;
    var message = 'Recorded a payment of ' + fmtMoney(result.item.history[0].amount, item.currency) + ' for ' + item.name + '. Next renewal: ' + fmtDate(result.item.nextDate) + '.';
    if (result.priceChanged) {
      var note = 'Price changed: was ' + fmtMoney(result.previousAmount, item.currency) + ', now ' + fmtMoney(result.item.amount, item.currency);
      priceNotes[item.id] = note;
      message += ' ' + note + '. The tracked price has been updated.';
    }
    save();
    closeRenew();
    render();
    showBanner(message, true);
  }

  /* ---------------- statement import ---------------- */

  function guessCategory(proposal) {
    var match = null;
    Core.QUICK_ADD.forEach(function (preset) {
      var key = Core.normalizeMerchant(preset.name);
      if (key && (key === proposal.key || proposal.key.indexOf(key) !== -1)) match = preset;
    });
    return match ? match.category : 'Other';
  }

  function openReview(parsed, proposals) {
    pendingProposals = proposals;
    $('reviewSummary').textContent =
      'Read ' + parsed.rowsRead + ' rows, used ' + parsed.rowsUsed + ' money-out rows, and found ' +
      proposals.length + ' likely subscription' + (proposals.length === 1 ? '' : 's') +
      '. Nothing is added until you confirm the selection below.';
    $('reviewEmpty').hidden = proposals.length > 0;
    $('reviewAddBtn').hidden = proposals.length === 0;
    var list = $('proposalList');
    list.textContent = '';
    proposals.forEach(function (p, idx) {
      var row = el('div', 'proposal');
      var checkLabel = el('label', 'proposal-check');
      var check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = !p.alreadyTracked;
      check.dataset.idx = String(idx);
      check.className = 'p-check';
      checkLabel.appendChild(check);
      row.appendChild(checkLabel);

      row.appendChild(monogram({ name: p.name, category: guessCategory(p) }));

      var fields = el('div', 'proposal-fields');
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'p-name';
      nameInput.value = p.name;
      nameInput.maxLength = 80;
      nameInput.setAttribute('aria-label', 'Name');
      fields.appendChild(nameInput);
      var meta = p.occurrences + ' charges · about every ' + p.avgGapDays + ' days · last charged ' + fmtDate(p.lastDate);
      fields.appendChild(el('div', 'proposal-meta', meta));
      if (p.alreadyTracked) {
        fields.appendChild(el('span', 'tracked-tag', 'Already tracked'));
      }
      row.appendChild(fields);

      var amountInput = document.createElement('input');
      amountInput.type = 'number';
      amountInput.className = 'p-amount';
      amountInput.min = '0';
      amountInput.step = '0.01';
      amountInput.value = p.amount;
      amountInput.setAttribute('aria-label', 'Amount');
      row.appendChild(amountInput);

      var cycleSelect = document.createElement('select');
      cycleSelect.className = 'p-cycle';
      cycleSelect.setAttribute('aria-label', 'Billing cycle');
      Core.CYCLES.forEach(function (c) {
        var opt = el('option', null, CYCLE_NAMES[c]);
        opt.value = c;
        if (c === p.cycle) opt.selected = true;
        cycleSelect.appendChild(opt);
      });
      row.appendChild(cycleSelect);

      var dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.className = 'p-date';
      dateInput.value = p.nextDate;
      dateInput.setAttribute('aria-label', 'Next renewal date');
      row.appendChild(dateInput);

      list.appendChild(row);
    });
    $('reviewOverlay').hidden = false;
  }

  function closeReview() {
    $('reviewOverlay').hidden = true;
    pendingProposals = [];
  }

  function onReviewAdd() {
    var rows = $('proposalList').querySelectorAll('.proposal');
    var added = 0;
    var problems = [];
    rows.forEach(function (row, idx) {
      var check = row.querySelector('.p-check');
      if (!check || !check.checked) return;
      var p = pendingProposals[idx];
      var result = Core.validateItem({
        name: row.querySelector('.p-name').value,
        amount: row.querySelector('.p-amount').value,
        currency: p.currency,
        cycle: row.querySelector('.p-cycle').value,
        category: guessCategory(p),
        nextDate: row.querySelector('.p-date').value,
        status: 'active',
        notes: 'Added from a bank statement import'
      });
      if (result.ok) {
        items.push(result.value);
        added += 1;
      } else {
        problems.push(p.name + ': ' + result.errors.join(' '));
      }
    });
    if (problems.length) {
      showBanner('Some subscriptions could not be added. ' + problems.join(' '), false);
    }
    if (added) {
      save();
      render();
      showBanner('Added ' + added + ' subscription' + (added === 1 ? '' : 's') + ' from your statement.', true);
    }
    if (added || !problems.length) closeReview();
  }

  function handleStatementFile(file) {
    if (!file) return;
    file
      .text()
      .then(function (text) {
        var parsed = Core.parseStatementCSV(text);
        if (!parsed.ok) {
          showBanner('Statement import failed: ' + parsed.error, false);
          return;
        }
        var proposals = Core.detectRecurring(parsed.transactions, items);
        openReview(parsed, proposals);
      })
      .catch(function () {
        showBanner('Statement import failed: the file could not be read.', false);
      });
  }

  /* ---------------- calendar export ---------------- */

  function download(filename, content, type) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function onCalendar() {
    var hasActive = items.some(function (i) {
      return i.status === 'active';
    });
    if (!hasActive) {
      showBanner('No active items to put on a calendar yet. Add a subscription first.', false);
      return;
    }
    var ics = Core.generateICS(items, Core.todayStr());
    download('renewalradar-reminders.ics', ics, 'text/calendar');
    showBanner('Calendar file downloaded. Import it into Google Calendar, Apple Calendar, or Outlook and each renewal will remind you 3 days ahead.', true);
  }

  /* ---------------- data actions ---------------- */

  function onExport() {
    var payload = {
      app: 'renewalradar',
      version: 1,
      exportedAt: new Date().toISOString(),
      items: items
    };
    download('renewalradar-export.json', JSON.stringify(payload, null, 2), 'application/json');
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
    priceNotes = {};
    expandedHistory = {};
    save();
    render();
    showBanner('All data cleared.', true);
  }

  function onDemo() {
    if (items.length && !window.confirm('Load demo data? This replaces your current items.')) return;
    items = Core.demoItems(Core.todayStr());
    breakdownCurrency = null;
    priceNotes = {};
    save();
    render();
    showBanner('Demo data loaded. The 7 demo items are fictional examples.', true);
  }

  /* ---------------- init ---------------- */

  function init() {
    fillSelect($('fCurrency'), Core.CURRENCIES);
    fillSelect($('fCycle'), Core.CYCLES, CYCLE_NAMES);
    fillSelect($('fCategory'), Core.CATEGORIES);
    buildQuickAdd($('quickAddRow'));
    buildQuickAdd($('quickAddEmpty'));

    $('addBtn').addEventListener('click', function () {
      openModal(null);
    });
    $('emptyAddBtn').addEventListener('click', function () {
      openModal(null);
    });
    $('demoBtn').addEventListener('click', onDemo);
    $('exportBtn').addEventListener('click', onExport);
    $('calendarBtn').addEventListener('click', onCalendar);
    $('importFile').addEventListener('change', onImportFile);
    $('clearBtn').addEventListener('click', onClear);
    $('cancelBtn').addEventListener('click', closeModal);
    $('itemForm').addEventListener('submit', onFormSubmit);
    $('modalOverlay').addEventListener('click', function (event) {
      if (event.target === $('modalOverlay')) closeModal();
    });
    $('renewForm').addEventListener('submit', onRenewSubmit);
    $('renewCancelBtn').addEventListener('click', closeRenew);
    $('renewOverlay').addEventListener('click', function (event) {
      if (event.target === $('renewOverlay')) closeRenew();
    });
    $('reviewCancelBtn').addEventListener('click', closeReview);
    $('reviewAddBtn').addEventListener('click', onReviewAdd);
    $('reviewOverlay').addEventListener('click', function (event) {
      if (event.target === $('reviewOverlay')) closeReview();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!$('modalOverlay').hidden) closeModal();
      if (!$('renewOverlay').hidden) closeRenew();
      if (!$('reviewOverlay').hidden) closeReview();
    });

    var dropZone = $('dropZone');
    var statementFile = $('statementFile');
    dropZone.addEventListener('click', function () {
      statementFile.click();
    });
    dropZone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        statementFile.click();
      }
    });
    statementFile.addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = '';
      handleStatementFile(file);
    });
    ['dragenter', 'dragover'].forEach(function (name) {
      dropZone.addEventListener(name, function (event) {
        event.preventDefault();
        dropZone.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      dropZone.addEventListener(name, function (event) {
        event.preventDefault();
        dropZone.classList.remove('dragging');
      });
    });
    dropZone.addEventListener('drop', function (event) {
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      handleStatementFile(file);
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
