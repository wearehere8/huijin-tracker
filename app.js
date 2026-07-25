/* 汇金证金及其关联公司持仓追踪 app.js
 * 五联 SVG 图表、区间缩放/平移、tooltip/crosshair、
 * ETF 列表与分组、区间趋势看板（含分位）、移动端响应式。
 * 数据来自内嵌的 window.APP_DATA（由 refresh_data.py 刷新生成）。
 */
(function () {
  "use strict";

  const APP_DATA = window.APP_DATA || { universe: [], groups: [], etfs: {}, indexTurnover: {} };

  const state = {
    universe: [],
    groups: [],
    activeGroup: "全部",
    activeCode: "510330",
    payload: null,
    rows: [],
    disclosures: [],
    etfPayloadCache: {},
    indexTurnoverCache: {},
    indexTurnover: null,
    full: null,
    view: null,
    activeRangeLength: null,
    mobileView: "charts",
    forceMobileLayout: false,
    zoomDrag: null,
    axisPan: null,
    touchGesture: null,
    crosshair: null,
    trendRequestId: 0,
    timeScrollDrag: null,
    timeScrollFrame: 0,
    pendingTimeScrollView: null,
  };

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_VIEW_MS = 7 * DAY_MS;
  const SITE_NAME = APP_DATA.site_name || "汇金证金及其关联公司持仓追踪";
  const ENABLE_GROUP_AGGREGATE = true;
  const MOBILE_USER_AGENT_RE = /Mobi|Android|iPhone|iPad|iPod|MicroMessenger/i;
  const fmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
  const priceFmt = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  // 顶层两栏分类：国家队宽基ETF / 其他行业ETF（来自 data 的 categories）
  let CATEGORIES = (APP_DATA.categories || []).map((c) => c.key);
  function isCategory(g) { return CATEGORIES.indexOf(g) !== -1; }

  const els = {
    pageTitle: document.getElementById("pageTitle"),
    metaLine: document.getElementById("metaLine"),
    groupSelect: document.getElementById("groupSelect"),
    etfSelect: document.getElementById("etfSelect"),
    refreshBtn: document.getElementById("refreshBtn"),
    resetZoomBtn: document.getElementById("resetZoomBtn"),
    tipButton: document.getElementById("tipButton"),
    tipDialog: document.getElementById("tipDialog"),
    tipBackdrop: document.getElementById("tipBackdrop"),
    tipCloseBtn: document.getElementById("tipCloseBtn"),
    mobileChartsTab: document.getElementById("mobileChartsTab"),
    mobileTrendTab: document.getElementById("mobileTrendTab"),
    dateStartInput: document.getElementById("dateStartInput"),
    dateEndInput: document.getElementById("dateEndInput"),
    applyDateRangeBtn: document.getElementById("applyDateRangeBtn"),
    fullDateRangeBtn: document.getElementById("fullDateRangeBtn"),
    timeScrollTrack: document.getElementById("timeScrollTrack"),
    timeScrollWindow: document.getElementById("timeScrollWindow"),
    timeHandleStart: document.getElementById("timeHandleStart"),
    timeHandleEnd: document.getElementById("timeHandleEnd"),
    timeScrollLabel: document.getElementById("timeScrollLabel"),
    scrollLatestBtn: document.getElementById("scrollLatestBtn"),
    etfList: document.getElementById("etfList"),
    rangeSummaryStrip: document.getElementById("rangeSummaryStrip"),
    chartStack: document.querySelector(".chart-stack"),
    charts: Array.from(document.querySelectorAll(".chart")),
    tooltip: document.getElementById("tooltip"),
    statusLine: document.getElementById("statusLine"),
    mDate: document.getElementById("mDate"),
    mPriceLabel: document.getElementById("mPriceLabel"),
    mPrice: document.getElementById("mPrice"),
    mTurnoverLabel: document.getElementById("mTurnoverLabel"),
    mTurnover: document.getElementById("mTurnover"),
    mSharesLabel: document.getElementById("mSharesLabel"),
    mShares: document.getElementById("mShares"),
    mHoldingRatio: document.getElementById("mHoldingRatio"),
    mHoldingValue: document.getElementById("mHoldingValue"),
    trendPanel: document.getElementById("trendPanel"),
    trendTitle: document.getElementById("trendTitle"),
    trendMeta: document.getElementById("trendMeta"),
    trendTableBody: document.getElementById("trendTableBody"),
    trendStartInput: document.getElementById("trendStartInput"),
    trendEndInput: document.getElementById("trendEndInput"),
    applyTrendRangeBtn: document.getElementById("applyTrendRangeBtn"),
    trendRecentBtn: document.getElementById("trendRecentBtn"),
    trendAggregateSummary: document.getElementById("trendAggregateSummary"),
    trendPopoutBtn: document.getElementById("trendPopoutBtn"),
    trendBackdrop: document.getElementById("trendBackdrop"),
    themeToggleBtn: document.getElementById("themeToggleBtn"),
  };

  // ---- 主题切换 ----
  const THEME_KEY = "huijin-theme";
  function applyTheme(theme) {
    const isDark = theme === "dark";
    document.body.classList.toggle("dark", isDark);
    if (els.themeToggleBtn) els.themeToggleBtn.textContent = isDark ? "日间" : "夜间";
  }
  function toggleTheme() {
    const next = document.body.classList.contains("dark") ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);
    scheduleDraw();
  }
  function initTheme() {
    let theme = null;
    try { theme = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (!theme) {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    applyTheme(theme);
  }
  initTheme();

  const trendGroupMap = {
    "宽基/沪深300": "hs300",
    "宽基/上证50": "sse50",
    "宽基/上证180": "sse180",
    "宽基/中证500": "csi500",
    "宽基/中证800": "csi800",
    "宽基/中证1000": "csi1000",
    "宽基/创业板": "chinext",
    "宽基/科创50": "star50",
    "宽基/深证100": "sz100",
    "宽基/MSCI中国A50": "hs300",
    "行业/金融(180金融)": "fin180",
    "行业/金融地产": "csifinre",
    "行业/金融科技": "csifintech",
    "行业/军工": "csimil",
    "行业/汽车": "csiauto",
    "行业/芯片": "cnchip",
    "行业/光伏": "csisolar",
    "行业/医药": "hs300med",
    "行业/医疗": "csimedical",
    "行业/酒": "csialcohol",
    "行业/食品饮料": "csifood",
    "行业/畜牧": "csilivestock",
    "行业/中概互联30": "csichina30",
    "行业/中概互联50": "csichina50",
    "行业/有色": "csinonferrous",
    "行业/钢铁": "csisteel",
    "行业/化工": "csichem",
    // "货币" 组无基准指数：indexKeyForGroup 返回 undefined，5th 图仅显示净申赎金额、不显示比值
  };

  const mobileLayoutQuery = window.matchMedia("(max-width: 760px)");
  const coarsePointerQuery = window.matchMedia("(pointer: coarse)");
  const TREND_PERCENTILE_START_DATE = "2024-01-01";

  const chartConfig = {
    price: { title: "日线价格走势", key: "price", benchmarkKey: "benchmark", kind: "line", format: (v) => priceFmt.format(v) },
    turnover: { title: "日度 ETF 成交额", key: "turnover", kind: "bar", floorZero: true, format: (v) => `${fmt.format(v)} 亿` },
    shares: { title: "日线 ETF 份额走势", key: "shares", kind: "line", format: (v) => `${fmt.format(v)} 亿份` },
    flow: { title: "日度 ETF 申购赎回份额", key: "flow", kind: "signedBar", symmetric: true, format: (v) => `${fmt.format(v)} 亿份` },
    flowImpact: { title: "净申购金额 / 指数成交额", key: "flowImpact", kind: "signedBar", symmetric: true, emptyText: "当前分组暂未配置指数成交额分母", format: (v) => formatSignedPct(v, 2) },
  };

  function defined(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }
  function svgEl(tag, attrs) {
    attrs = attrs || {};
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }
  function setStatus(text) {
    if (els.statusLine) els.statusLine.textContent = text || "";
  }
  function isMobileLayout() {
    return mobileLayoutQuery.matches || coarsePointerQuery.matches || state.forceMobileLayout;
  }
  function syncMobileDeviceFlag() {
    state.forceMobileLayout = MOBILE_USER_AGENT_RE.test(navigator.userAgent || "");
    document.body.classList.toggle("is-mobile-device", isMobileLayout());
  }
  function setMobileView(view) {
    state.mobileView = view === "trend" ? "trend" : "charts";
    document.body.classList.toggle("mobile-trend-view", isMobileLayout() && state.mobileView === "trend");
    if (els.mobileChartsTab) els.mobileChartsTab.classList.toggle("is-active", state.mobileView === "charts");
    if (els.mobileTrendTab) els.mobileTrendTab.classList.toggle("is-active", state.mobileView === "trend");
    if (state.mobileView === "charts") draw();
  }
  function syncResponsiveLayout() {
    syncMobileDeviceFlag();
    if (!isMobileLayout()) {
      document.body.classList.remove("mobile-trend-view");
      return;
    }
    if (els.trendPanel && els.trendPanel.classList.contains("is-expanded")) setTrendPopout(false);
    setMobileView(state.mobileView);
  }

  function formatSignedPct(value, digits) {
    digits = digits || 2;
    if (!defined(value)) return "-";
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${number.toFixed(digits)}%`;
  }
  function formatPercentile(value) {
    if (!defined(value)) return "-";
    return `${Number(value).toFixed(1)}%`;
  }
  function formatSignedNumber(value, suffix, digits) {
    suffix = suffix || "";
    digits = digits || 2;
    if (!defined(value)) return "-";
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${number.toFixed(digits)}${suffix}`;
  }
  function signedClass(value) {
    if (!defined(value)) return "";
    const number = Number(value);
    if (number > 0) return "cell-positive";
    if (number < 0) return "cell-negative";
    return "";
  }
  function percentileChip(value) {
    if (!defined(value)) return "-";
    const number = Number(value);
    const extra = number >= 80 ? " is-high" : number <= 20 ? " is-low" : "";
    return `<span class="percentile-chip${extra}">${number.toFixed(1)}%</span>`;
  }
  function roundOrNull(value, digits) {
    digits = digits || 4;
    if (!defined(value)) return null;
    return Number(Number(value).toFixed(digits));
  }
  function sumWindow(items, key) {
    const values = items.map((item) => item[key]).filter(defined).map(Number);
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0);
  }

  // ---- 数据访问（内嵌，替代原站 fetch）----
  function loadEtfPayload(code) {
    if (!state.etfPayloadCache[code]) {
      state.etfPayloadCache[code] = Promise.resolve(APP_DATA.etfs[code] || { meta: {}, series: [], disclosures: [] });
    }
    return state.etfPayloadCache[code];
  }
  function loadIndexTurnover(indexKey) {
    state.indexTurnover = null;
    if (!indexKey) return Promise.resolve({ meta: {}, rows: [] });
    if (!state.indexTurnoverCache[indexKey]) {
      state.indexTurnoverCache[indexKey] = Promise.resolve(APP_DATA.indexTurnover[indexKey] || { meta: { index_key: indexKey }, rows: [] });
    }
    return state.indexTurnoverCache[indexKey];
  }
  function indexTurnoverByDate(indexTurnover) {
    const byDate = {};
    for (const row of (indexTurnover && indexTurnover.rows) || []) {
      if (row.date && defined(row.turnover_yi)) byDate[row.date] = Number(row.turnover_yi);
    }
    return byDate;
  }

  // ---- 选择器 / ETF 列表 ----
  function activeEtfMeta() {
    if (isAggregateCode(state.activeCode)) return aggregateMetaForGroup(aggregateGroupFromCode(state.activeCode));
    return state.universe.find((item) => item.code === state.activeCode) || null;
  }
  function filteredUniverse() {
    if (state.activeGroup === "全部") return state.universe;
    if (isCategory(state.activeGroup)) return state.universe.filter((item) => item.category === state.activeGroup);
    return state.universe.filter((item) => item.display_group === state.activeGroup);
  }
  const AGGREGATE_CODE_PREFIX = "__aggregate__:";
  function aggregateCodeForGroup(group) {
    return `${AGGREGATE_CODE_PREFIX}${encodeURIComponent(group || "")}`;
  }
  function isAggregateCode(code) {
    return String(code || "").startsWith(AGGREGATE_CODE_PREFIX);
  }
  function aggregateGroupFromCode(code) {
    return decodeURIComponent(String(code || "").slice(AGGREGATE_CODE_PREFIX.length));
  }
  function eligibleEtfsForGroup(group) {
    if (isCategory(group)) return state.universe.filter((item) => item.category === group && item.dashboard_eligible);
    return state.universe.filter((item) => item.display_group === group && item.dashboard_eligible);
  }
  function aggregateLabelForGroup(group) {
    return `${trendLabelForGroup(group)}ETF合计`;
  }
  function trendLabelForGroup(group) {
    if (!group) return "当前分组";
    return group.includes("/") ? group.split("/").at(-1) : group;
  }
  function indexKeyForGroup(group) {
    return trendGroupMap[group || ""];
  }
  function aggregateHoldingStats(items) {
    let combinedValue = 0;
    let ratioValue = 0;
    let denominator = 0;
    let hasValue = false;
    for (const item of items) {
      const value = defined(item.latest_combined_value_yi) ? Number(item.latest_combined_value_yi) : null;
      const ratio = defined(item.latest_combined_ratio_pct) ? Number(item.latest_combined_ratio_pct) : null;
      if (defined(value)) {
        combinedValue += value;
        hasValue = true;
      }
      if (defined(value) && defined(ratio) && ratio > 0) {
        ratioValue += value;
        denominator += value / (ratio / 100);
      }
    }
    return { combinedValue: hasValue ? combinedValue : null, combinedRatio: denominator > 0 ? (ratioValue / denominator) * 100 : null };
  }
  function aggregateMetaForGroup(group) {
    const items = eligibleEtfsForGroup(group);
    if (!ENABLE_GROUP_AGGREGATE || !indexKeyForGroup(group) || !items.length) return null;
    const stats = aggregateHoldingStats(items);
    return {
      code: "合计",
      aggregate_code: aggregateCodeForGroup(group),
      name: aggregateLabelForGroup(group),
      display_group: group,
      latest_report_date: items.map((i) => i.latest_report_date).filter(Boolean).sort().at(-1) || null,
      latest_combined_ratio_pct: stats.combinedRatio,
      latest_combined_value_yi: stats.combinedValue,
      holder_rows: items.reduce((sum, item) => sum + (Number(item.holder_rows) || 0), 0),
      manager: "合计",
      dashboard_eligible: true,
      is_aggregate: true,
      data_notes: "当前指数分组下 ETF 合计",
    };
  }
  function selectorItems() {
    const items = filteredUniverse();
    if (state.activeGroup === "全部") return items;
    const aggregate = aggregateMetaForGroup(state.activeGroup);
    return aggregate ? [aggregate, ...items] : items;
  }
  function renderSelectors() {
    const groups = ["全部", ...CATEGORIES];
    els.groupSelect.innerHTML = groups.map((group) => `<option value="${group}">${group}</option>`).join("");
    els.groupSelect.value = state.activeGroup;
    renderEtfOptions();
  }
  function renderEtfOptions() {
    const items = selectorItems();
    els.etfSelect.innerHTML = items
      .map((item) => {
        const code = item.aggregate_code || item.code;
        const prefix = item.is_aggregate ? "合计" : item.code;
        const suffix = item.dashboard_eligible || item.is_aggregate ? "" : " · 缺份额";
        return `<option value="${code}">${prefix} ${item.name}${suffix}</option>`;
      })
      .join("");
    if (!items.some((item) => (item.aggregate_code || item.code) === state.activeCode)) {
      const fallback = items.find((item) => item.is_aggregate) || items.find((item) => item.dashboard_eligible) || items[0];
      if (fallback) state.activeCode = fallback.aggregate_code || fallback.code;
    }
    els.etfSelect.value = state.activeCode;
    renderEtfList();
  }
  function renderEtfList() {
    const items = selectorItems();
    els.etfList.innerHTML = "";
    if (state.activeGroup === "全部") {
      for (const cat of CATEGORIES) {
        const sub = items.filter((item) => item.category === cat);
        if (!sub.length) continue;
        const head = document.createElement("div");
        head.className = "etf-section-head";
        head.textContent = cat;
        els.etfList.appendChild(head);
        for (const item of sub) appendEtfRow(item);
      }
    } else {
      for (const item of items) appendEtfRow(item);
    }
  }
  function appendEtfRow(item) {
    const code = item.aggregate_code || item.code;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `etf-row${item.is_aggregate ? " is-aggregate" : ""}${code === state.activeCode ? " is-active" : ""}`;
    button.dataset.code = code;
    button.innerHTML = `
      <span class="etf-name">${item.name}</span>
      <span class="etf-code">${item.is_aggregate ? "合计" : item.code}</span>
      <span class="etf-note">${item.latest_combined_ratio_pct === 0 ? "国家队未持仓" : `${defined(item.latest_combined_ratio_pct) ? fmt.format(item.latest_combined_ratio_pct) : "-"}${defined(item.latest_combined_value_yi) ? " · " + fmt.format(item.latest_combined_value_yi) + " 亿" : ""}`}</span>
      <span class="etf-note">${item.is_aggregate ? "分组合计" : item.dashboard_eligible ? item.display_group : "待补份额"}</span>
    `;
    button.addEventListener("click", () => selectEtf(code));
    els.etfList.appendChild(button);
  }

  // ---- 序列解析 ----
  function flowAmountPrice(row, fallbackPrice) {
    if (defined(row && row.etf_qfq_avg_price_est)) return Number(row.etf_qfq_avg_price_est);
    if (defined(row && row.avg_price)) return Number(row.avg_price);
    return defined(fallbackPrice) ? Number(fallbackPrice) : null;
  }
  function estimateFlowAmount(row, deltaUnits, fallbackPrice) {
    const price = flowAmountPrice(row, fallbackPrice);
    return defined(deltaUnits) && defined(price) ? Number(deltaUnits) * Number(price) : null;
  }
  function latestRowWith(key) {
    for (let i = state.rows.length - 1; i >= 0; i -= 1) {
      if (defined(state.rows[i][key])) return state.rows[i];
    }
    return null;
  }
  function latestDisclosure() {
    if (!state.disclosures.length) return null;
    return state.disclosures.slice().sort((a, b) => a.t - b.t).at(-1);
  }

  function parsePayload(payload, indexTurnover) {
    state.payload = payload;
    state.activeRangeLength = null;
    state.crosshair = null;
    const turnoverByDate = indexTurnoverByDate(indexTurnover);
    state.rows = (payload.series || [])
      .map((row) => {
        const t = new Date(`${row.date}T00:00:00`).getTime();
        const price = defined(row.etf_qfq_close) ? Number(row.etf_qfq_close) : null;
        const flow = defined(row.qfq_delta_units_yi) ? Number(row.qfq_delta_units_yi) : null;
        const rawFlowAmount = defined(row.flow_amount_yi) ? Number(row.flow_amount_yi) : null;
        const flowAmount = defined(rawFlowAmount) ? rawFlowAmount : estimateFlowAmount(row, flow, price);
        const idxTurn = defined(turnoverByDate[row.date]) ? Number(turnoverByDate[row.date]) : null;
        const flowImpact = defined(flowAmount) && defined(idxTurn) && idxTurn !== 0 ? (flowAmount / idxTurn) * 100 : null;
        return {
          date: row.date,
          t,
          price,
          turnover: defined(row.etf_qfq_turnover_est_yi) ? Number(row.etf_qfq_turnover_est_yi) : null,
          shares: defined(row.qfq_total_units_yi) ? Number(row.qfq_total_units_yi) : null,
          flow,
          flowAmount,
          indexTurnover: idxTurn,
          flowImpact,
          benchmark: defined(row.benchmark_close) ? Number(row.benchmark_close) : null,
        };
      })
      .filter((row) => Number.isFinite(row.t))
      .sort((a, b) => a.t - b.t);
    addHistoryPercentiles(state.rows);
    addRollingStats(state.rows);
    state.disclosures = (payload.disclosures || [])
      .map((row) => {
        const day = row.report_date || row.date;
        const ratio = row.combined_ratio_pct != null ? row.combined_ratio_pct : row.ratio;
        const value = row.combined_value_yi != null ? row.combined_value_yi : row.value_yi;
        return {
          date: day,
          t: new Date(`${day}T00:00:00`).getTime(),
          ratio,
          ratioText: defined(ratio) ? (ratio > 0 ? `${fmt.format(Number(ratio))}%` : "国家队未持仓") : null,
          combinedValue: defined(value) ? Number(value) : null,
          totalShares: defined(row.total_shares_yi_qfq) ? Number(row.total_shares_yi_qfq) : null,
        };
      })
      .filter((row) => Number.isFinite(row.t))
      .sort((a, b) => a.t - b.t);
    if (state.rows.length) {
      const minT = Math.min(...state.rows.map((row) => row.t));
      const maxT = Math.max(...state.rows.map((row) => row.t));
      state.full = { minT, maxT };
      state.view = { minT, maxT };
    } else {
      state.full = null;
      state.view = null;
    }
    updateZoomButton();
    updateHeader();
    updateMetrics();
    renderRangeSummary();
  }

  function updateMetrics() {
    const meta = Object.assign({}, state.payload && state.payload.meta, activeEtfMeta() || {});
    const isAggregate = Boolean(meta.is_aggregate);
    const latestPrice = latestRowWith("price");
    const latestTurnover = latestRowWith("turnover");
    const latestShares = latestRowWith("shares");
    const disclosure = latestDisclosure();
    const latestDate = (latestPrice && latestPrice.date) || (latestShares && latestShares.date) || meta.latest_series_date || "-";
    if (els.mPriceLabel) els.mPriceLabel.textContent = isAggregate ? "合成价格指数" : "前复权价";
    if (els.mTurnoverLabel) els.mTurnoverLabel.textContent = isAggregate ? "合计成交额" : "复权成交额";
    if (els.mSharesLabel) els.mSharesLabel.textContent = isAggregate ? "合计复权份额" : "复权份额";
    if (els.mDate) els.mDate.textContent = latestDate;
    if (els.mPrice) els.mPrice.textContent = latestPrice ? (isAggregate ? fmt.format(latestPrice.price) : priceFmt.format(latestPrice.price)) : "-";
    if (els.mTurnover) els.mTurnover.textContent = latestTurnover ? `${fmt.format(latestTurnover.turnover)} 亿元` : "-";
    if (els.mShares) els.mShares.textContent = latestShares ? `${fmt.format(latestShares.shares)} 亿份` : "-";
    const _unheld = defined(meta.latest_combined_ratio_pct) && meta.latest_combined_ratio_pct === 0;
    let ratioText = _unheld ? "国家队未持仓" : (defined(meta.latest_combined_ratio_pct) ? `${fmt.format(meta.latest_combined_ratio_pct)}%` : "-");
    let valueText = _unheld ? "国家队未持仓" : (defined(meta.latest_combined_value_yi) ? `${fmt.format(meta.latest_combined_value_yi)} 亿元` : "-");
    if (disclosure && disclosure.ratioText && !_unheld) ratioText = disclosure.ratioText;
    if (defined(disclosure && disclosure.combinedValue) && !_unheld) valueText = `${fmt.format(disclosure.combinedValue)} 亿元`;
    if (els.mHoldingRatio) els.mHoldingRatio.textContent = ratioText;
    if (els.mHoldingValue) els.mHoldingValue.textContent = valueText;
  }

  function updateHeader() {
    const meta = Object.assign({}, state.payload && state.payload.meta, activeEtfMeta() || {});
    const etfTitle = meta.is_aggregate ? meta.name || aggregateLabelForGroup(meta.display_group) : `${meta.code || state.activeCode} ${meta.name || ""}`.trim();
    if (els.pageTitle) els.pageTitle.textContent = etfTitle;
    document.title = etfTitle ? `${etfTitle} | ${SITE_NAME}` : SITE_NAME;
    const bits = [
      meta.display_group,
      meta.latest_report_date ? `披露日 ${meta.latest_report_date}` : null,
      meta.data_refreshed_at ? `刷新 ${meta.data_refreshed_at}` : null,
      "净申赎金额：份额变化×ETF成交均价估算",
    ].filter(Boolean);
    if (els.metaLine) els.metaLine.textContent = bits.join(" · ") || SITE_NAME;
  }

  // ---- 分位 / 滚动统计 ----
  function percentileFromSorted(sortedValues, value) {
    if (!defined(value) || !sortedValues.length) return null;
    const number = Number(value);
    let lo = 0;
    let hi = sortedValues.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (sortedValues[mid] <= number) lo = mid + 1;
      else hi = mid;
    }
    return (lo / sortedValues.length) * 100;
  }
  function addHistoryPercentiles(rows) {
    const baselineRows = rows.filter((row) => row.date >= "2024-01-01");
    const turnoverValues = baselineRows.map((row) => row.turnover).filter(defined).map(Number).sort((a, b) => a - b);
    const flowValues = baselineRows.map((row) => row.flow).filter(defined).map(Number).sort((a, b) => a - b);
    for (const row of rows) {
      row.turnoverPercentile = percentileFromSorted(turnoverValues, row.turnover);
      row.flowPercentile = percentileFromSorted(flowValues, row.flow);
    }
  }
  function addRollingStats(rows) {
    const windows = [["近一周", 5], ["近一月", 21], ["近三月", 63]];
    rows.forEach((row, index) => {
      row.rolling = windows.map(([label, length]) => {
        const start = Math.max(0, index - length + 1);
        const items = rows.slice(start, index + 1);
        const previousPriceRow = rows[index - length];
        const priceChange = defined(row.price) && defined(previousPriceRow && previousPriceRow.price) && Number(previousPriceRow.price) !== 0
          ? (Number(row.price) / Number(previousPriceRow.price) - 1) * 100
          : null;
        return { label, length, count: items.length, priceChange, turnover: sumWindow(items, "turnover"), flow: sumWindow(items, "flow"), flowAmount: sumWindow(items, "flowAmount") };
      });
    });
  }
  function latestSummaryRow() {
    return latestRowWith("price") || state.rows[state.rows.length - 1] || null;
  }
  function renderRangeSummary() {
    if (!els.rangeSummaryStrip) return;
    const latest = latestSummaryRow();
    if (!latest || !latest.rolling || !latest.rolling.length) {
      els.rangeSummaryStrip.innerHTML = "";
      els.rangeSummaryStrip.hidden = true;
      return;
    }
    els.rangeSummaryStrip.hidden = false;
    els.rangeSummaryStrip.innerHTML = latest.rolling
      .map((item) => {
        const isActive = state.activeRangeLength === item.length;
        const price = formatSignedPct(item.priceChange, 2);
        const turnover = defined(item.turnover) ? `${fmt.format(item.turnover)} 亿` : "-";
        const flowAmount = defined(item.flowAmount) ? formatSignedNumber(item.flowAmount, " 亿", 2) : "-";
        return `
          <button type="button" class="range-summary-item${isActive ? " is-active" : ""}" data-range-length="${item.length}">
            <span class="range-summary-title">${item.label}</span>
            <span class="range-summary-metric"><span>价格</span><strong>${price}</strong></span>
            <span class="range-summary-metric"><span>成交额</span><strong>${turnover}</strong></span>
            <span class="range-summary-metric"><span>净申赎</span><strong>${flowAmount}</strong></span>
          </button>
        `;
      })
      .join("");
  }
  function zoomToRecentWindow(length) {
    if (!state.rows.length) return;
    const rows = state.rows.filter((row) => Number.isFinite(row.t));
    if (!rows.length) return;
    const count = Math.max(1, Number(length) || 1);
    const startIndex = Math.max(0, rows.length - count);
    state.activeRangeLength = count;
    setView(rows[startIndex].t, rows[rows.length - 1].t, { keepRangeSelection: true });
  }

  // ---- 视图 / 缩放 / 平移 ----
  function dateInputValue(t) {
    if (!Number.isFinite(t)) return "";
    const date = new Date(t);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  function parseDateInput(value, endOfDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
    const suffix = endOfDay ? "T23:59:59" : "T00:00:00";
    const t = new Date(`${value}${suffix}`).getTime();
    return Number.isFinite(t) ? t : null;
  }
  function clampView(minT, maxT) {
    if (!state.full) return { minT, maxT };
    let lo = Math.min(minT, maxT);
    let hi = Math.max(minT, maxT);
    const fullRange = state.full.maxT - state.full.minT;
    let range = Math.max(hi - lo, MIN_VIEW_MS);
    if (range >= fullRange) return { minT: state.full.minT, maxT: state.full.maxT };
    if (lo < state.full.minT) {
      lo = state.full.minT;
      hi = lo + range;
    }
    if (hi > state.full.maxT) {
      hi = state.full.maxT;
      lo = hi - range;
    }
    return { minT: lo, maxT: hi };
  }
  function isFullView() {
    if (!state.full || !state.view) return true;
    return Math.abs(state.full.minT - state.view.minT) < 1000 && Math.abs(state.full.maxT - state.view.maxT) < 1000;
  }
  function updateZoomButton() {
    if (els.resetZoomBtn) els.resetZoomBtn.disabled = isFullView();
    syncDateRangeInputs();
    syncTimeScroll();
  }
  function setView(minT, maxT, options) {
    options = options || {};
    if (!options.keepRangeSelection) state.activeRangeLength = null;
    state.view = clampView(minT, maxT);
    updateZoomButton();
    draw();
    renderRangeSummary();
  }
  function resetZoom() {
    if (!state.full) return;
    state.activeRangeLength = null;
    state.view = Object.assign({}, state.full);
    updateZoomButton();
    draw();
    renderRangeSummary();
  }
  function syncDateRangeInputs() {
    if (!els.dateStartInput || !els.dateEndInput) return;
    const min = state.full && state.full.minT;
    const max = state.full && state.full.maxT;
    const hasFull = Number.isFinite(min) && Number.isFinite(max);
    for (const input of [els.dateStartInput, els.dateEndInput]) {
      input.disabled = !hasFull;
      input.min = hasFull ? dateInputValue(min) : "";
      input.max = hasFull ? dateInputValue(max) : "";
    }
    if (els.applyDateRangeBtn) els.applyDateRangeBtn.disabled = !hasFull;
    if (els.fullDateRangeBtn) els.fullDateRangeBtn.disabled = !hasFull || isFullView();
    if (!hasFull || !state.view) {
      els.dateStartInput.value = "";
      els.dateEndInput.value = "";
      return;
    }
    els.dateStartInput.value = dateInputValue(state.view.minT);
    els.dateEndInput.value = dateInputValue(state.view.maxT);
  }
  function applyDateRangeFromInputs() {
    if (!state.full || !els.dateStartInput || !els.dateEndInput) return;
    const start = parseDateInput(els.dateStartInput.value, false);
    const end = parseDateInput(els.dateEndInput.value, true);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setStatus("请选择有效的开始和结束日期。");
      syncDateRangeInputs();
      return;
    }
    if (start > end) {
      setStatus("开始日期不能晚于结束日期。");
      syncDateRangeInputs();
      return;
    }
    setView(start, end);
    setStatus("");
  }

  // ---- 时间轴拖动 ----
  function currentViewSpan() {
    if (!state.full || !state.view) return 0;
    const fullRange = state.full.maxT - state.full.minT;
    return Math.max(MIN_VIEW_MS, Math.min(fullRange, state.view.maxT - state.view.minT));
  }
  function canScrollTimeView() {
    if (!state.full || !state.view) return false;
    const fullRange = state.full.maxT - state.full.minT;
    return fullRange > MIN_VIEW_MS + 1000;
  }
  function syncTimeScroll() {
    if (!els.timeScrollTrack || !els.timeScrollWindow) return;
    const canScroll = canScrollTimeView();
    els.timeScrollTrack.classList.toggle("is-disabled", !canScroll);
    if (els.scrollLatestBtn) els.scrollLatestBtn.disabled = !canScroll;
    if (!state.full || !state.view) {
      if (els.timeScrollLabel) els.timeScrollLabel.textContent = "全区间";
      els.timeScrollWindow.style.left = "0%";
      els.timeScrollWindow.style.width = "100%";
      return;
    }
    const fullRange = Math.max(1, state.full.maxT - state.full.minT);
    const leftPct = Math.max(0, Math.min(100, ((state.view.minT - state.full.minT) / fullRange) * 100));
    const rightPct = Math.max(0, Math.min(100, ((state.view.maxT - state.full.minT) / fullRange) * 100));
    els.timeScrollWindow.style.left = `${leftPct}%`;
    els.timeScrollWindow.style.width = `${Math.max(0.8, rightPct - leftPct)}%`;
    if (els.timeScrollLabel) {
      const text = `${dateInputValue(state.view.minT)} 至 ${dateInputValue(state.view.maxT)}`;
      els.timeScrollLabel.textContent = isFullView() ? `${text} · 全区间` : text;
    }
  }
  function applyTimeScrollView(minT, maxT) {
    if (!state.full || !state.view || !canScrollTimeView()) return;
    state.activeRangeLength = null;
    state.view = clampView(minT, maxT);
    updateZoomButton();
    draw();
    renderRangeSummary();
  }
  function scheduleTimeScrollView(minT, maxT) {
    state.pendingTimeScrollView = { minT, maxT };
    if (state.timeScrollFrame) return;
    const requestFrame = window.requestAnimationFrame || ((cb) => window.setTimeout(cb, 16));
    state.timeScrollFrame = requestFrame(() => {
      state.timeScrollFrame = 0;
      if (state.pendingTimeScrollView) {
        const { minT: nMin, maxT: nMax } = state.pendingTimeScrollView;
        state.pendingTimeScrollView = null;
        applyTimeScrollView(nMin, nMax);
      }
    });
  }
  function scrollToLatestView() {
    if (!state.full || !state.view) return;
    const span = currentViewSpan();
    setView(state.full.maxT - span, state.full.maxT);
  }
  function timeForTrackClientX(clientX) {
    if (!state.full || !els.timeScrollTrack) return null;
    const rect = els.timeScrollTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return state.full.minT + ratio * (state.full.maxT - state.full.minT);
  }
  function beginTimeScrollDrag(event, mode) {
    if (!state.full || !state.view || !canScrollTimeView()) return;
    const targetTime = timeForTrackClientX(event.clientX);
    if (!Number.isFinite(targetTime)) return;
    const span = currentViewSpan();
    if (mode === "track") {
      applyTimeScrollView(targetTime - span / 2, targetTime + span / 2);
      event.preventDefault();
      return;
    }
    state.timeScrollDrag = {
      mode,
      startX: event.clientX,
      startMinT: state.view.minT,
      startMaxT: state.view.maxT,
      fullRange: state.full.maxT - state.full.minT,
      trackWidth: Math.max(1, els.timeScrollTrack.getBoundingClientRect().width),
    };
    els.timeScrollWindow.classList.add("is-dragging");
    if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function updateTimeScrollDrag(event) {
    const drag = state.timeScrollDrag;
    if (!drag || !state.full) return false;
    const deltaT = ((event.clientX - drag.startX) / drag.trackWidth) * drag.fullRange;
    let minT = drag.startMinT;
    let maxT = drag.startMaxT;
    if (drag.mode === "start") minT = Math.max(state.full.minT, Math.min(drag.startMaxT - MIN_VIEW_MS, drag.startMinT + deltaT));
    else if (drag.mode === "end") maxT = Math.min(state.full.maxT, Math.max(drag.startMinT + MIN_VIEW_MS, drag.startMaxT + deltaT));
    else {
      minT = drag.startMinT + deltaT;
      maxT = drag.startMaxT + deltaT;
    }
    scheduleTimeScrollView(minT, maxT);
    event.preventDefault();
    return true;
  }
  function finishTimeScrollDrag() {
    if (!state.timeScrollDrag) return false;
    state.timeScrollDrag = null;
    els.timeScrollWindow.classList.remove("is-dragging");
    return true;
  }

  // ---- 选择 ETF / 合计 ----
  async function selectEtf(code) {
    if (isAggregateCode(code)) {
      await selectAggregate(aggregateGroupFromCode(code));
      return;
    }
    state.activeCode = code;
    if (els.etfSelect) els.etfSelect.value = code;
    renderEtfList();
    if (state.activeGroup === "全部") loadTrendBoard();
    setStatus("读取 ETF 数据中");
    try {
      const payload = await loadEtfPayload(code);
      const indexTurnover = await loadIndexTurnover(indexKeyForGroup(activeEtfMeta() && activeEtfMeta().display_group));
      parsePayload(payload, indexTurnover);
      draw();
      const meta = payload.meta || {};
      if (!meta.dashboard_eligible || !state.rows.some((row) => defined(row.shares))) setStatus("这只 ETF 已在持仓名单中，但日度份额数据还在 backfill 队列里。");
      else setStatus("");
    } catch (error) {
      clearCharts();
      setStatus(`读取失败：${error.message}`);
    }
  }
  async function selectAggregate(group) {
    const code = aggregateCodeForGroup(group);
    state.activeCode = code;
    if (state.activeGroup !== group) {
      state.activeGroup = group;
      renderSelectors();
      loadTrendBoard();
    }
    if (els.etfSelect) els.etfSelect.value = code;
    renderEtfList();
    const etfs = eligibleEtfsForGroup(group);
    if (!etfs.length) {
      clearCharts();
      setStatus("这个分组暂时没有可合计的 ETF。");
      return;
    }
    setStatus("读取合计数据中");
    try {
      const pairs = await Promise.all(etfs.map(async (item) => ({ item, payload: await loadEtfPayload(item.code) })));
      const indexTurnover = await loadIndexTurnover(indexKeyForGroup(group));
      const payload = buildAggregatePayload(group, pairs);
      parsePayload(payload, indexTurnover);
      draw();
      setStatus("");
    } catch (error) {
      clearCharts();
      setStatus(`合计读取失败：${error.message}`);
    }
  }

  function payloadSeriesByDate(payload) {
    const byDate = {};
    let previousClose = null;
    const series = (payload.series || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const row of series) {
      const close = defined(row.etf_qfq_close) ? Number(row.etf_qfq_close) : null;
      const turnover = defined(row.etf_qfq_turnover_est_yi) ? Number(row.etf_qfq_turnover_est_yi) : null;
      const shares = defined(row.qfq_total_units_yi) ? Number(row.qfq_total_units_yi) : null;
      const flow = defined(row.qfq_delta_units_yi) ? Number(row.qfq_delta_units_yi) : null;
      const flowAmount = estimateFlowAmount(row, flow, close);
      const priceChange = defined(close) && defined(previousClose) && previousClose !== 0 ? (close / previousClose - 1) * 100 : null;
      byDate[row.date] = { close, turnover, shares, flow, flowAmount, priceChange };
      if (defined(close)) previousClose = close;
    }
    return byDate;
  }
  function buildAggregatePayload(group, pairs) {
    const meta = aggregateMetaForGroup(group) || {};
    const perEtfByDate = pairs.map(({ item, payload }) => ({ item, payload, byDate: payloadSeriesByDate(payload) }));
    const allDates = Array.from(new Set(perEtfByDate.flatMap((entry) => Object.keys(entry.byDate)))).sort();
    const series = [];
    let syntheticLevel = 100;
    for (const date of allDates) {
      const rows = perEtfByDate.map((entry) => entry.byDate[date]).filter(Boolean);
      const turnoverRows = rows.filter((row) => defined(row.turnover));
      const turnoverTotal = turnoverRows.reduce((sum, row) => sum + Number(row.turnover), 0);
      const weightedReturnRows = turnoverRows.filter((row) => defined(row.priceChange));
      const weightedTurnover = weightedReturnRows.reduce((sum, row) => sum + Number(row.turnover), 0);
      const priceChangePct = weightedTurnover > 0 ? weightedReturnRows.reduce((sum, row) => sum + Number(row.priceChange) * Number(row.turnover), 0) / weightedTurnover : null;
      const allHaveShares = rows.length === perEtfByDate.length && rows.every((row) => defined(row.shares));
      const allHaveFlow = rows.length === perEtfByDate.length && rows.every((row) => defined(row.flow));
      const allHaveFlowAmount = rows.length === perEtfByDate.length && rows.every((row) => defined(row.flowAmount));
      if (series.length === 0) syntheticLevel = 100;
      else if (defined(priceChangePct)) syntheticLevel *= 1 + Number(priceChangePct) / 100;
      series.push({
        date,
        code: "AGG",
        row_type: "aggregate",
        etf_qfq_close: syntheticLevel,
        price_change_pct: priceChangePct,
        etf_qfq_turnover_est_yi: turnoverRows.length ? turnoverTotal : null,
        qfq_total_units_yi: allHaveShares ? rows.reduce((sum, row) => sum + Number(row.shares), 0) : null,
        qfq_delta_units_yi: allHaveFlow ? rows.reduce((sum, row) => sum + Number(row.flow), 0) : null,
        flow_amount_yi: allHaveFlowAmount ? rows.reduce((sum, row) => sum + Number(row.flowAmount), 0) : null,
        benchmark_close: null,
      });
    }
    const latestDate = series[series.length - 1] ? series[series.length - 1].date : null;
    const dataRefreshedAt = pairs.map(({ payload }) => payload.meta && payload.meta.data_refreshed_at).filter(Boolean).sort().at(-1) || null;
    return {
      meta: Object.assign({}, meta, {
        code: "合计",
        name: aggregateLabelForGroup(group),
        is_aggregate: true,
        data_refreshed_at: dataRefreshedAt,
        latest_series_date: latestDate,
        price_basis: "成交额加权 ETF 日收益合成，首日=100",
        turnover_basis: "分组内 ETF 复权成交额合计",
        shares_basis: "分组内 ETF 复权份额合计；仅在全部 ETF 当日都有份额时展示",
        flow_amount_basis: "分组内各 ETF 复权份额变动 * 各自 ETF 成交均价估算后相加",
      }),
      series,
      disclosures: aggregateDisclosures(pairs),
    };
  }
  function aggregateDisclosures(pairs) {
    const byDate = {};
    for (const { payload } of pairs) {
      for (const row of payload.disclosures || []) {
        const reportDate = row.report_date || row.date;
        if (!reportDate) continue;
        if (!byDate[reportDate]) {
          byDate[reportDate] = { code: "AGG", report_date: reportDate, combined_value_yi: 0, _ratio_value_yi: 0, held_units_yi_qfq: 0, total_shares_yi_qfq: 0, holder_rows: 0, _denominator: 0, _has_value: false, _has_held_units: false, _has_total_shares: false };
        }
        const target = byDate[reportDate];
        const value = defined(row.combined_value_yi) ? Number(row.combined_value_yi) : null;
        const ratio = defined(row.combined_ratio_pct) ? Number(row.combined_ratio_pct) : null;
        if (defined(value)) {
          target.combined_value_yi += value;
          target._has_value = true;
        }
        if (defined(value) && defined(ratio) && ratio > 0) {
          target._ratio_value_yi += value;
          target._denominator += value / (ratio / 100);
        }
        if (defined(row.held_units_yi_qfq)) {
          target.held_units_yi_qfq += Number(row.held_units_yi_qfq);
          target._has_held_units = true;
        }
        if (defined(row.total_shares_yi_qfq)) {
          target.total_shares_yi_qfq += Number(row.total_shares_yi_qfq);
          target._has_total_shares = true;
        }
        target.holder_rows += Number(row.holder_rows) || 0;
      }
    }
    return Object.values(byDate)
      .map((row) => ({
        code: row.code,
        report_date: row.report_date,
        combined_ratio_pct: row._denominator > 0 ? (row._ratio_value_yi / row._denominator) * 100 : null,
        combined_value_yi: row._has_value ? row.combined_value_yi : null,
        held_units_yi_qfq: row._has_held_units ? row.held_units_yi_qfq : null,
        total_shares_yi_qfq: row._has_total_shares ? row.total_shares_yi_qfq : null,
        holder_rows: row.holder_rows,
      }))
      .sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));
  }

  // ---- 趋势看板 ----
  function activeTrendGroup() {
    if (state.activeGroup !== "全部") return state.activeGroup;
    const m = activeEtfMeta();
    return (m && m.display_group) || state.universe.find((item) => item.dashboard_eligible) || "";
  }
  function normalizeSeriesForTrend(payload) {
    let previousClose = null;
    return (payload.series || [])
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((raw) => {
        const close = defined(raw.etf_qfq_close) ? Number(raw.etf_qfq_close) : null;
        const turnover = defined(raw.etf_qfq_turnover_est_yi) ? Number(raw.etf_qfq_turnover_est_yi) : null;
        const deltaUnits = defined(raw.qfq_delta_units_yi) ? Number(raw.qfq_delta_units_yi) : null;
        const rawFlowAmount = defined(raw.flow_amount_yi) ? Number(raw.flow_amount_yi) : null;
        const flowAmount = defined(rawFlowAmount) ? rawFlowAmount : estimateFlowAmount(raw, deltaUnits, close);
        const priceChange = defined(close) && defined(previousClose) && Number(previousClose) !== 0 ? (Number(close) / Number(previousClose) - 1) * 100 : null;
        if (defined(close)) previousClose = close;
        return { date: raw.date, close, price_change_pct: priceChange, turnover_yi: turnover, delta_units_yi: deltaUnits, flow_amount_yi: flowAmount };
      })
      .filter((row) => row.date);
  }
  function buildTrendGroupHistory(etfSeries) {
    const dates = Array.from(new Set(Object.values(etfSeries).flatMap((series) => series.map((row) => row.date)))).sort();
    const byCodeDate = Object.fromEntries(Object.entries(etfSeries).map(([code, series]) => [code, Object.fromEntries(series.map((row) => [row.date, row]))]));
    const etfCount = Object.keys(byCodeDate).length;
    const out = {};
    for (const day of dates) {
      let turnoverTotal = 0;
      let weightedReturn = 0;
      let weight = 0;
      let flowTotal = 0;
      let flowCount = 0;
      for (const rowsByDate of Object.values(byCodeDate)) {
        const row = rowsByDate[day];
        if (!row) continue;
        if (defined(row.turnover_yi)) {
          turnoverTotal += Number(row.turnover_yi);
          if (defined(row.price_change_pct)) {
            weightedReturn += Number(row.price_change_pct) * Number(row.turnover_yi);
            weight += Number(row.turnover_yi);
          }
        }
        if (defined(row.flow_amount_yi)) {
          flowTotal += Number(row.flow_amount_yi);
          flowCount += 1;
        }
      }
      out[day] = {
        turnover_yi: turnoverTotal ? turnoverTotal : null,
        price_change_pct: weight ? weightedReturn / weight : null,
        flow_amount_yi: flowCount === etfCount && etfCount ? flowTotal : null,
        flow_coverage_count: flowCount,
        flow_total_count: etfCount,
      };
    }
    return out;
  }
  async function buildCustomTrendBoard(group, startDate, endDate) {
    const isCat = isCategory(group);
    const indexKey = trendGroupMap[group];
    const label = trendLabelForGroup(group);
    if (!isCat && !indexKey) return null;
    const etfs = eligibleEtfsForGroup(group);
    if (!etfs.length) return null;
    const pairs = await Promise.all(etfs.map(async (item) => ({ item, payload: await loadEtfPayload(item.code) })));
    // 每只 ETF 自身跟踪指数的成交额（按 display_group 映射）；分类视图下合计分母 = 各 ETF 自身指数成交额之和
    const perEtfTurnover = {};
    let singleMap = null;
    if (!isCat && indexKey) {
      singleMap = indexTurnoverByDate(await loadIndexTurnover(indexKey));
    }
    for (const item of etfs) {
      if (isCat) {
        const ik = trendGroupMap[item.display_group];
        perEtfTurnover[item.code] = ik ? indexTurnoverByDate(await loadIndexTurnover(ik)) : {};
      } else {
        perEtfTurnover[item.code] = singleMap || {};
      }
    }
    const etfSeries = Object.fromEntries(pairs.map(({ item, payload }) => [item.code, normalizeSeriesForTrend(payload)]));
    const groupHistory = buildTrendGroupHistory(etfSeries);
    const selectedDates = Object.keys(groupHistory).filter((day) => day >= startDate && day <= endDate && defined(groupHistory[day].turnover_yi)).sort();
    // 合计分母：分类 = 各 ETF 自身指数成交额之和；分组 = 该指数成交额
    const aggDenominator = {};
    if (isCat) {
      const allDays = Array.from(new Set(Object.values(perEtfTurnover).flatMap((m) => Object.keys(m)))).sort();
      for (const day of allDays) {
        let s = 0;
        let has = false;
        for (const item of etfs) {
          const v = perEtfTurnover[item.code] && perEtfTurnover[item.code][day];
          if (defined(v)) { s += Number(v); has = true; }
        }
        aggDenominator[day] = has ? s : null;
      }
    } else {
      for (const day of Object.keys(groupHistory)) aggDenominator[day] = singleMap ? singleMap[day] : null;
    }
    const groupTurnoverHistory = Object.entries(groupHistory).filter(([day]) => day >= TREND_PERCENTILE_START_DATE).map(([, row]) => row.turnover_yi).filter(defined).map(Number).sort((a, b) => a - b);
    const groupFlowHistory = Object.entries(groupHistory).filter(([day]) => day >= TREND_PERCENTILE_START_DATE).map(([, row]) => row.flow_amount_yi).filter(defined).map(Number).sort((a, b) => a - b);
    const histories = Object.fromEntries(pairs.map(({ item }) => {
      const series = etfSeries[item.code] || [];
      return [item.code, {
        turnover: series.filter((row) => row.date >= TREND_PERCENTILE_START_DATE).map((row) => row.turnover_yi).filter(defined).map(Number).sort((a, b) => a - b),
        deltaUnits: series.filter((row) => row.date >= TREND_PERCENTILE_START_DATE).map((row) => row.delta_units_yi).filter(defined).map(Number).sort((a, b) => a - b),
      }];
    }));
    const byCodeDate = Object.fromEntries(Object.entries(etfSeries).map(([code, series]) => [code, Object.fromEntries(series.map((row) => [row.date, row]))]));
    const rows = [];
    for (const day of selectedDates) {
      const groupDay = groupHistory[day] || {};
      const denominator = aggDenominator[day];
      const groupFlow = groupDay.flow_amount_yi;
      rows.push({
        date: day, row_type: "aggregate", code: "ALL", name: `${label}${isCat ? "合计" : "ETF合计"}`,
        price_change_pct: roundOrNull(groupDay.price_change_pct, 3),
        turnover_yi: roundOrNull(groupDay.turnover_yi, 4),
        turnover_percentile: percentileFromSorted(groupTurnoverHistory, groupDay.turnover_yi),
        delta_units_yi: null,
        delta_units_percentile: percentileFromSorted(groupFlowHistory, groupFlow),
        flow_amount_yi: roundOrNull(groupFlow, 4),
        flow_coverage_count: groupDay.flow_coverage_count,
        flow_total_count: groupDay.flow_total_count,
        flow_amount_to_index_turnover_pct: defined(groupFlow) && defined(denominator) && Number(denominator) !== 0 ? roundOrNull((Number(groupFlow) / Number(denominator)) * 100, 3) : null,
        denominator_turnover_yi: roundOrNull(denominator, 4),
      });
    }
    for (const { item } of pairs) {
      for (const day of selectedDates) {
        const row = (byCodeDate[item.code] && byCodeDate[item.code][day]) || {};
        const denominator = (perEtfTurnover[item.code] || {})[day];
        const flowAmount = row.flow_amount_yi;
        rows.push({
          date: day, row_type: "etf", code: item.code, name: item.name,
          price_change_pct: roundOrNull(row.price_change_pct, 3),
          turnover_yi: roundOrNull(row.turnover_yi, 4),
          turnover_percentile: percentileFromSorted(histories[item.code] ? histories[item.code].turnover : [], row.turnover_yi),
          delta_units_yi: roundOrNull(row.delta_units_yi, 4),
          delta_units_percentile: percentileFromSorted(histories[item.code] ? histories[item.code].deltaUnits : [], row.delta_units_yi),
          flow_amount_yi: roundOrNull(flowAmount, 4),
          flow_amount_to_index_turnover_pct: defined(flowAmount) && defined(denominator) && Number(denominator) !== 0 ? roundOrNull((Number(flowAmount) / Number(denominator)) * 100, 3) : null,
          denominator_turnover_yi: roundOrNull(denominator, 4),
        });
      }
    }
    return {
      meta: {
        index_key: isCat ? null : indexKey, index_name: label, display_group: group, is_custom_range: true,
        percentile_start_date: TREND_PERCENTILE_START_DATE,
        date_start: selectedDates[0] || startDate, date_end: selectedDates[selectedDates.length - 1] || endDate,
        etf_count: etfs.length,
        denominator_note: isCat ? "分母为该分类下各 ETF 自身跟踪指数成交额之和。" : `分母为${label}指数历史行情成交额字段，不使用 ETF 成交额合计做代理。`,
      },
      rows,
    };
  }
  function trendRowsAggregateFirst(rows) {
    // 同一组内按日期从新到旧排列：合计行在最前，下面跟该组各 ETF 的倒序日期
    const desc = (a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0);
    const aggregateRows = rows.filter((row) => row.row_type === "aggregate").sort(desc);
    const etfRows = rows.filter((row) => row.row_type !== "aggregate");
    const byCode = {};
    for (const row of etfRows) {
      (byCode[row.code] ||= []).push(row);
    }
    const sortedEtfRows = [];
    for (const code in byCode) {
      sortedEtfRows.push(...byCode[code].sort(desc));
    }
    return aggregateRows.concat(sortedEtfRows);
  }
  function renderTrendAggregateSummary(payload) {
    if (!els.trendAggregateSummary) return;
    const rows = (payload.rows || []).filter((row) => row.row_type === "aggregate");
    if (!rows.length) {
      els.trendAggregateSummary.hidden = true;
      els.trendAggregateSummary.innerHTML = "";
      return;
    }
    const meta = payload.meta || {};
    const turnover = sumWindow(rows, "turnover_yi");
    const flowAmount = sumWindow(rows, "flow_amount_yi");
    const denominator = sumWindow(rows, "denominator_turnover_yi");
    const flowRatio = defined(flowAmount) && defined(denominator) && Number(denominator) !== 0 ? (Number(flowAmount) / Number(denominator)) * 100 : null;
    const maxFlowRow = rows.filter((row) => defined(row.flow_amount_yi)).sort((a, b) => Math.abs(Number(b.flow_amount_yi)) - Math.abs(Number(a.flow_amount_yi)))[0];
    els.trendAggregateSummary.hidden = false;
    els.trendAggregateSummary.innerHTML = `
      <div class="trend-summary-main"><span>${meta.date_start || (rows[rows.length - 1] && rows[rows.length - 1].date) || "-"} 至 ${meta.date_end || (rows[0] && rows[0].date) || "-"}</span><strong>${rows[0] && rows[0].name ? rows[0].name : "ETF合计"}</strong></div>
      <div class="trend-summary-metric"><span>合计成交额</span><strong>${defined(turnover) ? `${fmt.format(turnover)} 亿` : "-"}</strong></div>
      <div class="trend-summary-metric"><span>合计净申赎</span><strong class="${signedClass(flowAmount)}">${formatSignedNumber(flowAmount, " 亿", 2)}</strong></div>
      <div class="trend-summary-metric"><span>净申赎/指数成交额</span><strong class="${signedClass(flowRatio)}">${formatSignedPct(flowRatio, 2)}</strong></div>
      <div class="trend-summary-metric"><span>最大单日净申赎</span><strong class="${signedClass(maxFlowRow && maxFlowRow.flow_amount_yi)}">${maxFlowRow ? `${maxFlowRow.date} ${formatSignedNumber(maxFlowRow.flow_amount_yi, " 亿", 2)}` : "-"}</strong></div>
    `;
  }
  function renderTrendBoard(payload) {
    const meta = payload.meta || {};
    const rangeLabel = meta.is_custom_range ? "区间趋势" : "最近一周趋势";
    const title = `${meta.index_name || "当前分组"}${rangeLabel}`;
    if (els.trendTitle) els.trendTitle.textContent = title;
    if (els.trendPanel) els.trendPanel.setAttribute("aria-label", `${title}看板`);
    const percentileStart = meta.percentile_start_date ? `分位基准：${meta.percentile_start_date}之后` : "";
    const sourceLabel = meta.is_custom_range ? "自定义区间" : "最近一周";
    if (els.trendMeta) els.trendMeta.textContent = `${sourceLabel} · ${meta.date_start || "-"} 至 ${meta.date_end || "-"} · ${percentileStart} · ${meta.denominator_note || ""}`;
    syncTrendRangeInputs(meta, false);
    renderTrendAggregateSummary(payload);
    const rows = trendRowsAggregateFirst(payload.rows || []);
    if (!rows.length) {
      if (els.trendTableBody) els.trendTableBody.innerHTML = '<tr><td colspan="9">暂无数据</td></tr>';
      return;
    }
    let lastGroupKey = "";
    els.trendTableBody.innerHTML = rows
      .map((row) => {
        const isAggregate = row.row_type === "aggregate";
        const name = isAggregate ? row.name : `<button type="button" class="trend-row-button" data-trend-code="${row.code}">${row.code} ${row.name}</button>`;
        const deltaText = isAggregate ? "金额口径" : formatSignedNumber(row.delta_units_yi, " 亿份", 2);
        const groupKey = isAggregate ? "aggregate" : row.code;
        const isGroupStart = groupKey !== lastGroupKey;
        lastGroupKey = groupKey;
        const rowClass = `${isAggregate ? "aggregate-row" : ""}${isGroupStart ? " trend-group-start" : ""}`.trim();
        return `
          <tr class="${rowClass}">
            <td data-label="ETF / 合计">${name}</td>
            <td data-label="日期">${row.date}</td>
            <td data-label="价格变动" class="${signedClass(row.price_change_pct)}">${formatSignedPct(row.price_change_pct, 2)}</td>
            <td data-label="成交额">${defined(row.turnover_yi) ? `${fmt.format(row.turnover_yi)} 亿` : "-"}</td>
            <td data-label="成交额分位">${percentileChip(row.turnover_percentile)}</td>
            <td data-label="净份额变动" class="${signedClass(row.delta_units_yi)}">${deltaText}</td>
            <td data-label="净份额分位">${percentileChip(row.delta_units_percentile)}</td>
            <td data-label="净申赎金额" class="${signedClass(row.flow_amount_yi)}">${formatSignedNumber(row.flow_amount_yi, " 亿", 2)}</td>
            <td data-label="净申赎/指数成交额" class="${signedClass(row.flow_amount_to_index_turnover_pct)}">${formatSignedPct(row.flow_amount_to_index_turnover_pct, 2)}</td>
          </tr>
        `;
      })
      .join("");
  }
  function renderUnsupportedTrendBoard(group) {
    const label = trendLabelForGroup(group);
    const title = `${label}最近一周趋势`;
    if (els.trendTitle) els.trendTitle.textContent = title;
    if (els.trendPanel) els.trendPanel.setAttribute("aria-label", `${title}看板`);
    if (els.trendMeta) els.trendMeta.textContent = "这个分组暂未配置指数趋势表；切到已配置的宽基指数分组后会自动显示。";
    if (els.trendTableBody) els.trendTableBody.innerHTML = '<tr><td colspan="9">暂无趋势表</td></tr>';
    if (els.trendAggregateSummary) {
      els.trendAggregateSummary.hidden = true;
      els.trendAggregateSummary.innerHTML = "";
    }
    syncTrendRangeInputs({}, true);
  }
  function syncTrendRangeInputs(meta, disabled) {
    if (!els.trendStartInput || !els.trendEndInput) return;
    for (const input of [els.trendStartInput, els.trendEndInput]) input.disabled = disabled;
    if (els.applyTrendRangeBtn) els.applyTrendRangeBtn.disabled = disabled;
    if (els.trendRecentBtn) els.trendRecentBtn.disabled = disabled;
    if (meta.date_start) els.trendStartInput.value = meta.date_start;
    if (meta.date_end) els.trendEndInput.value = meta.date_end;
  }
  function handleTrendTableClick(event) {
    const button = event.target.closest("[data-trend-code]");
    if (!button) return;
    const code = button.dataset.trendCode;
    const item = state.universe.find((row) => row.code === code);
    // 分类视图下，点击具体 ETF 仅切换主图，不跳出当前分类（分类不在下拉选项中）
    if (item && item.display_group && state.activeGroup !== item.display_group && !isCategory(state.activeGroup)) {
      state.activeGroup = item.display_group;
      renderSelectors();
      loadTrendBoard();
    }
    selectEtf(code);
    if (isMobileLayout()) setMobileView("charts");
  }
  function setTrendPopout(open) {
    if (open && isMobileLayout()) {
      setMobileView("trend");
      open = false;
    }
    if (els.trendPanel) els.trendPanel.classList.toggle("is-expanded", open);
    document.body.classList.toggle("trend-popout-open", open);
    if (els.trendBackdrop) els.trendBackdrop.hidden = !open;
    if (els.trendPopoutBtn) {
      els.trendPopoutBtn.textContent = open ? "收起" : "展开";
      els.trendPopoutBtn.setAttribute("aria-expanded", String(open));
    }
    if (open) {
      els.trendPanel.setAttribute("role", "dialog");
      els.trendPanel.setAttribute("aria-modal", "true");
    } else {
      els.trendPanel.removeAttribute("role");
      els.trendPanel.removeAttribute("aria-modal");
    }
  }
  function toggleTrendPopout() {
    if (isMobileLayout()) {
      setMobileView("trend");
      return;
    }
    setTrendPopout(!(els.trendPanel && els.trendPanel.classList.contains("is-expanded")));
  }
  function setTipDialog(open) {
    if (!els.tipDialog || !els.tipBackdrop || !els.tipButton) return;
    els.tipDialog.hidden = !open;
    els.tipBackdrop.hidden = !open;
    els.tipButton.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("tip-dialog-open", open);
    if (open && els.tipCloseBtn) els.tipCloseBtn.focus();
  }

  // ---- 趋势看板加载 ----
  async function buildRecentWeekTrendBoard(group) {
    const etfs = eligibleEtfsForGroup(group);
    if (!etfs.length) return null;
    const pairs = await Promise.all(etfs.map(async (item) => ({ item, payload: await loadEtfPayload(item.code) })));
    const allDates = Array.from(new Set(pairs.flatMap(({ payload }) => (payload.series || []).map((r) => r.date)))).sort();
    if (!allDates.length) return null;
    const start = allDates[Math.max(0, allDates.length - 6)];
    const end = allDates[allDates.length - 1];
    return buildCustomTrendBoard(group, start, end);
  }
  async function loadTrendBoard() {
    const requestId = state.trendRequestId + 1;
    state.trendRequestId = requestId;
    const group = activeTrendGroup();
    const indexKey = trendGroupMap[group];
    const label = trendLabelForGroup(group);
    const isCat = isCategory(group);
    if (els.trendTitle) els.trendTitle.textContent = `${label}最近一周趋势`;
    if (els.trendPanel) els.trendPanel.setAttribute("aria-label", `${label}最近一周趋势看板`);
    if (!isCat && !indexKey) {
      renderUnsupportedTrendBoard(group);
      return;
    }
    if (els.trendMeta) els.trendMeta.textContent = "读取趋势表中";
    if (els.trendTableBody) els.trendTableBody.innerHTML = '<tr><td colspan="9">读取中</td></tr>';
    try {
      const payload = await buildRecentWeekTrendBoard(group);
      if (requestId !== state.trendRequestId) return;
      if (!payload) {
        renderUnsupportedTrendBoard(group);
        return;
      }
      renderTrendBoard(payload);
    } catch (error) {
      if (requestId !== state.trendRequestId) return;
      if (els.trendMeta) els.trendMeta.textContent = `趋势表读取失败：${error.message}`;
      if (els.trendTableBody) els.trendTableBody.innerHTML = '<tr><td colspan="9">读取失败</td></tr>';
    }
  }
  async function applyTrendRangeFromInputs() {
    const group = activeTrendGroup();
    const indexKey = indexKeyForGroup(group);
    const isCat = isCategory(group);
    if (!isCat && !indexKey) {
      renderUnsupportedTrendBoard(group);
      return;
    }
    const start = parseDateInput(els.trendStartInput && els.trendStartInput.value, false);
    const end = parseDateInput(els.trendEndInput && els.trendEndInput.value, true);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      if (els.trendMeta) els.trendMeta.textContent = "请选择有效的趋势表开始和结束日期。";
      return;
    }
    if (start > end) {
      if (els.trendMeta) els.trendMeta.textContent = "趋势表开始日期不能晚于结束日期。";
      return;
    }
    const startDate = dateInputValue(start);
    const endDate = dateInputValue(end);
    const requestId = state.trendRequestId + 1;
    state.trendRequestId = requestId;
    if (els.applyTrendRangeBtn) els.applyTrendRangeBtn.disabled = true;
    if (els.trendRecentBtn) els.trendRecentBtn.disabled = true;
    if (els.trendMeta) els.trendMeta.textContent = "计算自定义区间趋势表中";
    if (els.trendTableBody) els.trendTableBody.innerHTML = '<tr><td colspan="9">计算中</td></tr>';
    try {
      const payload = await buildCustomTrendBoard(group, startDate, endDate);
      if (requestId !== state.trendRequestId) return;
      if (!payload) {
        renderUnsupportedTrendBoard(group);
        return;
      }
      renderTrendBoard(payload);
    } catch (error) {
      if (requestId !== state.trendRequestId) return;
      if (els.trendMeta) els.trendMeta.textContent = `自定义区间趋势表计算失败：${error.message}`;
      if (els.trendTableBody) els.trendTableBody.innerHTML = '<tr><td colspan="9">计算失败</td></tr>';
    } finally {
      if (requestId === state.trendRequestId) {
        if (els.applyTrendRangeBtn) els.applyTrendRangeBtn.disabled = false;
        if (els.trendRecentBtn) els.trendRecentBtn.disabled = false;
      }
    }
  }

  // ---- 图表绘制 ----
  function minMax(items, key, options) {
    options = options || {};
    const values = items.map((item) => item[key]).filter(defined).map(Number);
    if (!values.length) return [0, 1];
    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    if (options.floorZero) min = Math.min(0, min);
    if (options.symmetric) {
      const abs = Math.max(Math.abs(min), Math.abs(max));
      min = -abs;
      max = abs;
    }
    if (min === max) {
      min -= Math.abs(min || 1) * 0.1;
      max += Math.abs(max || 1) * 0.1;
    }
    const pad = (max - min) * 0.08;
    return [min - pad, max + pad];
  }
  function niceTicks(min, max, count) {
    count = count || 4;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min || 0];
    const raw = (max - min) / Math.max(1, count - 1);
    const pow = Math.pow(10, Math.floor(Math.log10(Math.abs(raw))));
    const mult = raw / pow;
    const step = (mult <= 1 ? 1 : mult <= 2 ? 2 : mult <= 5 ? 5 : 10) * pow;
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let value = start; value <= max + step * 0.5; value += step) ticks.push(value);
    return ticks.slice(0, 6);
  }
  function addMonths(dateValue, count) {
    const date = new Date(dateValue);
    date.setMonth(date.getMonth() + count);
    return date;
  }
  function tickLabel(tick, unit) {
    const date = new Date(tick);
    const yyyy = String(date.getFullYear());
    const yy = yyyy.slice(2);
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    if (unit === "year") return yyyy;
    if (unit === "quarter") return `${yy}Q${Math.floor(date.getMonth() / 3) + 1}`;
    if (unit === "month") return `${yy}-${mm}`;
    return `${mm}-${dd}`;
  }
  function startOfLocalDay(t) {
    const date = new Date(t);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }
  function addDays(dateValue, count) {
    return new Date(dateValue.getTime() + count * DAY_MS);
  }
  function alignedTickStart(minT, unit, step) {
    const start = new Date(minT);
    if (unit === "year") {
      const year = Math.floor(start.getFullYear() / step) * step;
      return new Date(year, 0, 1);
    }
    if (unit === "quarter") {
      const quarterIndex = Math.floor(start.getMonth() / 3);
      const alignedQuarter = Math.floor(quarterIndex / step) * step;
      return new Date(start.getFullYear(), alignedQuarter * 3, 1);
    }
    if (unit === "month") {
      const month = Math.floor(start.getMonth() / step) * step;
      return new Date(start.getFullYear(), month, 1);
    }
    if (unit === "week") {
      const day = startOfLocalDay(minT);
      const weekday = (day.getDay() + 6) % 7;
      return addDays(day, -weekday);
    }
    return startOfLocalDay(minT);
  }
  function advanceTick(dateValue, unit, step) {
    if (unit === "year") return addMonths(dateValue, 12 * step);
    if (unit === "quarter") return addMonths(dateValue, 3 * step);
    if (unit === "month") return addMonths(dateValue, step);
    if (unit === "week") return addDays(dateValue, 7 * step);
    return addDays(dateValue, step);
  }
  function candidateTicks(minT, maxT, candidate) {
    let cursor = alignedTickStart(minT, candidate.unit, candidate.step);
    while (cursor.getTime() < minT) cursor = advanceTick(cursor, candidate.unit, candidate.step);
    const ticks = [];
    while (cursor.getTime() <= maxT) {
      ticks.push({ t: cursor.getTime(), label: tickLabel(cursor.getTime(), candidate.labelUnit || candidate.unit) });
      cursor = advanceTick(cursor, candidate.unit, candidate.step);
    }
    return ticks;
  }
  function xTicks(minT, maxT, innerW) {
    const rangeDays = Math.max(1, (maxT - minT) / DAY_MS);
    const mobile = isMobileLayout();
    const labelWidth = mobile ? 18 : 56;
    const maxLabels = mobile ? Math.max(6, Math.min(20, Math.floor(innerW / labelWidth) + 4)) : Math.max(2, Math.floor(innerW / labelWidth));
    const candidates = [
      { unit: "day", step: 1 }, { unit: "day", step: 2 }, { unit: "day", step: 3 }, { unit: "day", step: 5 },
      { unit: "week", step: 1 }, { unit: "week", step: 2 }, { unit: "month", step: 1 }, { unit: "month", step: 2 },
      { unit: "quarter", step: 1 }, { unit: "quarter", step: 2 }, { unit: "year", step: 1 }, { unit: "year", step: 2 },
    ];
    if (rangeDays > 120) candidates.splice(0, 4);
    if (!mobile && rangeDays > 500) candidates.splice(0, 2);
    let fallback = [];
    for (const candidate of candidates) {
      const ticks = candidateTicks(minT, maxT, candidate);
      if (ticks.length) fallback = ticks;
      if (ticks.length >= 2 && ticks.length <= maxLabels) return ticks;
    }
    if (fallback.length) return fallback;
    return [{ t: minT + (maxT - minT) / 2, label: tickLabel(minT + (maxT - minT) / 2, "day") }];
  }
  function linePath(items, x, y, key) {
    let path = "";
    let open = false;
    for (const item of items) {
      if (!defined(item[key])) {
        open = false;
        continue;
      }
      path += `${open ? "L" : "M"}${x(item.t).toFixed(2)},${y(Number(item[key])).toFixed(2)}`;
      open = true;
    }
    return path;
  }
  function nearestRowIndex(targetT) {
    if (!state.rows.length) return -1;
    const pool = state.rows.filter((row) => row.t >= state.view.minT && row.t <= state.view.maxT);
    const rows = pool.length ? pool : state.rows;
    let best = rows[0];
    let dist = Math.abs(targetT - best.t);
    for (const row of rows) {
      const next = Math.abs(targetT - row.t);
      if (next < dist) {
        best = row;
        dist = next;
      }
    }
    return state.rows.indexOf(best);
  }
  function nearestRow(targetT) {
    const index = nearestRowIndex(targetT);
    return index >= 0 ? state.rows[index] : null;
  }
  function nearestShare(rowT) {
    let best = null;
    let dist = Infinity;
    for (const row of state.rows) {
      if (!defined(row.shares)) continue;
      const next = Math.abs(row.t - rowT);
      if (next < dist) {
        best = row;
        dist = next;
      }
    }
    return best;
  }
  function clearCharts() {
    state.crosshair = null;
    hideTooltip();
    for (const chart of els.charts) {
      const svg = chart.querySelector("svg");
      if (svg) svg.innerHTML = "";
    }
  }
  function drawAxis(svg, cs, y, minY, maxY, showX) {
    const ticks = niceTicks(minY, maxY, 4);
    for (const tick of ticks) {
      const yy = y(tick);
      svg.appendChild(svgEl("line", { x1: cs.left, x2: cs.left + cs.innerW, y1: yy, y2: yy, class: "grid-line" }));
      const label = svgEl("text", { x: cs.left - 8, y: yy + 4, "text-anchor": "end", class: "chart-label" });
      label.textContent = fmt.format(tick);
      svg.appendChild(label);
    }
    svg.appendChild(svgEl("line", { x1: cs.left, x2: cs.left, y1: cs.top, y2: cs.top + cs.innerH, class: "axis-line" }));
    svg.appendChild(svgEl("line", { x1: cs.left, x2: cs.left + cs.innerW, y1: cs.top + cs.innerH, y2: cs.top + cs.innerH, class: "axis-line" }));
    if (!showX) return;
    const ticksX = xTicks(state.view.minT, state.view.maxT, cs.innerW);
    const denseX = isMobileLayout() && ticksX.length > 6;
    for (const tick of ticksX) {
      const xx = cs.x(tick.t);
      svg.appendChild(svgEl("line", { x1: xx, x2: xx, y1: cs.top + cs.innerH, y2: cs.top + cs.innerH + 5, class: "axis-line" }));
      const labelY = cs.top + cs.innerH + (denseX ? 28 : 21);
      const label = svgEl("text", {
        x: xx, y: labelY, "text-anchor": denseX ? "end" : "middle",
        class: `chart-label x-axis-label${denseX ? " is-dense" : ""}`,
        transform: denseX ? `rotate(-38 ${xx} ${labelY})` : undefined,
      });
      label.textContent = tick.label;
      svg.appendChild(label);
    }
  }
  function drawEmptyChartMessage(svg, cs, text) {
    const label = svgEl("text", { x: cs.left + cs.innerW / 2, y: cs.top + cs.innerH / 2, "text-anchor": "middle", class: "empty-chart-label" });
    label.textContent = text;
    svg.appendChild(label);
  }
  function drawBars(svg, visible, cs, y, key, signed) {
    const values = visible.filter((row) => defined(row[key]));
    if (!values.length) return;
    const barCap = cs.innerW > 820 ? 24 : 18;
    const barW = Math.max(1, Math.min(barCap, (cs.innerW / Math.max(1, visible.length)) * 0.72));
    const zeroY = signed ? y(0) : cs.top + cs.innerH;
    for (const row of values) {
      const value = Number(row[key]);
      const xx = cs.x(row.t) - barW / 2;
      const yy = signed ? Math.min(y(value), zeroY) : y(value);
      const height = Math.max(1, Math.abs(zeroY - y(value)));
      svg.appendChild(svgEl("rect", { x: xx, y: yy, width: barW, height, class: signed ? (value >= 0 ? "bar-positive" : "bar-negative") : "bar-turnover" }));
    }
    if (signed) svg.appendChild(svgEl("line", { x1: cs.left, x2: cs.left + cs.innerW, y1: zeroY, y2: zeroY, class: "zero-line" }));
  }
  function chartTitle(type, config) {
    if (!state.payload || !state.payload.meta || !state.payload.meta.is_aggregate) return config.title;
    const aggregateTitles = {
      price: "合成价格走势（首日=100）", turnover: "日度 ETF 合计成交额", shares: "日线 ETF 合计份额走势",
      flow: "日度 ETF 合计申购赎回份额", flowImpact: "净申购金额 / 指数成交额",
    };
    return aggregateTitles[type] || config.title;
  }
  function drawDisclosureMarkers(svg, cs, y) {
    const markers = state.disclosures.filter((item) => item.t >= state.view.minT && item.t <= state.view.maxT);
    for (const item of markers) {
      const shareRow = nearestShare(item.t);
      if (!shareRow || !defined(shareRow.shares)) continue;
      const xx = cs.x(item.t);
      const yy = y(shareRow.shares);
      svg.appendChild(svgEl("line", { x1: xx, x2: xx, y1: cs.top, y2: cs.top + cs.innerH, class: "marker-line" }));
      svg.appendChild(svgEl("circle", { cx: xx, cy: yy, r: 4, class: "marker-dot" }));
      const label = svgEl("text", { x: Math.min(xx + 6, cs.left + cs.innerW - 42), y: Math.max(cs.top + 12, yy - 8), class: "marker-label" });
      label.textContent = item.ratioText || item.date;
      svg.appendChild(label);
    }
  }
  function drawCrosshair(svg, cs, y, type, config) {
    const cursor = state.crosshair;
    if (!cursor || isMobileLayout()) return;
    const row = state.rows[cursor.rowIndex];
    if (!row || row.t < state.view.minT || row.t > state.view.maxT) return;
    const xx = cs.x(row.t);
    const group = svgEl("g", { class: "crosshair-lines" });
    group.appendChild(svgEl("line", { x1: xx, x2: xx, y1: cs.top, y2: cs.top + cs.innerH, class: "hover-line hover-line-vertical" }));
    if (cursor.chartType === type && defined(row[config.key])) {
      const yy = y(Number(row[config.key]));
      group.appendChild(svgEl("line", { x1: cs.left, x2: cs.left + cs.innerW, y1: yy, y2: yy, class: "hover-line hover-line-horizontal" }));
      group.appendChild(svgEl("circle", { cx: xx, cy: yy, r: 3.5, class: "crosshair-dot" }));
    }
    svg.appendChild(group);
  }
  function drawChart(chart) {
    const type = chart.dataset.chart;
    const config = chartConfig[type];
    const svg = chart.querySelector("svg");
    if (!svg) return;
    svg.innerHTML = "";
    const width = Math.max(240, chart.clientWidth);
    const height = Math.max(120, chart.clientHeight);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    if (!state.view || !state.rows.length) return;
    const showX = type === "flowImpact";
    const isNarrow = width < 460;
    const margin = {
      top: 24,
      right: isNarrow ? 30 : 44,
      bottom: showX ? (isNarrow || isMobileLayout() ? 46 : 34) : 10,
      left: isNarrow ? 46 : 58,
    };
    const innerW = Math.max(40, width - margin.left - margin.right);
    const innerH = Math.max(40, height - margin.top - margin.bottom);
    const visible = state.rows.filter((row) => row.t >= state.view.minT && row.t <= state.view.maxT);
    const activeRows = visible.length ? visible : state.rows;
    const range = minMax(activeRows, config.key, config);
    const minY = range[0];
    const maxY = range[1];
    const x = (t) => margin.left + ((t - state.view.minT) / Math.max(1, state.view.maxT - state.view.minT)) * innerW;
    const y = (value) => margin.top + (1 - (value - minY) / Math.max(1e-9, maxY - minY)) * innerH;
    const cs = { left: margin.left, top: margin.top, innerW, innerH, x };
    drawAxis(svg, cs, y, minY, maxY, showX);
    if (!activeRows.some((row) => defined(row[config.key])) && config.emptyText) {
      drawEmptyChartMessage(svg, cs, config.emptyText);
    } else if (config.kind === "line") {
      const path = linePath(activeRows, x, y, config.key);
      if (path) svg.appendChild(svgEl("path", { d: path, class: "series-line" }));
      if (type === "price" && activeRows.some((row) => defined(row.benchmark))) {
        const benchRange = minMax(activeRows, "benchmark");
        const yBench = (value) => margin.top + (1 - (value - benchRange[0]) / Math.max(1e-9, benchRange[1] - benchRange[0])) * innerH;
        const benchPath = linePath(activeRows, x, yBench, "benchmark");
        if (benchPath) svg.appendChild(svgEl("path", { d: benchPath, class: "benchmark-line" }));
      }
      if (type === "shares") drawDisclosureMarkers(svg, cs, y);
    } else if (config.kind === "bar") {
      drawBars(svg, activeRows, cs, y, config.key, false);
    } else {
      drawBars(svg, activeRows, cs, y, config.key, true);
    }
    drawCrosshair(svg, cs, y, type, config);
    const overlay = svgEl("rect", { x: margin.left, y: margin.top, width: innerW, height: innerH, class: "hover-layer" });
    overlay.addEventListener("pointerdown", (event) => beginChartPointer(event, svg, cs));
    overlay.addEventListener("pointermove", (event) => {
      if (isTouchPointer(event)) return;
      showTooltip(event, cs, config, type);
    });
    overlay.addEventListener("pointerleave", () => {
      if (!state.zoomDrag) hideTooltip();
    });
    overlay.addEventListener("dblclick", resetZoom);
    overlay.addEventListener("wheel", (event) => wheelZoom(event, cs), { passive: false });
    svg.appendChild(overlay);
    if (showX) {
      const panLayer = svgEl("rect", { x: margin.left, y: margin.top + innerH, width: innerW, height: margin.bottom, class: "axis-pan-layer" });
      panLayer.addEventListener("pointerdown", (event) => beginAxisPan(event, cs, panLayer));
      svg.appendChild(panLayer);
    }
    const titleBar = chart.querySelector(".chart-title-overlay") || (() => {
      const bar = document.createElement("div");
      bar.className = "chart-title-overlay";
      chart.appendChild(bar);
      return bar;
    })();
    titleBar.textContent = chartTitle(type, config);
    if (type === "price" && activeRows.some((row) => defined(row.benchmark))) {
      const legend = document.createElement("span");
      legend.className = "title-legend";
      legend.textContent = "蓝实线=ETF前复权价 · 灰虚线=基准指数（独立标尺，仅看形态对照）";
      titleBar.appendChild(legend);
    }
  }
  function draw() {
    if (!state.rows.length) {
      clearCharts();
      return;
    }
    for (const chart of els.charts) drawChart(chart);
  }
  function isTouchPointer(event) {
    return event.pointerType === "touch" || event.pointerType === "pen" || isMobileLayout();
  }
  function beginChartPointer(event, svg, cs) {
    if (isTouchPointer(event)) {
      beginTouchGesture(event, cs, event.currentTarget);
      return;
    }
    beginZoomDrag(event, svg, cs);
  }
  function touchPoints(gesture) {
    return Array.from(gesture.pointers.values());
  }
  function gestureCenter(points) {
    const count = Math.max(1, points.length);
    return { x: points.reduce((sum, point) => sum + point.x, 0) / count, y: points.reduce((sum, point) => sum + point.y, 0) / count };
  }
  function gestureDistance(points) {
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }
  function resetTouchGestureBase() {
    const gesture = state.touchGesture;
    if (!gesture || !state.view) return;
    const points = touchPoints(gesture);
    const center = gestureCenter(points);
    const distance = gestureDistance(points);
    gesture.startCenterX = center.x;
    gesture.startCenterY = center.y;
    gesture.startDistance = Math.max(24, distance);
    gesture.startMinT = state.view.minT;
    gesture.startMaxT = state.view.maxT;
    gesture.startRange = state.view.maxT - state.view.minT;
    gesture.startCenterRatio = Math.max(0, Math.min(1, (center.x - gesture.cs.left) / gesture.cs.innerW));
    gesture.startCenterTime = gesture.startMinT + gesture.startCenterRatio * gesture.startRange;
  }
  function beginTouchGesture(event, cs, layer) {
    if (!state.view) return;
    hideTooltip();
    if (!state.touchGesture) {
      state.touchGesture = { pointers: new Map(), cs, layer, mode: "pending", captured: false };
      layer.classList.add("is-panning");
    }
    state.touchGesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    resetTouchGestureBase();
  }
  function updateTouchGesture(event) {
    const gesture = state.touchGesture;
    if (!gesture || !gesture.pointers.has(event.pointerId) || !state.view) return false;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = touchPoints(gesture);
    const center = gestureCenter(points);
    const dx = center.x - gesture.startCenterX;
    const dy = center.y - gesture.startCenterY;
    if (points.length >= 2) gesture.mode = "pinch";
    else if (gesture.mode === "pending") {
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (Math.max(absX, absY) < 8) return true;
      gesture.mode = absX > absY * 1.15 ? "pan" : "scroll";
    }
    if (gesture.mode === "scroll") return true;
    event.preventDefault();
    if (!gesture.captured) {
      for (const pointerId of gesture.pointers.keys()) {
        try {
          gesture.layer.setPointerCapture(pointerId);
        } catch (e) {
          /* ignore */
        }
      }
      gesture.captured = true;
    }
    const shouldClearRange = state.activeRangeLength !== null;
    state.activeRangeLength = null;
    const distance = gestureDistance(points);
    const currentRatio = Math.max(0, Math.min(1, (center.x - gesture.cs.left) / gesture.cs.innerW));
    let range = gesture.startRange;
    if (points.length >= 2 && distance > 24) {
      const scale = Math.max(0.12, Math.min(8, gesture.startDistance / distance));
      range = gesture.startRange * scale;
    }
    const minT = gesture.startCenterTime - currentRatio * range;
    state.view = clampView(minT, minT + range);
    updateZoomButton();
    draw();
    if (shouldClearRange) renderRangeSummary();
    return true;
  }
  function finishTouchGesture(event) {
    const gesture = state.touchGesture;
    if (!gesture || !gesture.pointers.has(event.pointerId)) return false;
    gesture.pointers.delete(event.pointerId);
    if (!gesture.pointers.size) {
      gesture.layer.classList.remove("is-panning");
      state.touchGesture = null;
      return true;
    }
    resetTouchGestureBase();
    return true;
  }
  function beginZoomDrag(event, svg, cs) {
    if (event.button !== 0 || !state.view) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const startX = event.clientX - rect.left + cs.left;
    const selection = svgEl("rect", { x: startX, y: cs.top, width: 0, height: cs.innerH, class: "zoom-selection" });
    svg.appendChild(selection);
    state.zoomDrag = { startX, currentX: startX, cs, selection };
    if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
  }
  function updateZoomDrag(event) {
    if (!state.zoomDrag) return;
    const chartRect = event.target.closest(".chart") ? event.target.closest(".chart").getBoundingClientRect() : els.chartStack.getBoundingClientRect();
    const x = Math.max(state.zoomDrag.cs.left, Math.min(state.zoomDrag.cs.left + state.zoomDrag.cs.innerW, event.clientX - chartRect.left));
    state.zoomDrag.currentX = x;
    const left = Math.min(state.zoomDrag.startX, x);
    const width = Math.abs(x - state.zoomDrag.startX);
    state.zoomDrag.selection.setAttribute("x", left);
    state.zoomDrag.selection.setAttribute("width", width);
  }
  function finishZoomDrag() {
    if (!state.zoomDrag) return;
    const drag = state.zoomDrag;
    drag.selection.remove();
    state.zoomDrag = null;
    const width = Math.abs(drag.currentX - drag.startX);
    if (width > 10) {
      const inv = (x) => state.view.minT + ((x - drag.cs.left) / drag.cs.innerW) * (state.view.maxT - state.view.minT);
      setView(inv(Math.min(drag.startX, drag.currentX)), inv(Math.max(drag.startX, drag.currentX)));
    }
  }
  function wheelZoom(event, cs) {
    if (!state.view) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left + cs.left;
    const ratio = Math.max(0, Math.min(1, (localX - cs.left) / cs.innerW));
    const center = state.view.minT + ratio * (state.view.maxT - state.view.minT);
    const factor = event.deltaY > 0 ? 1.22 : 0.82;
    const range = (state.view.maxT - state.view.minT) * factor;
    setView(center - range * ratio, center + range * (1 - ratio));
  }
  function beginAxisPan(event, cs, layer) {
    if (event.button !== 0 || !state.view) return;
    state.axisPan = { startX: event.clientX, startMinT: state.view.minT, startMaxT: state.view.maxT, range: state.view.maxT - state.view.minT, innerW: cs.innerW, layer };
    layer.classList.add("is-panning");
    if (layer.setPointerCapture) layer.setPointerCapture(event.pointerId);
    hideTooltip();
    event.preventDefault();
  }
  function updateAxisPan(event) {
    if (!state.axisPan) return;
    const shouldClearRange = state.activeRangeLength !== null;
    state.activeRangeLength = null;
    const dx = event.clientX - state.axisPan.startX;
    const deltaT = (-dx / state.axisPan.innerW) * state.axisPan.range;
    state.view = clampView(state.axisPan.startMinT + deltaT, state.axisPan.startMaxT + deltaT);
    updateZoomButton();
    draw();
    if (shouldClearRange) renderRangeSummary();
  }
  function finishAxisPan() {
    if (!state.axisPan) return;
    state.axisPan.layer.classList.remove("is-panning");
    state.axisPan = null;
  }

  // ---- Tooltip / Crosshair ----
  function setCrosshair(row, chartType, event) {
    const rowIndex = state.rows.indexOf(row);
    if (rowIndex < 0 || !chartType) return false;
    const previous = state.crosshair;
    state.crosshair = { chartType, rowIndex, clientX: event ? event.clientX : previous ? previous.clientX : null, clientY: event ? event.clientY : previous ? previous.clientY : null };
    return !previous || previous.chartType !== chartType || previous.rowIndex !== rowIndex;
  }
  function renderTooltip(row, config, clientX, clientY) {
    const isAggregate = Boolean(state.payload && state.payload.meta && state.payload.meta.is_aggregate);
    const rows = [
      [isAggregate ? "合成价格指数" : "前复权价", defined(row.price) ? (isAggregate ? fmt.format(row.price) : priceFmt.format(row.price)) : "-"],
      [isAggregate ? "合计成交额" : "成交额", defined(row.turnover) ? `${fmt.format(row.turnover)} 亿` : "-"],
      [isAggregate ? "合计 ETF 份额" : "ETF 份额", defined(row.shares) ? `${fmt.format(row.shares)} 亿份` : "-"],
      [isAggregate ? "合计申购赎回" : "申购赎回", defined(row.flow) ? `${fmt.format(row.flow)} 亿份` : "-"],
    ];
    if (defined(row.flowAmount)) rows.push(["净申赎金额", `${fmt.format(row.flowAmount)} 亿`]);
    if (defined(row.indexTurnover)) rows.push(["指数成交额", `${fmt.format(row.indexTurnover)} 亿`]);
    if (defined(row.flowImpact)) rows.push(["净申赎/指数成交额", formatSignedPct(row.flowImpact, 2)]);
    if (defined(row.turnoverPercentile)) rows.push(["成交额分位", formatPercentile(row.turnoverPercentile)]);
    if (defined(row.flowPercentile)) rows.push(["份额变动分位", formatPercentile(row.flowPercentile)]);
    if (config.key === "price" && defined(row.benchmark)) rows.push(["基准指数(灰虚线)", fmt.format(row.benchmark)]);
    const rollingRows = (row.rolling || []).map((item) => {
      const bits = [`价格 ${formatSignedPct(item.priceChange, 2)}`, `成交额 ${defined(item.turnover) ? `${fmt.format(item.turnover)} 亿` : "-"}`, `净申赎 ${defined(item.flowAmount) ? formatSignedNumber(item.flowAmount, " 亿", 2) : "-"}`];
      return `<div class="tooltip-row tooltip-rolling-row"><span>${item.label}</span><strong>${bits.join(" · ")}</strong></div>`;
    }).join("");
    els.tooltip.innerHTML = `
      <div class="tooltip-title">${row.date}</div>
      ${rows.map(([label, value]) => `<div class="tooltip-row"><span>${label}</span><strong>${value}</strong></div>`).join("")}
      ${rollingRows ? `<div class="tooltip-section-title">截至当天累计</div>${rollingRows}` : ""}
    `;
    if (!els.chartStack) return;
    const stackRect = els.chartStack.getBoundingClientRect();
    const fallbackX = stackRect.left + stackRect.width - 340;
    const fallbackY = stackRect.top + 20;
    const x = Number.isFinite(clientX) ? clientX : fallbackX;
    const y = Number.isFinite(clientY) ? clientY : fallbackY;
    els.tooltip.style.left = "0px";
    els.tooltip.style.top = "0px";
    const tooltipWidth = Math.min(els.tooltip.offsetWidth || 320, stackRect.width - 16);
    const tooltipHeight = els.tooltip.offsetHeight || 180;
    const localX = x - stackRect.left;
    const localY = y - stackRect.top;
    const rightSideLeft = localX + 14;
    const leftSideLeft = localX - tooltipWidth - 14;
    const fitsRight = rightSideLeft + tooltipWidth + 8 <= stackRect.width;
    const left = fitsRight ? rightSideLeft : leftSideLeft;
    const top = Math.min(Math.max(8, localY + 12), Math.max(8, stackRect.height - tooltipHeight - 8));
    els.tooltip.style.left = `${Math.max(8, left)}px`;
    els.tooltip.style.top = `${top}px`;
    els.tooltip.style.visibility = "visible";
  }
  function showTooltip(event, cs, config, chartType) {
    if (state.zoomDrag || state.axisPan || !state.view || !state.rows.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left + cs.left;
    const t = state.view.minT + ((localX - cs.left) / cs.innerW) * (state.view.maxT - state.view.minT);
    const row = nearestRow(t);
    if (!row) return;
    const changed = setCrosshair(row, chartType, event);
    if (changed) draw();
    renderTooltip(row, config, event.clientX, event.clientY);
  }
  function hideTooltip() {
    if (els.tooltip) els.tooltip.style.visibility = "hidden";
  }
  function moveCrosshair(step) {
    if (isMobileLayout() || !state.crosshair || !state.rows.length || !state.view) return false;
    const nextIndex = Math.max(0, Math.min(state.rows.length - 1, state.crosshair.rowIndex + step));
    if (nextIndex === state.crosshair.rowIndex) return false;
    const row = state.rows[nextIndex];
    state.crosshair = Object.assign({}, state.crosshair, { rowIndex: nextIndex });
    if (!state.view || row.t < state.view.minT || row.t > state.view.maxT) {
      const span = state.view.maxT - state.view.minT;
      const pad = span * 0.06;
      if (row.t < state.view.minT) state.view = clampView(row.t - pad, row.t - pad + span);
      else state.view = clampView(row.t + pad - span, row.t + pad);
      updateZoomButton();
    }
    draw();
    const config = chartConfig[state.crosshair.chartType] || chartConfig.price;
    renderTooltip(row, config, state.crosshair.clientX, state.crosshair.clientY);
    return true;
  }

  // ---- 初始化 & 事件 ----
  function applyFreshData(fresh) {
    if (!fresh || !fresh.etfs) throw new Error("数据格式不正确");
    Object.keys(APP_DATA).forEach((k) => { delete APP_DATA[k]; });
    Object.assign(APP_DATA, fresh);
    state.etfPayloadCache = {};
    state.indexTurnoverCache = {};
    state.universe = APP_DATA.universe || [];
    state.groups = APP_DATA.groups || [];
    CATEGORIES = (APP_DATA.categories || []).map((c) => c.key);
    if (!state.universe.some((item) => item.code === state.activeCode)) {
      const first = state.universe.find((item) => item.dashboard_eligible) || state.universe[0];
      state.activeCode = first ? first.code : "";
    }
    renderSelectors();
    loadTrendBoard();
    return selectEtf(state.activeCode);
  }

  let refreshing = false;
  async function refreshData() {
    if (refreshing) return;
    const isHttp = location.protocol === "http:" || location.protocol === "https:";
    if (!isHttp) {
      setStatus("当前为本地文件模式：请运行 python refresh_data.py 后手动刷新页面；或运行 python serve.py 启动本地服务后可一键刷新。");
      return;
    }
    refreshing = true;
    if (els.refreshBtn) { els.refreshBtn.disabled = true; els.refreshBtn.textContent = "刷新中…"; }
    try {
      setStatus("正在拉取最新行情与份额数据（约 1-3 分钟，请稍候）…");
      const resp = await fetch("/api/refresh", { method: "POST" });
      const info = await resp.json().catch(() => ({}));
      if (!resp.ok || info.ok === false) throw new Error(info.error || ("HTTP " + resp.status));
      const dataResp = await fetch("data.json?ts=" + Date.now(), { cache: "no-store" });
      if (!dataResp.ok) throw new Error("读取新数据失败 HTTP " + dataResp.status);
      const fresh = await dataResp.json();
      await applyFreshData(fresh);
      setStatus("数据已刷新 · " + (fresh.refreshed_at || new Date().toLocaleString()));
    } catch (err) {
      setStatus("刷新失败：" + (err && err.message ? err.message : err) + "（请确认已用 serve.py 启动服务）");
    } finally {
      refreshing = false;
      if (els.refreshBtn) { els.refreshBtn.disabled = false; els.refreshBtn.textContent = "刷新数据"; }
    }
  }
  async function init() {
    syncResponsiveLayout();
    setStatus("读取 universe");
    state.universe = APP_DATA.universe || [];
    state.groups = APP_DATA.groups || [];
    CATEGORIES = (APP_DATA.categories || []).map((c) => c.key);
    if (!state.universe.some((item) => item.code === state.activeCode)) {
      const first = state.universe.find((item) => item.dashboard_eligible) || state.universe[0];
      state.activeCode = first ? first.code : "";
    }
    renderSelectors();
    await loadTrendBoard();
    await selectEtf(state.activeCode);
    observeChartSizes();
  }

  if (els.groupSelect) els.groupSelect.addEventListener("change", () => {
    state.activeGroup = els.groupSelect.value;
    renderEtfOptions();
    loadTrendBoard();
    selectEtf(state.activeCode);
  });
  if (els.etfSelect) els.etfSelect.addEventListener("change", () => selectEtf(els.etfSelect.value));
  if (els.rangeSummaryStrip) els.rangeSummaryStrip.addEventListener("click", (event) => {
    const button = event.target.closest("[data-range-length]");
    if (!button) return;
    zoomToRecentWindow(button.dataset.rangeLength);
  });
  if (els.trendTableBody) els.trendTableBody.addEventListener("click", handleTrendTableClick);
  if (els.trendPopoutBtn) els.trendPopoutBtn.addEventListener("click", toggleTrendPopout);
  if (els.trendBackdrop) els.trendBackdrop.addEventListener("click", () => setTrendPopout(false));
  if (els.applyTrendRangeBtn) els.applyTrendRangeBtn.addEventListener("click", applyTrendRangeFromInputs);
  if (els.trendRecentBtn) els.trendRecentBtn.addEventListener("click", loadTrendBoard);
  if (els.trendStartInput) els.trendStartInput.addEventListener("keydown", (event) => { if (event.key === "Enter") applyTrendRangeFromInputs(); });
  if (els.trendEndInput) els.trendEndInput.addEventListener("keydown", (event) => { if (event.key === "Enter") applyTrendRangeFromInputs(); });
  if (els.refreshBtn) els.refreshBtn.addEventListener("click", refreshData);
  if (els.resetZoomBtn) els.resetZoomBtn.addEventListener("click", resetZoom);
  if (els.tipButton) els.tipButton.addEventListener("click", () => setTipDialog(true));
  if (els.tipCloseBtn) els.tipCloseBtn.addEventListener("click", () => setTipDialog(false));
  if (els.tipBackdrop) els.tipBackdrop.addEventListener("click", () => setTipDialog(false));
  if (els.applyDateRangeBtn) els.applyDateRangeBtn.addEventListener("click", applyDateRangeFromInputs);
  if (els.fullDateRangeBtn) els.fullDateRangeBtn.addEventListener("click", resetZoom);
  if (els.timeScrollTrack) els.timeScrollTrack.addEventListener("pointerdown", (event) => beginTimeScrollDrag(event, "track"));
  if (els.timeScrollWindow) els.timeScrollWindow.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    beginTimeScrollDrag(event, "pan");
  });
  if (els.timeHandleStart) els.timeHandleStart.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    beginTimeScrollDrag(event, "start");
  });
  if (els.timeHandleEnd) els.timeHandleEnd.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    beginTimeScrollDrag(event, "end");
  });
  if (els.scrollLatestBtn) els.scrollLatestBtn.addEventListener("click", scrollToLatestView);
  if (els.dateStartInput) els.dateStartInput.addEventListener("keydown", (event) => { if (event.key === "Enter") applyDateRangeFromInputs(); });
  if (els.dateEndInput) els.dateEndInput.addEventListener("keydown", (event) => { if (event.key === "Enter") applyDateRangeFromInputs(); });
  if (els.mobileChartsTab) els.mobileChartsTab.addEventListener("click", () => setMobileView("charts"));
  if (els.mobileTrendTab) els.mobileTrendTab.addEventListener("click", () => setMobileView("trend"));
  if (els.themeToggleBtn) els.themeToggleBtn.addEventListener("click", toggleTheme);

  // 全局 pointer / keyboard
  window.addEventListener("pointermove", (event) => {
    if (state.zoomDrag) updateZoomDrag(event);
    else if (state.axisPan) updateAxisPan(event);
    else if (state.timeScrollDrag) updateTimeScrollDrag(event);
    else if (state.touchGesture) updateTouchGesture(event);
  });
  window.addEventListener("pointerup", (event) => {
    if (state.zoomDrag) finishZoomDrag();
    if (state.axisPan) finishAxisPan();
    if (state.timeScrollDrag) finishTimeScrollDrag();
    if (state.touchGesture) finishTouchGesture(event);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") { if (moveCrosshair(-1)) event.preventDefault(); }
    else if (event.key === "ArrowRight") { if (moveCrosshair(1)) event.preventDefault(); }
    else if (event.key === "Escape") { hideTooltip(); clearCrosshair(); setTipDialog(false); setTrendPopout(false); }
  });
  function clearCrosshair() {
    if (!state.crosshair) return;
    state.crosshair = null;
    hideTooltip();
    draw();
  }
  function isTextEntryTarget(target) {
    const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
    return target && (target.isContentEditable || tag === "input" || tag === "select" || tag === "textarea" || tag === "button");
  }
  let pendingDraw = false;
  function scheduleDraw() {
    if (pendingDraw) return;
    pendingDraw = true;
    (window.requestAnimationFrame || ((cb) => window.setTimeout(cb, 16)))(() => {
      pendingDraw = false;
      if (state.rows.length) draw();
    });
  }
  const chartSizeCache = new WeakMap();
  function observeChartSizes() {
    if (typeof ResizeObserver === "undefined" || !els.chartStack) return;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target;
        const w = el.clientWidth;
        const h = el.clientHeight;
        const prev = chartSizeCache.get(el) || [0, 0];
        if (prev[0] !== w || prev[1] !== h) {
          chartSizeCache.set(el, [w, h]);
          changed = true;
        }
      }
      if (changed) {
        scheduleDraw();
        syncTimeScroll();
      }
    });
    els.charts.forEach((chart) => ro.observe(chart));
  }
  window.addEventListener("resize", () => { scheduleDraw(); syncTimeScroll(); });
  if (mobileLayoutQuery.addEventListener) mobileLayoutQuery.addEventListener("change", syncResponsiveLayout);
  if (coarsePointerQuery.addEventListener) coarsePointerQuery.addEventListener("change", syncResponsiveLayout);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();