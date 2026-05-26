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

    // 1. Получаем данные из пула
    const [sqrtPriceX96] = await poolContract.slot0();
    const L = BigInt(await poolContract.liquidity());
    const poolFee = await poolContract.fee(); // Например, 3000 или 500
    const Q96 = BigInt(2) ** BigInt(96);

    // 2. РАСЧЕТ КОМИССИИ ПУЛА
    const feePercent = Number(poolFee) / 10000; // Переводим в % (0.3 или 0.05)
    const feeAmountHuman = amountInHuman * (feePercent / 100); // Сколько токенов уйдет на комиссию
    const amountAfterFeeHuman = amountInHuman - feeAmountHuman; // Сколько токенов пойдет в обмен

    // Переводим чистую сумму обмена в Wei для формулы
    const amountAfterFeeWei = ethers.parseUnits(amountAfterFeeHuman.toString(), 18);

    // 3. РАСЧЕТ РЫНОЧНЫХ КУРСОВ (До обмена)
    const ratio = (Number(sqrtPriceX96) / Number(Q96)) ** 2;
    const currentPriceETHinOP = ratio;
    const currentPriceOPinETH = 1 / ratio;

    // 4. ФОРМУЛА СВОПА (Используем сумму ПОСЛЕ вычета комиссии)
    const nextSqrtPriceX96 = sqrtPriceX96 + ((amountAfterFeeWei * Q96) / L);

    // 5. РАСЧЕТ НОВОЙ ЦЕНЫ И PRICE IMPACT
    const newRatio = (Number(nextSqrtPriceX96) / Number(Q96)) ** 2;
    const newPriceOPinETH = 1 / newRatio;

    const priceImpactPercent = ((currentPriceOPinETH - newPriceOPinETH) / currentPriceOPinETH) * 100;

    console.log(`--- Расчет обмена ${amountInHuman} OP -> ETH (Размер комиссии: ${feePercent}%) ---`);
    console.log(`Комиссия пула: ${feeAmountHuman.toFixed(4)} OP`);
    console.log(`Чистая сумма обмена: ${amountAfterFeeHuman.toFixed(4)} OP`);
    console.log(`Рыночный курс: 1 ETH = ${currentPriceETHinOP.toFixed(2)} OP`);
    console.log(`Текущая стоимость: 1 OP = ${currentPriceOPinETH.toFixed(8)} ETH`);
    console.log(`Стоимость после обмена: 1 OP = ${newPriceOPinETH.toFixed(8)} ETH`);
    console.log(`Реальный Price Impact (с учетом комиссии): ${priceImpactPercent.toFixed(6)}%`);

    return {
        newPriceOPinETH,
        priceImpactPercent,
        feeAmountHuman,
        feePercent
    };
}

