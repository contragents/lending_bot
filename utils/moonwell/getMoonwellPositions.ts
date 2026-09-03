import {CONFIG, currentNetwork, getEnv, LENDING, provider, WATCH_ADDRESS} from "../../config.js";
import {ethers, formatUnits} from "ethers";
import {withRetry} from "../utils.js";

export async function getMoonwellPositions(): Promise<boolean> {
    console.log(`--- Moonwell Assets & Liabilities (${CONFIG.CHAIN}) ---`);

    const comptroller = new ethers.Contract(
        currentNetwork.MOONWELL.COMPTROLLER,
        CONFIG.ABI.MOONWELL,
        provider
    );

    try {
        let borrows = {};
        let supplys = {};
        const tgId = getEnv('TG_ID');
        const baseUrl = "https://invest.legal/bot/lendingCorrection/";
        const url = new URL(baseUrl);
        const params = url.searchParams;
        params.set('tg_id', String(tgId));

        const chainConfig = LENDING[CONFIG.CHAIN!];
        const userConfig = chainConfig[tgId as keyof typeof chainConfig];
        // Используем с проверкой на случай, если пользователя нет в конфиге
        params.set('lending_id', String(userConfig?.ID ?? ''));

        // 1. Получаем адреса всех доступных рынков Moonwell в текущей сети
        const markets: string[] = await withRetry<string[]>(() => (comptroller as any).getAllMarkets());

        for (const mTokenAddress of markets) {
            // Создаем инстанс контракта конкретного рынка (например, mUSDC или mWETH)
            const mToken = new ethers.Contract(mTokenAddress, CONFIG.ABI.MOONWELL, provider);

            // 2. Получаем слепок аккаунта для этого рынка
            // Возвращает: (error, баланс_mToken, баланс_займа, внутренний_курс_обмена)
            const [error, mTokenBalance, borrowBalance, exchangeRate] =
                await withRetry<[bigint, bigint, bigint, bigint]>(() => (mToken as any).getAccountSnapshot(WATCH_ADDRESS));

            if (error !== 0n) continue;

            // Если балансы нулевые, пропускаем этот токен, чтобы не спамить в консоль
            if (mTokenBalance === 0n && borrowBalance === 0n) continue;

            // Получаем тикер рынка (например, "mUSDC")
            const mTokenSymbol = await withRetry<string>(() => (mToken as any).symbol());
            const underlyingSymbol = mTokenSymbol.substring(1); // Отсекаем первую 'm', получаем 'USDC'

            // 3. Расчет реального баланса актива (Supply Balance)
            // mTokens имеют свой баланс, который увеличивается за счет процентов.
            // Формула: (баланс_mToken * курс_обмена) / 1e18
            if (mTokenBalance > 0n) {
                const underlyingAmountWei = BigInt(mTokenBalance * exchangeRate) / ethers.parseEther("1");
                const formattedSupply = formatUnits(underlyingAmountWei, CONFIG.TOKEN_DECIMALS[underlyingSymbol]);
                console.log(`🟢 Снабжение (Asset)  -> ${formattedSupply} ${underlyingSymbol}`);
                params.set('supply_' + userConfig.PAIR_IDS[underlyingSymbol as keyof typeof userConfig.PAIR_IDS], formattedSupply);
            }

            // 4. Расчет баланса долга (Borrow Balance)
            if (borrowBalance > 0n) {
                const formattedBorrow = formatUnits(borrowBalance, CONFIG.TOKEN_DECIMALS[underlyingSymbol]);
                console.log(`🔴 Заем (Liability)   -> ${formattedBorrow} ${underlyingSymbol}`);
                params.set('borrow_' + userConfig.PAIR_IDS[underlyingSymbol as keyof typeof userConfig.PAIR_IDS], formattedBorrow);
            }

            const [formattedSupplyAPY, formattedBorrowAPY] = await calculateMoonwellAPY(mToken);

            if (borrowBalance > 0n) {
                console.log(`Borrow APY: ${formattedBorrowAPY}`);
            } else {
                console.log(`Supply APY: ${formattedSupplyAPY}`);
            }
        }

        const response = await fetch(url.href);
        const text = await response.text(); // Читаем ответ как строку
        console.log(url.href, text); // Выведет чистый текст ответа

        return text === 'OK';
    } catch (err: any) {
        console.error("Ошибка при получении позиций Moonwell:", err.message);

        return false;
    }
}

/**
 * Получает текущие ставки Supply APY и Borrow APY для конкретного рынка Moonwell (Optimism/Base)
 * @param mToken Инстанс контракта ethers.Contract для конкретного mToken
 * @returns Массив строк [formattedSupplyAPY, formattedBorrowAPY]
 */
export async function calculateMoonwellAPY(mToken: ethers.Contract): Promise<[string, string]> {
    try {
        // 5. Определение процентной ставки по токену
        // 5.1. Запрашиваем rate per block напрямую из контракта mToken
        const borrowRatePerTimestamp: bigint = await withRetry<bigint>(() =>
            (mToken as any).borrowRatePerTimestamp()
        );
        const supplyRatePerTimestamp: bigint = await withRetry<bigint>(() =>
            (mToken as any).supplyRatePerTimestamp()
        );

        // 5.2. Переводим BigInt в обычное дробное число (деля на 1e18)
        const borrowRatePerSecond = Number(borrowRatePerTimestamp) / 1e18;
        const supplyRatePerSecond = Number(supplyRatePerTimestamp) / 1e18;

        // 3. Расчет APY по формуле сложного процента (Compounding) за 365 дней
        const SECONDS_PER_YEAR = 365 * 24 * 60 * 60; // 31536000 секунд

        // Формула: (1 + rate_per_second)^seconds_per_year - 1
        const supplyAPY = (Math.pow(1 + supplyRatePerSecond, SECONDS_PER_YEAR) - 1) * 100;
        const borrowAPY = (Math.pow(1 + borrowRatePerSecond, SECONDS_PER_YEAR) - 1) * 100;

        const formattedSupplyAPY = supplyAPY.toFixed(2);
        const formattedBorrowAPY = borrowAPY.toFixed(2);

        // 4. Возвращаем массив с округлением до 2 знаков после запятой
        return [formattedSupplyAPY, formattedBorrowAPY];
    } catch (error: any) {
        console.error(`Ошибка при расчете APY для токена:`, error.message);
        // Возвращаем дефолтные нули в случае непредвиденного сбоя, чтобы не ломать основной цикл
        return ["0.00", "0.00"];
    }
}
