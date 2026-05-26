import {CONFIG, POOLS} from "./config.js";

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

    const oracleContract = new ethers.Contract(POOLS.OPT.OracleAddress, CONFIG.ABI.ORACLE, provider);

    // 1. ПОЛУЧЕНИЕ ИСХОДНЫХ ДАННЫХ ПУЛА
    const [sqrtPriceX96] = await poolContract.slot0();
    const L = BigInt(await poolContract.liquidity());
    const poolFee = await poolContract.fee();
    const Q96 = BigInt(2) ** BigInt(96);

    const amountInWei = ethers.parseUnits(amountInHuman.toString(), 18);

    const l1GasCostWei = await l1FeeEstimated(provider);

    // Считаем стандартный L2 Execution Fee
    const feeData = await provider.getFeeData();
    const l2GasPrice = feeData.gasPrice ?? BigInt(0);
    const L2_GAS_LIMIT = BigInt(150000); // Оценка лимита газа исполнения на L2
    const l2GasCostWei = l2GasPrice * L2_GAS_LIMIT;

    // Суммарный газ (L1 + L2)
    const totalGasCostWei = l1GasCostWei + l2GasCostWei;
    const totalGasCostETH = Number(ethers.formatUnits(totalGasCostWei, 18));

    // 3. МАТЕМАТИКА СВОПА И ПОТЕРЬ
    const feePercent = Number(poolFee) / 10000;
    const feeAmountWei = (amountInWei * BigInt(poolFee)) / BigInt(1000000);
    const amountAfterFeeWei = amountInWei - feeAmountWei;
    const feeAmountHuman = Number(ethers.formatUnits(feeAmountWei, 18));

    const sqrtP_start = BigInt(sqrtPriceX96);
    const ratio_start = (Number(sqrtP_start) / Number(Q96)) ** 2;
    const currentPriceOPinETH = 1 / ratio_start;

    // Идеальный результат без издержек
    const idealAmountOutETH = amountInHuman * currentPriceOPinETH;

    // Переводим стоимость газа из ETH в OP по текущему курсу для сложения
    const gasCostOP = totalGasCostETH / currentPriceOPinETH;

    // Рассчитываем движение цены
    const sqrtP_end = sqrtP_start + ((amountAfterFeeWei * Q96) / L);
    const numerator = L * Q96 * (sqrtP_end - sqrtP_start);
    const denominator = sqrtP_end * sqrtP_start;
    const realAmountOutWei = numerator / denominator;
    const realAmountOutETH = Number(ethers.formatUnits(realAmountOutWei, 18));

    // Итоговый чистый профит на кошельке
    const netAmountOutETH = realAmountOutETH - totalGasCostETH;

    // Финансовые потери пула
    const tradingLossETH = idealAmountOutETH - realAmountOutETH;
    const tradingLossInOP = tradingLossETH / currentPriceOPinETH;
    const priceImpactInOP = tradingLossInOP - feeAmountHuman;

    // ИТОГО (Пул + Реальный Газ L1 + L2)
    const totalLossInOP = tradingLossInOP + gasCostOP;
    const totalLossPercent = (totalLossInOP / amountInHuman) * 100;

    const priceImpactPercent = (priceImpactInOP / amountInHuman) * 100;
    const gasLossPercent = (gasCostOP / amountInHuman) * 100;

    console.log(`--- Анализ с точным газом Optimism L1+L2 (${amountInHuman} OP, Пул ${feePercent}%) ---`);
    console.log(`Идеальный выход (без потерь): ${idealAmountOutETH.toFixed(6)} ETH`);
    console.log(`Реальный выход из пула:      ${realAmountOutETH.toFixed(6)} ETH`);
    console.log(`Чистый результат на выходе:  ${netAmountOutETH.toFixed(6)} ETH`);

    console.log(`\n[ Реальная стоимость газа ]:`);
    console.log(`- L1 Data Fee (Ethereum):    ${Number(ethers.formatUnits(l1GasCostWei, 18)).toFixed(18)} ETH`);
    console.log(`- L2 Execution Fee:          ${Number(ethers.formatUnits(l2GasCostWei, 18)).toFixed(18)} ETH`);
    console.log(`- Всего за транзакцию:       ${totalGasCostETH.toFixed(18)} ETH (~${gasCostOP.toFixed(18)} OP)`);

    console.log(`\n[ Абсолютные потери в OP ]:`);
    console.log(`- Комиссия пула:             ${feeAmountHuman.toFixed(4)} OP`);
    console.log(`- Потери от Price Impact:    ${priceImpactInOP.toFixed(4)} OP`);
    console.log(`- Потери на газ:             ${gasCostOP.toFixed(18)} OP`);
    console.log(`- ИТОГО ПОТЕРЯНО:            ${totalLossInOP.toFixed(4)} OP`);

    console.log(`\n[ Процентные потери от вносимых OP ]:`);
    console.log(`- Процент комиссии пула:     ${feePercent.toFixed(4)}%`);
    console.log(`- Процент Price Impact:      ${priceImpactPercent.toFixed(4)}%`);
    console.log(`- Процент затрат на газ:     ${gasLossPercent.toFixed(6)}%`);
    console.log(`- ОБЩИЙ ПРОЦЕНТ ПОТЕРЬ:      ${totalLossPercent.toFixed(4)}%`);

    return { realAmountOutETH, netAmountOutETH, totalLossPercent };
}

async function l1FeeEstimated(provider: ethers.JsonRpcProvider){
    const oracleContract = new ethers.Contract(POOLS.OPT.OracleAddress, CONFIG.ABI.ORACLE, provider);

    // 2. СОВРЕМЕННЫЙ АВТОНОМНЫЙ РАСЧЕТ ГАЗА OPTIMISM (L1 Ecotone + L2)
    const l1BaseFee = await oracleContract.l1BaseFee();
    const blobBaseFee = await oracleContract.blobBaseFee();
    const baseFeeScalar = BigInt(await oracleContract.baseFeeScalar());
    const blobBaseFeeScalar = BigInt(await oracleContract.blobBaseFeeScalar());
    const oracleDecimals = await oracleContract.decimals(); // Обычно 6

    // Приблизительный объем calldata газа для Swap-транзакции exactInputSingle (~300 байт)
    const calldataGas = BigInt(4200 * 2); // берем с 2х запасом

    // Актуальная формула расчета L1 Data Fee (Bedrock/Ecotone с BlobSpace)
    // Формула: calldataGas * (16 * l1BaseFee * baseFeeScalar + blobBaseFee * blobBaseFeeScalar) / (16 * 10^decimals)
    const scaledBaseFee = BigInt(16) * l1BaseFee * baseFeeScalar;
    const scaledBlobBaseFee = blobBaseFee * blobBaseFeeScalar;

    return (calldataGas * (scaledBaseFee + scaledBlobBaseFee)) / (BigInt(16) * (BigInt(10) ** oracleDecimals));
}

