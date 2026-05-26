/**
 * Универсальная обертка для повторных попыток выполнения асинхронных функций
 * @param fn - Функция, которую нужно выполнить
 * @param retries - Количество попыток (по умолчанию 3)
 * @param delay - Начальная задержка в мс (по умолчанию 1000)
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    retries: number = 3,
    delay: number = 1000
): Promise<T> {
    try {
        return await fn();
    } catch (error: any) {
        // Проверяем, является ли ошибка временным сбоем (таймаут, лимиты, сетевой сбой)
        const isTimeout = error.message?.includes('timeout') || error.code === 'TIMEOUT';
        const isRateLimit = error.info?.error?.message?.includes('tier') || error.status === 429;

        if (retries > 0 && (isTimeout || isRateLimit || error.code === 'CALL_EXCEPTION')) {
            console.log(`⚠️ Сетевая задержка или лимит RPC. Повтор через ${delay}ms... (Попыток осталось: ${retries})`);

            await new Promise(res => setTimeout(res, delay));

            // Экспоненциальное увеличение задержки (1s -> 2s -> 4s)
            return withRetry(fn, retries - 1, delay * 2);
        }

        // Если попытки кончились или ошибка критическая — выбрасываем её дальше
        throw error;
    }
}

import {ethers} from 'ethers';
import readline from 'readline/promises';
export async function loadWallet(provider: ethers.Provider) {
    const keystoreJson = process.env.ENCRYPTED_KEY;
    let password;
    if (process.env.KEY_PASSWORD) {
        password = process.env.KEY_PASSWORD;
    } else {
        // Запрашиваем пароль в консоли (безопаснее, чем хранить в .env)
        const rl = readline.createInterface({input: process.stdin, output: process.stdout});
        password = await rl.question('Введите пароль от кошелька: ');
        rl.close();
    }

    try {
        console.log("Расшифровка...");
        // Восстанавливаем кошелек
        const wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson!, password);

        return wallet.connect(provider);
    } catch (e) {
        console.log("Неверный пароль!");

        return;
    }
}

export async function estimatePriceImpact(
    provider: ethers.JsonRpcProvider,
    amountInHuman: number, // Сколько OP мы хотим поменять (например, 1000)
    poolAddress: string,
    abi: string[],
) {
    const poolContract = new ethers.Contract(poolAddress, abi, provider);

    // 1. Получаем данные пула
    const [sqrtPriceX96] = await poolContract.slot0();
    const L = BigInt(await poolContract.liquidity());
    const poolFee = await poolContract.fee();
    const Q96 = BigInt(2) ** BigInt(96);

    const amountInWei = ethers.parseUnits(amountInHuman.toString(), 18);

    // 2. Считаем комиссию пула
    const feePercent = Number(poolFee) / 10000; // 0.3 или 0.05
    const feeAmountWei = (amountInWei * BigInt(poolFee)) / BigInt(1000000);
    const amountAfterFeeWei = amountInWei - feeAmountWei;

    // Человеческий размер комиссии для логов
    const feeAmountHuman = Number(ethers.formatUnits(feeAmountWei, 18));

    // 3. Текущий курс (сколько ETH стоит 1 OP)
    const sqrtP_start = BigInt(sqrtPriceX96);
    const ratio_start = (Number(sqrtP_start) / Number(Q96)) ** 2;
    const currentPriceOPinETH = 1 / ratio_start;

    // Идеальный объем ETH, который мы должны были получить без комиссий и потерь
    const idealAmountOutETH = amountInHuman * currentPriceOPinETH;

    // 4. Расчет нового корня цены после добавления чистой суммы OP (Token 1)
    const sqrtP_end = sqrtP_start + ((amountAfterFeeWei * Q96) / L);

    // 5. РАСЧЕТ РЕАЛЬНОГО ВЫХОДА ETH (Token 0) ПО ФОРМУЛЕ UNISWAP V3
    // Δx = (L * Q96 * (sqrtP_end - sqrtP_start)) / (sqrtP_end * sqrtP_start)
    const numerator = L * Q96 * (sqrtP_end - sqrtP_start);
    const denominator = sqrtP_end * sqrtP_start;
    const realAmountOutWei = numerator / denominator;

    const realAmountOutETH = Number(ethers.formatUnits(realAmountOutWei, 18));

    // 6. РАСЧЕТ ВСЕХ ВИДОВ ПОТЕРЬ (В ETH и в пересчете на OP)
    // Общие потери в ETH
    const totalLossETH = idealAmountOutETH - realAmountOutETH;

    // Переводим потери обратно в OP по текущему курсу, чтобы выразить в % от вносимых токенов
    const totalLossInOP = totalLossETH / currentPriceOPinETH;

    // Общий процент потерь от исходной суммы OP
    const totalLossPercent = (totalLossInOP / amountInHuman) * 100;

    // Потери чисто от Price Impact (Общие потери минус комиссия)
    const priceImpactInOP = totalLossInOP - feeAmountHuman;
    const priceImpactPercent = (priceImpactInOP / amountInHuman) * 100;

    console.log(`--- Полный анализ затрат для ${amountInHuman} OP -> ETH (Пул ${feePercent}%) ---`);
    console.log(`Идеальный выход (без потерь): ${idealAmountOutETH.toFixed(6)} ETH`);
    console.log(`Реальный выход на кошелек:   ${realAmountOutETH.toFixed(6)} ETH`);
    console.log(`\n[ Абсолютные потери в OP ]:`);
    console.log(`- Комиссия пула:             ${feeAmountHuman.toFixed(4)} OP`);
    console.log(`- Потери от Price Impact:    ${priceImpactInOP.toFixed(4)} OP`);
    console.log(`- Итого потеряно:            ${totalLossInOP.toFixed(4)} OP`);
    console.log(`\n[ Процентные потери от вносимых OP ]:`);
    console.log(`- Процент комиссии:          ${feePercent.toFixed(4)}%`);
    console.log(`- Процент Price Impact:      ${priceImpactPercent.toFixed(4)}%`);
    console.log(`- ОБЩИЙ ПРОЦЕНТ ПОТЕРЬ:      ${totalLossPercent.toFixed(4)}%`);

    return {
        realAmountOutETH,
        totalLossPercent,
        feeAmountHuman,
        priceImpactPercent
    };
}

