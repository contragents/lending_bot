import {CONFIG, currentNetwork, getEnv, LENDING, provider, providers, WATCH_ADDRESS} from "../../config.js";
import { ethers, formatUnits } from "ethers";
import { withRetry } from "../utils.js";

/**
 * Получает позицию cbBTC/USDC в BASE!
 */
export async function getMorphoPositions(): Promise<boolean> {
    console.log(`--- Morpho Blue Assets & Liabilities (BASE) ---`);

    // Адрес синглтона Morpho Blue на Base
    const MORPHO_BLUE_ADDRESS = ethers.getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb".toLowerCase());

    // ID конкретного рынка из вашей ссылки (USDC-cbBTC)
    const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";

    const morpho = new ethers.Contract(
        MORPHO_BLUE_ADDRESS,
        CONFIG.ABI.MORPHO,
        providers['BASE']
    );

    try {
        const tgId = getEnv('TG_ID');
        const baseUrl = "https://invest.legal/bot/lendingCorrection/";
        const url = new URL(baseUrl);
        const params = url.searchParams;
        params.set('tg_id', String(tgId));

        const chainConfig = LENDING['BASE'];
        const userConfig = chainConfig[tgId as keyof typeof chainConfig];
        params.set('lending_id', String(userConfig?.ID ?? ''));

        // 1. Получаем состояние позиции пользователя на конкретном рынке
        // Возвращает: collateral (залог в cbBTC), borrowShares (доли долга в USDC)
        //const [collateral, borrowShares] = await withRetry<[bigint, bigint]>(() =>
          //  (morpho as any).position(MARKET_ID, WATCH_ADDRESS)
        //);

        // 1. Получаем состояние позиции пользователя на конкретном рынке (добавлена переменная supplyShares)
        const [supplyShares, borrowShares, collateral] = await withRetry<[bigint, bigint, bigint]>(() =>
            (morpho as any).position(MARKET_ID, WATCH_ADDRESS)
        );

        // Если и залог, и долг равны нулю, выходим
        if (collateral === 0n && borrowShares === 0n) {
            console.log("Позиции на Morpho Blue не найдены.");
            return true;
        }

        // В этой паре: Коллатераль = cbBTC, Заем (Долг) = USDC
        const collateralSymbol = "cbBTC";
        const borrowSymbol = "USDC";

        // 2. Расчет реального баланса залога (Supply Collateral)
        if (collateral > 0n) {
            const formattedSupply = formatUnits(collateral, CONFIG.TOKEN_DECIMALS[collateralSymbol]);
            console.log(`🟢 Снабжение (Asset - Collateral) -> ${formattedSupply} ${collateralSymbol}`);

            const pairId = userConfig.PAIR_IDS[collateralSymbol as keyof typeof userConfig.PAIR_IDS];
            if (pairId) params.set('supply_' + pairId, formattedSupply);
        }

        // 3. Расчет реального баланса долга (Borrow Balance)
        // В Morpho долг хранится в "долях" (shares). Нужно конвертировать доли в активы.
        if (borrowShares > 0n) {
            // Получаем глобальное состояние рынка
            const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares] =
                await withRetry<[bigint, bigint, bigint, bigint]>(() => (morpho as any).market(MARKET_ID));

            // Формула конвертации: (shares * totalBorrowAssets) / totalBorrowShares
            let borrowAmountWei = 0n;
            if (totalBorrowShares > 0n) {
                borrowAmountWei = (borrowShares * totalBorrowAssets) / totalBorrowShares;
            }

            const formattedBorrow = formatUnits(borrowAmountWei, CONFIG.TOKEN_DECIMALS[borrowSymbol]);
            console.log(`🔴 Заем (Liability - Debt)       -> ${formattedBorrow} ${borrowSymbol}`);

            const pairId = userConfig.PAIR_IDS[borrowSymbol as keyof typeof userConfig.PAIR_IDS];
            if (pairId) params.set('borrow_' + pairId, formattedBorrow);
        }

        // Отправка данных на ваш сервер
        const response = await fetch(url.href);
        const text = await response.text();
        console.log(url.href, text);

        return text === 'OK';
    } catch (err: any) {
        console.error("Ошибка при получении позиций Morpho Blue:", err.message);

        return false;
    }
}
