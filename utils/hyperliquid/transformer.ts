// Определяем структуры под формат ваших моделей лендинга
export type LandingAssetItem = {
    token: string;
    amount: number;
};

export type LandingModelData = {
    supply: LandingAssetItem[];
    borrow: LandingAssetItem[];
};

// Входные интерфейсы (используем уже созданные типы)
interface HyperliquidDataInput {
    totalEquity: number;
    longs: Array<{ coin: string; szi: string; positionValue: string }>;
    shorts: Array<{ coin: string; szi: string; positionValue: string }>;
}

/**
 * Трансформирует перп-портфель Hyperliquid в классическую модель Лендинга (Supply/Borrow).
 * Гарантирует, что формула (Total Supply Value - Total Borrow Value) будет равна Total Equity.
 */
export function transformHyperliquidToLandingModel(data: HyperliquidDataInput): LandingModelData {
    const { totalEquity, longs, shorts } = data;

    // 1. Агрегируем списки позиций в формат (Токен, Количество)
    // Для лонгов количество идет как есть
    const supplyList: LandingAssetItem[] = longs.map(p => ({
        token: p.coin,
        amount: Math.abs(Number(p.szi))
    }));

    // Для шортов количество также идет в модель borrow
    const borrowList: LandingAssetItem[] = shorts.map(p => ({
        token: p.coin,
        amount: Math.abs(Number(p.szi))
    }));

    // 2. Рассчитываем совокупные долларовые номиналы позиций (Notional Value)
    const totalLongNotional = longs.reduce((sum, p) => sum + Number(p.positionValue), 0);
    const totalShortNotional = shorts.reduce((sum, p) => sum + Number(p.positionValue), 0);

    // 3. Вычисляем корректирующую величину виртуального USDC
    // Формула: Equity + Шорты - Лонги
    const virtualUsdcForSupply = totalEquity + totalShortNotional - totalLongNotional;

    // 4. Добавляем корректирующий USDC в модель Supply
    supplyList.push({
        token: "USDC",
        amount: virtualUsdcForSupply
    });

    return {
        supply: supplyList,
        borrow: borrowList
    };
}
