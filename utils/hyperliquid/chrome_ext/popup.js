document.getElementById('analyzeBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url.includes("hyperliquid.xyz")) {
        document.getElementById('results').innerText = "Ошибка: Откройте вкладку торговли Hyperliquid!";
        return;
    }

    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: parseHLPositionsWithSpotMetrics
    }, (results) => {
        if (!results || !results[0] || !results[0].result) {
            document.getElementById('results').innerText = "Не удалось прочитать таблицу позиций. Убедитесь, что вкладка 'Positions' открыта в интерфейсе биржи.";
            return;
        }

        renderResults(results[0].result);
    });
});

// СВЕРХНАДЕЖНЫЙ СБОРЩИК МЕТРИК, УСТОЙЧИВЫЙ К РУССКОЙ ЛОКАЛИЗАЦИИ И СИМВОЛАМ
function parseHLPositionsWithSpotMetrics() {
    const LONG_TOKENS = ['ETH', 'BTC', 'HYPE'];
    const rows = document.querySelectorAll('tr');
    let extracted = [];

    rows.forEach(row => {
        const cells = row.querySelectorAll('td');

        if (cells.length >= 6) {
            const marketText = cells[0]?.innerText || ""; // "APT 10x"
            const sizeText = cells[1]?.innerText || "";   // "-292.55 APT"
            const valueText = cells[2]?.innerText || "";  // "168,51 USDC"
            const pnlText = cells[5]?.innerText || "";    // "-$5,91 (-25,8%)"

            if (marketText && valueText && valueText.includes('USDC')) {

                // 1. ИЗВЛЕКАЕМ ТИКЕР И МАКС ПЛЕЧО
                const marketWords = marketText.trim().split(/\s+/);
                const rawTicker = marketWords[0].toUpperCase();
                const ticker = rawTicker.replace(/[^A-Z0-9]/g, '');

                let maxLeverage = 1;
                const levMatch = marketText.match(/(\d+)x/);
                if (levMatch && levMatch[1]) {
                    maxLeverage = parseInt(levMatch[1]) || 1;
                }

                // 2. ИЗВЛЕКАЕМ ДОЛЛАРЫ ОБЪЕМА
                const cleanValue = valueText.replace(',', '.').replace(/[^0-9.]/g, '');
                const usdValue = parseFloat(cleanValue);

                // 3. ПАРСИНГ ПРОЦЕНТА ROE
                let roePercent = 0;
                console.log(pnlText);
                if (pnlText && pnlText.includes('%')) {
                    // Вытаскиваем текст, который находится внутри круглых скобок
                    const bracketMatches = pnlText.match(/\(([^)]+)\)/);

                    if (bracketMatches && bracketMatches[1]) {
                        let insideBrackets = bracketMatches[1]; // Получим "-25,8%" или "+55,7%"

                        // Проверяем, есть ли плюс или зеленый цвет. Если их НЕТ (оператор !), значит это минус!
                        const hasMinus = !(/[+]/.test(insideBrackets) || pnlText.includes('+') || row.innerHTML.includes('rgb(80, 210, 193)'));

                        // Очищаем строку внутри скобок: меняем запятую на точку и убираем всё кроме цифр и точек
                        let cleanPnlString = insideBrackets.replace(',', '.').replace(/[^0-9.]/g, '');
                        let parsedPnl = parseFloat(cleanPnlString);

                        if (!isNaN(parsedPnl)) {
                            roePercent = hasMinus ? -parsedPnl : parsedPnl;
                        }
                    }
                }

                if (usdValue > 0 && ticker && ticker !== 'MARKET' && ticker !== 'TOTAL') {
                    let side = 'short';
                    if (LONG_TOKENS.includes(ticker)) {
                        side = 'long';
                    }

                    // 4. ВЫЧИСЛЯЕМ ЧИСТЫЙ СПОТ
                    let spotChange = roePercent / maxLeverage;
                    if (side === 'short') {
                        spotChange = -spotChange; // Инвертируем для шортов, чтобы рост цены всегда был с плюсом
                    }

                    extracted.push({ ticker, side, usdValue, spotChange });
                }
            }
        }
    });

    return extracted.filter((v, i, a) => a.findIndex(t => t.ticker === v.ticker && t.side === v.side) === i);
}

// ФУНКЦИЯ ОТРИСОВКИ РЕЗУЛЬТАТОВ
function renderResults(data) {
    const container = document.getElementById('results');
    container.innerHTML = '';

    let longs = [];
    let shorts = [];
    let totalLongUSD = 0;
    let totalShortUSD = 0;

    data.forEach(pos => {
        if (pos.side === 'long') {
            longs.push(pos);
            totalLongUSD += pos.usdValue;
        } else {
            shorts.push(pos);
            totalShortUSD += pos.usdValue;
        }
    });

    if (data.length === 0) {
        container.innerHTML = "Открытые позиции не найдены на экране.";
        return;
    }

    // Находим самый быстрорастущий щиток на споте среди шортов
    let fastestGrowingShort = null;
    let maxShortGrowth = -Infinity;
    shorts.forEach(p => {
        if (p.spotChange > maxShortGrowth) {
            maxShortGrowth = p.spotChange;
            fastestGrowingShort = p;
        }
    });

    // Рендерим Шорты
    let shortHtml = `<div class="section"><b class="red">🔴 ШОРТЫ (Всего: $${totalShortUSD.toFixed(2)})</b>`;
    shorts.forEach(p => {
        const share = totalShortUSD > 0 ? (p.usdValue / totalShortUSD) * 100 : 0;
        const spotSign = p.spotChange >= 0 ? '+' : '';
        const spotClass = p.spotChange >= 0 ? 'green' : 'red';

        // Выводим тикер и сразу очищенный спотовый процент
        shortHtml += `
      <div class="row">
        <span><b>${p.ticker}</b> <span class="${spotClass}" style="font-size:11px; font-weight:bold; margin-left:4px;">${spotSign}${p.spotChange.toFixed(1)}%</span></span>
        <span>$${p.usdValue.toFixed(2)} <span class="pct">(${share.toFixed(1)}%)</span></span>
      </div>`;
    });
    shortHtml += `</div>`;

    // Рендерим Лонги
    let longHtml = `<div class="section"><b class="green">🟢 ЛОНГИ (Всего: $${totalLongUSD.toFixed(2)})</b>`;
    longs.forEach(p => {
        const share = totalLongUSD > 0 ? (p.usdValue / totalLongUSD) * 100 : 0;
        const spotSign = p.spotChange >= 0 ? '+' : '';
        const spotClass = p.spotChange >= 0 ? 'green' : 'red';

        longHtml += `
      <div class="row">
        <span><b>${p.ticker}</b> <span class="${spotClass}" style="font-size:11px; font-weight:bold; margin-left:4px;">${spotSign}${p.spotChange.toFixed(1)}%</span></span>
        <span>$${p.usdValue.toFixed(2)} <span class="pct">(${share.toFixed(1)}%)</span></span>
      </div>`;
    });
    longHtml += `</div>`;

    // Расчет калькулятора подлупок (цель 1.66)
    const idealLongTotal = totalShortUSD * 1.66;
    let totalLongAddUSD = idealLongTotal - totalLongUSD;
    if (totalLongAddUSD < 0) totalLongAddUSD = 0;

    const ethOrder = totalLongAddUSD * 0.70;
    const btcOrder = totalLongAddUSD * 0.15;
    const hypeOrder = totalLongAddUSD * 0.15;

    let calculatorHtml = '';
    if (totalLongAddUSD > 0) {
        let toxicAlertHtml = '';
        // Если лидер спотового роста имеет положительный процент, подсвечиваем его
        if (fastestGrowingShort && fastestGrowingShort.spotChange > 0) {
            toxicAlertHtml = `
            <div style="font-size: 11px; color: #ff9800; margin-top: 6px; border-top: 1px dashed #444; padding-top: 4px;">
                🔥 <b>Истинный лидер роста:</b> ${fastestGrowingShort.ticker} (+${fastestGrowingShort.spotChange.toFixed(1)}% на споте)<br>
                <span style="color:#aaa;">Этот актив растет быстрее всех. Рекомендуется гасить именно его.</span>
            </div>
        `;
        }

        calculatorHtml = `
        <div class="section" style="border: 1px solid #47b970; background: #132219;">
            <b class="green">⚠️ СИГНАЛ ПОДЛУПОК ЛОНГОВ</b>
            <div class="row" style="margin-top: 6px; font-weight: bold;">
                <span>Общая сумма добора:</span>
                <span class="green">+$${totalLongAddUSD.toFixed(2)}</span>
            </div>
            <div class="row" style="font-size: 12px; margin-top: 4px; border-top: 1px solid #243a2b; padding-top: 4px;">
                <span>[ETH-PERP] Докупить на:</span>
                <b>$${ethOrder.toFixed(2)} <span class="pct">(70%)</span></b>
            </div>
            <div class="row" style="font-size: 12px;">
                <span>[BTC-PERP] Докупить на:</span>
                <b>$${btcOrder.toFixed(2)} <span class="pct">(15%)</span></b>
            </div>
            <div class="row" style="font-size: 12px;">
                <span>[HYPE-PERP] Докупить на:</span>
                <b>$${hypeOrder.toFixed(2)} <span class="pct">(15%)</span></b>
            </div>
            ${toxicAlertHtml}
        </div>
    `;
    } else {
        calculatorHtml = `
        <div class="section" style="border: 1px solid #2d3139; background: #17191e; text-align: center; color: #888; font-size: 12px; font-weight: bold;">
            ✅ Баланс 1.66х удерживается. Подлупка не требуется.
        </div>
    `;
    }

    const currentRatio = totalShortUSD > 0 ? (totalLongUSD / totalShortUSD) : 0;
    let ratioClass = currentRatio < 1.60 ? 'red' : 'green';

    let summaryHtml = `
    <div class="section total">
      <div class="row"><span>Всего лонгов:</span><span class="green">$${totalLongUSD.toFixed(2)}</span></div>
      <div class="row"><span>Всего шортов:</span><span class="red">$${totalShortUSD.toFixed(2)}</span></div>
      <div class="row total"><span>Соотношение Л/Ш:</span><span class="${ratioClass}">${currentRatio.toFixed(2)}x</span></div>
      <div class="row"><span style="font-size:11px;color:#888;">Цель для бычки: 1.66x</span></div>
    </div>
  `;

    container.innerHTML = shortHtml + longHtml + calculatorHtml + summaryHtml;
}
