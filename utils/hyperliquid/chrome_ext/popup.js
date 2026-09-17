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
    // Находим все строки таблицы позиций. В интерфейсе HL они лежат в блоке с классами строк таблицы
    const rows = document.querySelectorAll('tr');
    let extracted = [];

    rows.forEach(row => {
        // Ищем ячейки. В HL тикер обычно в первой ячейке, позиция/размер далее
        const cells = row.querySelectorAll('td');
        if (cells.length >= 4) {
            const assetText = cells[0].innerText; // Пример: "OP Perps" или "OP"
            const sizeText = cells[1].innerText;  // Объём в токенах и долларах

            // Отсекаем служебные строки таблицы
            if (assetext && sizeText && (sizeText.includes('\(') \vert{}\vert{} cells[3].innerText.includes('\)'))) {
                // Определяем направление лонг/шорт по цвету шрифта или тексту (у HL зеленый/красный цвет текста для Long/Short)
                let side = 'long';
                if (cells[1].innerHTML.includes('color: rgb(234, 67, 53)') || cells[1].innerHTML.includes('red') || cells[0].innerText.includes('-') || cells[1].innerText.includes('-')) {
                    side = 'short';
                }

                // Извлекаем чистые доллары из колонки размера или Notional Value
                // Ищем строку с символом "\$"
                let usdValue = 0;
                cells.forEach(c => {
                    if (c.innerText.includes('\$')) {
                        const matches = c.innerText.match(/\$?([\d,]+\.\d+)/);
                        if (matches) usdValue = parseFloat(matches[1].replace(/,/g, ''));
                    }
                });

                const ticker = assetText.split(' ')[0].replace(/[^a-zA-Z]/g, '');

                if (usdValue > 0 && ticker) {
                    extracted.push({ ticker, side, usdValue });
                }
            }
        }
    });

    // Дополнительная очистка от дубликатов, если селектор зацепил лишнее
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
