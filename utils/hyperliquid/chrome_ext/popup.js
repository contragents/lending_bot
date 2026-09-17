document.getElementById('analyzeBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url.includes("hyperliquid.xyz")) {
        document.getElementById('results').innerText = "Ошибка: Откройте вкладку торговли Hyperliquid!";
        return;
    }

    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: parseHLPositions
    }, (results) => {
        if (!results || !results[0] || !results[0].result) {
            document.getElementById('results').innerText = "Не удалось прочитать таблицу позиций. Убедитесь, что вкладка 'Positions' открыта в интерфейсе биржи.";
            return;
        }

        renderResults(results[0].result);
    });
});

// ФУНКЦИЯ ПАРСИНГА (Выполняется прямо внутри страницы Hyperliquid)
function parseHLPositions() {
    // 🔥 ВАШ МАССИВ ЛОНГОВ. Всё, чего здесь нет, автоматически запишется в шорты!
    const LONG_TOKENS = ['ETH', 'BTC', 'HYPE'];

    const rows = document.querySelectorAll('tr');
    let extracted = [];

    rows.forEach(row => {
        const cells = row.querySelectorAll('td');

        // В таблице позиций на HL обычно от 7 до 12 колонок
        if (cells.length >= 6) {
            const marketText = cells[0]?.innerText || ""; // Первая колонка: "OP 5x", "ETH 20x"
            const sizeText = cells[1]?.innerText || "";   // Вторая колонка: "1 860,7 OP", "0,1834 ETH"
            const valueText = cells[2]?.innerText || "";  // Третья колонка: "182,11 USDC"

            // Отсекаем служебные строки (заголовки) по наличию ключевого слова USDC или знака валюты
            if (marketText && valueText && valueText.includes('USDC')) {

                // 1. Извлекаем чистый тикер (берем первое слово из колонки Market, например "OP" из "OP 5x")
                const rawTicker = marketText.split(' ')[0].trim().toUpperCase();
                // Дополнительно очищаем от случайных небуквенных символов
                const ticker = rawTicker.replace(/[^A-Z0-9]/g, '');

                // 2. Извлекаем чистые доллары из колонки Position Value
                // Заменяем запятую на точку (для русской локализации) и удаляем всё кроме цифр и точки
                const cleanValue = valueText.replace(',', '.').replace(/[^0-9.]/g, '');
                const usdValue = parseFloat(cleanValue);

                // 3. ВАША НОВАЯ ЛОГИКА: Определяем направление строго по белому списку активов
                let side = 'short';
                if (LONG_TOKENS.includes(ticker)) {
                    side = 'long';
                }

                // Защитная фильтрация от мусора
                if (usdValue > 0 && ticker && ticker !== 'MARKET' && ticker !== 'TOTAL') {
                    extracted.push({ ticker, side, usdValue });
                }
            }
        }
    });

    // Удаляем возможные дубликаты строк
    return extracted.filter((v, i, a) => a.findIndex(t => t.ticker === v.ticker && t.side === v.side) === i);
}

// ФУНКЦИЯ ОТРИСОВКИ РЕЗУЛЬТАТОВ (Выполняется внутри всплывающего окна расширения)
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

    // Генерируем HTML для Шортов
    let shortHtml = `<div class="section"><b class="red">🔴 ШОРТЫ (Всего: $${totalShortUSD.toFixed(2)})</b>`;
    shorts.forEach(p => {
        const share = (p.usdValue / totalShortUSD) * 100;
        shortHtml += `<div class="row"><span>${p.ticker}</span><span>$${p.usdValue.toFixed(2)} <span class="pct">(${share.toFixed(1)}%)</span></span></div>`;
    });
    shortHtml += `</div>`;

    // Генерируем HTML для Лонгов
    let longHtml = `<div class="section"><b class="green">🟢 ЛОНГИ (Всего: $${totalLongUSD.toFixed(2)})</b>`;
    longs.forEach(p => {
        const share = (p.usdValue / totalLongUSD) * 100;
        longHtml += `<div class="row"><span>${p.ticker}</span><span>$${p.usdValue.toFixed(2)} <span class="pct">(${share.toFixed(1)}%)</span></span></div>`;
    });
    longHtml += `</div>`;

    // Расчет текущего соотношения
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

    container.innerHTML = shortHtml + longHtml + summaryHtml;
}
