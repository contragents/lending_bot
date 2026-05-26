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

    // 1. ПОЛУЧЕНИЕ ДАННЫХ ИЗ БЛОКЧЕЙНА (Пул + Газ)
    const [sqrtPriceX96] = await poolContract.slot0();
    const L = BigInt(await poolContract.liquidity());
    const poolFee = await poolContract.fee();
    const Q96 = BigInt(2) ** BigInt(96);

    // Запрашиваем текущую стоимость газа в сети
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? BigInt(0);

    // Средний лимит газа для Uniswap V3 swap транзакции
    const ESTIMATED_SWAP_GAS_LIMIT = BigInt(150000);
    const gasCostWei = gasPrice * ESTIMATED_SWAP_GAS_LIMIT;
    const gasCostETH = Number(ethers.formatUnits(gasCostWei, 18));

    const amountInWei = ethers.parseUnits(amountInHuman.toString(), 18);

    // 2. СЧЕТ КОМИССИИ ПУЛА
    const feePercent = Number(poolFee) / 10000;
    const feeAmountWei = (amountInWei * BigInt(poolFee)) / BigInt(1000000);
    const amountAfterFeeWei = amountInWei - feeAmountWei;
    const feeAmountHuman = Number(ethers.formatUnits(feeAmountWei, 18));

    // 3. ТЕКУЩИЙ КУРС И ИДЕАЛЬНЫЙ ВЫХОД
    const sqrtP_start = BigInt(sqrtPriceX96);
    const ratio_start = (Number(sqrtP_start) / Number(Q96)) ** 2;
    const currentPriceOPinETH = 1 / ratio_start;

    const idealAmountOutETH = amountInHuman * currentPriceOPinETH;

    // Конвертируем стоимость газа из ETH в OP по текущему курсу
    const gasCostOP = gasCostETH / currentPriceOPinETH;

    // 4. ФОРМУЛА СВОПА UNISWAP V3
    const sqrtP_end = sqrtP_start + ((amountAfterFeeWei * Q96) / L);

    // 5. РАСЧЕТ РЕАЛЬНОГО ВЫХОДА ETH
    const numerator = L * Q96 * (sqrtP_end - sqrtP_start);
    const denominator = sqrtP_end * sqrtP_start;
    const realAmountOutWei = numerator / denominator;

    const realAmountOutETH = Number(ethers.formatUnits(realAmountOutWei, 18));

    // Чистый экономический результат на кошельке после оплаты газа
    const netAmountOutETH = realAmountOutETH - gasCostETH;

    // 6. РАСЧЕТ ВСЕХ ВИДОВ ПОТЕРЬ (в пересчете на OP)
    const tradingLossETH = idealAmountOutETH - realAmountOutETH; // Потери внутри пула
    const tradingLossInOP = tradingLossETH / currentPriceOPinETH;
    const priceImpactInOP = tradingLossInOP - feeAmountHuman;

    // Итоговые суммарные потери (Пул + Газ)
    const totalLossInOP = tradingLossInOP + gasCostOP;
    const totalLossPercent = (totalLossInOP / amountInHuman) * 100;

    // Процентное соотношение каждого элемента к объему сделки
    const priceImpactPercent = (priceImpactInOP / amountInHuman) * 100;
    const gasLossPercent = (gasCostOP / amountInHuman) * 100;

    console.log(`--- Полный анализ затрат для ${amountInHuman} OP -> ETH (Пул ${feePercent}%) ---`);
    console.log(`Идеальный выход (без потерь): ${idealAmountOutETH.toFixed(6)} ETH`);
    console.log(`Реальный выход из пула:      ${realAmountOutETH.toFixed(6)} ETH`);
    console.log(`Чистый результат (-газ):     ${netAmountOutETH.toFixed(6)} ETH`);

    console.log(`\n[ Абсолютные потери в OP ]:`);
    console.log(`- Комиссия пула:             ${feeAmountHuman.toFixed(4)} OP`);
    console.log(`- Потери от Price Impact:    ${priceImpactInOP.toFixed(4)} OP`);
    console.log(`- Стоимость газа (сеть):     ${gasCostOP.toFixed(4)} OP (${gasCostETH.toFixed(6)} ETH)`);
    console.log(`- ИТОГО ПОТЕРЯНО:            ${totalLossInOP.toFixed(4)} OP`);

    console.log(`\n[ Процентные потери от вносимых OP ]:`);
    console.log(`- Процент комиссии пула:     ${feePercent.toFixed(4)}%`);
    console.log(`- Процент Price Impact:      ${priceImpactPercent.toFixed(4)}%`);
    console.log(`- Процент затрат на газ:     ${gasLossPercent.toFixed(4)}%`);
    console.log(`- ОБЩИЙ ПРОЦЕНТ ПОТЕРЬ:      ${totalLossPercent.toFixed(4)}%`);

    return {
        realAmountOutETH,
        netAmountOutETH,
        totalLossPercent,
        gasCostETH
    };
}

