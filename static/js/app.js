(() => {
  "use strict";

  const form = document.getElementById("forecast-form");
  if (!form) return;

  const routeInput = document.getElementById("route");
  const dateInput = document.getElementById("flight-date");
  const priceInput = document.getElementById("ticket-price");
  const errorBox = document.getElementById("form-error");
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const formatNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
  const formatInteger = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const rub = (value) => `${formatInteger.format(value)} ₽`;
  let debounceTimer;
  let requestCounter = 0;
  let activeController = null;
  let lastSavedSignature = null;
  let lastResult = null;

  function updatePriceForRoute() {
    const selected = routeInput.selectedOptions[0];
    priceInput.min = selected.dataset.minPrice;
    priceInput.max = selected.dataset.maxPrice;
    priceInput.value = selected.dataset.basePrice;
    document.getElementById("price-limits").textContent = `Диапазон: ${rub(Number(selected.dataset.minPrice))} – ${rub(Number(selected.dataset.maxPrice))}`;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.textContent = "";
    errorBox.hidden = true;
  }

  function scheduleCalculate(delay = 0, saveHistory = true) {
    window.clearTimeout(debounceTimer);
    const requestId = ++requestCounter;
    if (activeController) activeController.abort();
    activeController = null;
    form.removeAttribute("aria-busy");
    if (delay) {
      debounceTimer = window.setTimeout(() => calculate(requestId, saveHistory), delay);
    } else {
      calculate(requestId, saveHistory);
    }
  }

  async function calculate(requestId, saveHistory) {
    const price = Number(priceInput.value);
    const min = Number(priceInput.min);
    const max = Number(priceInput.max);
    clearError();
    if (!priceInput.value || !Number.isFinite(price) || price < min || price > max) {
      showError(`Укажите цену от ${rub(min)} до ${rub(max)}.`);
      return;
    }
    if (!dateInput.value) {
      showError("Выберите дату вылета.");
      return;
    }
    const signature = `${routeInput.value}|${dateInput.value}|${price}`;
    const shouldSave = saveHistory && signature !== lastSavedSignature;
    const controller = new AbortController();
    activeController = controller;
    form.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/forecast", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ route: routeInput.value, date: dateInput.value, price, save_history: shouldSave }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (requestId !== requestCounter) return;
      if (!response.ok) throw new Error(data.error || "Не удалось получить прогноз.");
      renderResults(data);
      if (shouldSave) lastSavedSignature = signature;
    } catch (error) {
      if (requestId === requestCounter && error.name !== "AbortError") {
        showError(error.message || "Ошибка соединения с сервером.");
      }
    } finally {
      if (requestId === requestCounter) {
        activeController = null;
        form.removeAttribute("aria-busy");
      }
    }
  }

  function renderResults(data) {
    lastResult = data;
    const date = new Date(`${data.date}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
    document.getElementById("result-subtitle").textContent = `${data.route_name} · ${date}`;
    document.getElementById("metric-demand").textContent = formatNumber.format(data.demand);
    document.getElementById("metric-sales").textContent = formatNumber.format(data.sales);
    document.getElementById("metric-seats").textContent = formatInteger.format(data.seats);
    document.getElementById("metric-remaining").textContent = formatNumber.format(data.remaining_seats);
    document.getElementById("metric-load").textContent = `${formatNumber.format(data.load_percent)}%`;
    document.getElementById("occupancy-fill").style.width = `${Math.max(0, Math.min(100, data.load_percent))}%`;
    document.querySelector(".occupancy-track").setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, data.load_percent))));
    const aboveCapacity = data.scenarios.some((scenario) => scenario.demand > data.seats);
    document.getElementById("capacity-note").textContent = aboveCapacity
      ? "В части сценариев спрос превышает вместимость. Продажи ограничены количеством мест."
      : "Продажи ограничены количеством мест. Медианный сценарий отмечен на графике.";
    renderChart(data);
    renderPriceChart(data);
    renderScenarios(data);
  }

  function renderChart(data) {
    const container = document.getElementById("chart-container");
    container.replaceChildren();
    const svgNS = "http://www.w3.org/2000/svg";
    const width = 1060;
    const height = 324;
    const margin = { top: 34, right: 46, bottom: 59, left: 65 };
    const styles = getComputedStyle(document.documentElement);
    const color = (token) => styles.getPropertyValue(token).trim();
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const demands = data.scenarios.map((scenario) => scenario.demand);
    const values = [...demands, data.seats, 0];
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const spread = Math.max(rawMax - rawMin, 1);
    const minX = Math.floor((rawMin - spread * 0.055) / 100) * 100;
    const maxX = Math.ceil((rawMax + spread * 0.055) / 100) * 100;
    const x = (value) => margin.left + ((value - minX) / (maxX - minX)) * innerW;
    const y = (percent) => margin.top + (1 - percent / 100) * innerH;

    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Распределение спроса по девяти сценариям. Медиана ${formatNumber.format(data.demand)} пассажиров, вместимость ${formatInteger.format(data.seats)} мест.`);
    container.appendChild(svg);

    function node(name, attrs = {}, parent = svg) {
      const element = document.createElementNS(svgNS, name);
      Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
      parent.appendChild(element);
      return element;
    }

    if (data.seats < maxX) {
      node("rect", { x: x(data.seats), y: margin.top, width: width - margin.right - x(data.seats), height: innerH, fill: color("--chart-overflow") });
    }

    [10, 30, 50, 70, 90].forEach((percent) => {
      node("line", { x1: margin.left, y1: y(percent), x2: width - margin.right, y2: y(percent), stroke: color("--chart-grid"), "stroke-width": 1 });
      const text = node("text", { x: margin.left - 13, y: y(percent) + 4, "text-anchor": "end", "font-size": 12, fill: color("--chart-text") });
      text.textContent = `${percent}%`;
    });

    const tickCount = 5;
    for (let i = 0; i <= tickCount; i++) {
      const value = minX + (maxX - minX) * (i / tickCount);
      const px = x(value);
      node("line", { x1: px, y1: margin.top, x2: px, y2: height - margin.bottom, stroke: color("--chart-grid"), "stroke-width": 1 });
      const tick = node("text", { x: px, y: height - margin.bottom + 23, "text-anchor": "middle", "font-size": 11, fill: color("--chart-text") });
      tick.textContent = formatInteger.format(value);
    }

    const seatsX = x(data.seats);
    node("line", { x1: seatsX, y1: margin.top, x2: seatsX, y2: height - margin.bottom, stroke: color("--chart-capacity"), "stroke-width": 2, "stroke-dasharray": "6 5" });
    const seatLabel = node("text", { x: Math.min(width - margin.right - 34, Math.max(margin.left + 34, seatsX)), y: margin.top - 11, "text-anchor": "middle", "font-size": 11, "font-weight": 700, fill: color("--chart-capacity-label") });
    seatLabel.textContent = `Мест: ${formatInteger.format(data.seats)}`;

    const medianX = x(data.demand);
    node("line", { x1: medianX, y1: margin.top, x2: medianX, y2: height - margin.bottom, stroke: color("--chart-median"), "stroke-width": 1.5, "stroke-dasharray": "3 5", opacity: 0.75 });

    const linePoints = data.scenarios.map((scenario) => `${x(scenario.demand)},${y(scenario.probability)}`).join(" ");
    node("polyline", { points: linePoints, fill: "none", stroke: color("--chart-line"), "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" });
    data.scenarios.forEach((scenario) => {
      const isMedian = scenario.quantile === "0.5";
      const dot = node("circle", { cx: x(scenario.demand), cy: y(scenario.probability), r: isMedian ? 6.7 : 4.5, fill: isMedian ? color("--chart-median") : color("--chart-point"), stroke: color("--chart-dot-outline"), "stroke-width": isMedian ? 2.8 : 1.5 });
      const title = node("title", {}, dot);
      title.textContent = `P${scenario.probability}: спрос ${formatNumber.format(scenario.demand)}, продажи ${formatNumber.format(scenario.sales)}`;
    });

    const axisX = node("text", { x: margin.left + innerW / 2, y: height - 6, "text-anchor": "middle", "font-size": 12, "font-weight": 600, fill: color("--chart-axis") });
    axisX.textContent = "Расчётный спрос, пассажиров";
    {
      const axisY = node("text", { x: 17, y: margin.top + innerH / 2, "text-anchor": "middle", transform: `rotate(-90 17 ${margin.top + innerH / 2})`, "font-size": 12, "font-weight": 600, fill: color("--chart-axis") });
      axisY.textContent = "Вероятность";
    }
  }


  function renderScenarios(data) {
    const body = document.getElementById("scenario-rows");
    body.replaceChildren();
    data.scenarios.forEach((scenario) => {
      const row = document.createElement("tr");
      if (scenario.quantile === "0.5") row.className = "scenario-median";
      const values = [`P${scenario.probability}`, formatNumber.format(scenario.demand), formatNumber.format(scenario.sales), rub(scenario.optimal_price)];
      values.forEach((value, i) => {
        const cell = document.createElement("td");
        if (i === 0) {
          const label = document.createElement("span");
          label.className = "scenario-tag";
          label.textContent = value;
          cell.appendChild(label);
          if (scenario.quantile === "0.5") cell.append(" · медиана");
        } else {
          cell.textContent = value;
        }
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
  }

  function renderPriceChart(data) {
    const timeline = data.price_timeline || [];
    const container = document.getElementById("price-chart-container");
    container.replaceChildren();
    if (!timeline.length) {
      container.textContent = "Нет данных для графика цен.";
      return;
    }
    const selected = timeline.find((item) => item.date === data.date) || timeline[0];
    const selectedIndex = timeline.indexOf(selected);
    const p10 = selected.prices["0.1"];
    const p90 = selected.prices["0.9"];
    const p50 = selected.prices["0.5"];
    document.getElementById("price-median").textContent = rub(p50);
    document.getElementById("price-range").textContent = `${rub(p10)} – ${rub(p90)}`;
    document.getElementById("price-spread").textContent = rub(p90 - p10);

    const ns = "http://www.w3.org/2000/svg";
    const width = 1060;
    const height = 360;
    const margin = { top: 36, right: 30, bottom: 53, left: 81 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const styles = getComputedStyle(document.documentElement);
    const color = (token) => styles.getPropertyValue(token).trim();
    const values = timeline.flatMap((item) => [item.prices["0.1"], item.prices["0.9"]]);
    const minPrice = Math.min(...values);
    const maxPrice = Math.max(...values);
    const padding = Math.max(250, (maxPrice - minPrice) * 0.07);
    const yMin = Math.floor((minPrice - padding) / 500) * 500;
    const yMax = Math.ceil((maxPrice + padding) / 500) * 500;
    const x = (i) => margin.left + (i / Math.max(1, timeline.length - 1)) * innerW;
    const y = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * innerH;

    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Прогноз цен по ${timeline.length} датам. Для выбранной даты ${data.date} медианная цена ${rub(p50)}, диапазон P10–P90 от ${rub(p10)} до ${rub(p90)}.`);
    container.appendChild(svg);
    const node = (tag, attrs = {}, parent = svg) => {
      const el = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
      parent.appendChild(el);
      return el;
    };
    const text = (content, attrs) => { const el = node("text", attrs); el.textContent = content; return el; };

    if (selectedIndex > 0) {
      node("rect", { x: margin.left, y: margin.top, width: x(selectedIndex) - margin.left, height: innerH, fill: color("--price-previous") });
    }
    for (let i = 0; i <= 4; i++) {
      const price = yMin + (yMax - yMin) * i / 4;
      const py = y(price);
      node("line", { x1: margin.left, y1: py, x2: width - margin.right, y2: py, stroke: color("--chart-grid"), "stroke-width": 1 });
      text(formatInteger.format(price), { x: margin.left - 14, y: py + 4, "text-anchor": "end", "font-size": 12, fill: color("--chart-text") });
    }
    [0, 5, 10, 15, 20, 25, timeline.length - 1].filter((v, i, arr) => arr.indexOf(v) === i).forEach((index) => {
      if (index >= timeline.length) return;
      const label = new Date(`${timeline[index].date}T12:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
      const px = x(index);
      text(label, { x: px, y: height - margin.bottom + 23, "text-anchor": "middle", "font-size": 12, fill: color("--chart-text") });
    });

    const bands = [
      ["0.1", "0.9", "--price-band-outer"],
      ["0.2", "0.8", "--price-band-mid"],
      ["0.3", "0.7", "--price-band-inner"],
      ["0.4", "0.6", "--price-band-core"],
    ];
    bands.forEach(([low, high, token]) => {
      const top = timeline.map((item, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(item.prices[high]).toFixed(2)}`).join(" ");
      const bottom = timeline.map((item, i) => `L${x(timeline.length - 1 - i).toFixed(2)},${y(timeline[timeline.length - 1 - i].prices[low]).toFixed(2)}`).join(" ");
      node("path", { d: `${top} ${bottom} Z`, fill: color(token), stroke: "none" });
    });

    for (let i = 1; i <= 9; i++) {
      const quantile = `0.${i}`;
      const median = i === 5;
      const d = timeline.map((item, j) => `${j === 0 ? "M" : "L"}${x(j).toFixed(2)},${y(item.prices[quantile]).toFixed(2)}`).join(" ");
      node("path", { d, fill: "none", stroke: color(median ? "--price-median-line" : "--price-line-soft"), "stroke-width": median ? 3.2 : 1, opacity: median ? 1 : 0.48, "stroke-linejoin": "round", "stroke-linecap": "round" });
    }

    const selectedX = x(selectedIndex);
    node("line", { x1: selectedX, y1: margin.top, x2: selectedX, y2: height - margin.bottom, stroke: color("--price-selected"), "stroke-width": 2, "stroke-dasharray": "5 5" });
    node("circle", { cx: selectedX, cy: y(p50), r: 6, fill: color("--price-median-line"), stroke: color("--chart-dot-outline"), "stroke-width": 2.5 });
    const dateLabel = new Date(`${selected.date}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    const labelX = Math.max(margin.left + 60, Math.min(width - margin.right - 60, selectedX));
    text(dateLabel, { x: labelX, y: margin.top - 13, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: color("--price-selected") });
    text("Дата вылета", { x: margin.left + innerW / 2, y: height - 5, "text-anchor": "middle", "font-size": 12, "font-weight": 600, fill: color("--chart-axis") });
    text("Цена, ₽", { x: margin.left - 2, y: 18, "text-anchor": "start", "font-size": 12, "font-weight": 600, fill: color("--chart-axis") });
    const tooltip = node("title", {}, svg);
    tooltip.textContent = `P10 ${rub(p10)} · P50 ${rub(p50)} · P90 ${rub(p90)} на ${dateLabel}`;
  }

  window.addEventListener("themechange", () => {
    if (lastResult) {
      renderChart(lastResult);
      renderPriceChart(lastResult);
    }
  });

  routeInput.addEventListener("change", () => {
    updatePriceForRoute();
    scheduleCalculate();
  });
  dateInput.addEventListener("change", () => scheduleCalculate());
  priceInput.addEventListener("input", () => scheduleCalculate(250));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    scheduleCalculate();
  });
  updatePriceForRoute();
  scheduleCalculate(0, false);
})();
