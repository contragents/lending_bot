// Определяем обновленные структуры под формат ваших моделей лендинга
export type LandingAssetItem = {
    token: string;
    amount: number;
    price: number; // 👈 Добавлено поле текущей цены
};

export type LandingModelData = {
    supply: LandingAssetItem[];
    borrow: LandingAssetItem[];
};

// Входные интерфейсы
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

    // Вспомогательная функция для безопасного расчета текущей рыночной цены
    const calculatePrice = (positionValue: string, szi: string): number => {
        const size = Math.abs(Number(szi));
        return size === 0 ? 0 : Number(positionValue) / size;
    };

    // 1. Агрегируем списки позиций в формат (Токен, Количество, Цена)
    // Для лонгов вычисляем маркет-прайс на основе текущего номинала и размера
    const supplyList: LandingAssetItem[] = longs.map(p => ({
        token: p.coin,
        amount: Math.abs(Number(p.szi)),
        price: calculatePrice(p.positionValue, p.szi) // 👈 Расчет цены лонга
    }));

    // Для шортов аналогично рассчитываем цену
    const borrowList: LandingAssetItem[] = shorts.map(p => ({
        token: p.coin,
        amount: Math.abs(Number(p.szi)),
        price: calculatePrice(p.positionValue, p.szi) // 👈 Расчет цены шорта
    }));

    // 2. Рассчитываем совокупные долларовые номиналы позиций (Notional Value)
    const totalLongNotional = longs.reduce((sum, p) => sum + Number(p.positionValue), 0);
    const totalShortNotional = shorts.reduce((sum, p) => sum + Number(p.positionValue), 0);

    // 3. Вычисляем корректирующую величину виртуального USDC
    const virtualUsdcForSupply = totalEquity + totalShortNotional - totalLongNotional;

    // 4. Добавляем корректирующий USDC в модель Supply с фиксированной ценой $1
    supplyList.push({
        token: "USDC",
        amount: virtualUsdcForSupply,
        price: 1 // 👈 Цена стейблкоина всегда равна 1
    });

    return {
        supply: supplyList,
        borrow: borrowList
    };
}
