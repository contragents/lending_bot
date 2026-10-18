import {
    fetchLendingInstruction,
    type LendingLeverageInstruction,
    type LendingLeverageResult
} from "../utils/invest_legal/recommend.js";
import {BASE_CHAIN, type ChainType, getEnv, LENDING} from "../config.js";
import {ethers} from "ethers";

export const LENDING_BOT_URL = "https://invest.legal/bot/lendingCorrection";

export type PositionAssets = {
    supply: Record<string, number>;
    borrow: Record<string, number>;
};

export abstract class Position {
    protected abstract readonly lendingId: number;
    static readonly SUPPORTED_CHAINS: ChainType[] = [];

    assets: PositionAssets = {
        supply: {},
        borrow: {},
    };
    protected positionLoaded: boolean = false;
    protected hasPosition: boolean = false;

    constructor(
        protected readonly chain: ChainType,
        protected readonly provider: ethers.JsonRpcProvider
    ) {
        // Достаем статическое свойство из текущего класса-наследника
        const CurrentClass = this.constructor as typeof Position & { SUPPORTED_CHAINS?: ChainType[] };
        const supported = CurrentClass.SUPPORTED_CHAINS || [];

        if (!supported.includes(chain)) {
            throw new Error(`${this.constructor.name} is not supported for chain ${chain}`);
        }
    }

    public getPosition(): Promise<boolean> {
        this.assets = {supply: {}, borrow: {}};
        this.hasPosition = false;
        this.positionLoaded = false;
        console.log(`--- ${this.constructor.name} Assets & Liabilities (${this.chain}) ---`);

        return Promise.resolve(true);
    }

    abstract reportPosition(): Promise<boolean>;

    async getRecommend(): Promise<LendingLeverageResult> {
        return fetchLendingInstruction(this.lendingId);
    }

    /**
     * @param amount количество токена для подлупки
     * @param loop Массив Токен-количество
     */
    async loop(amount: number, instruction: LendingLeverageInstruction): Promise<void> {
        console.log(`${this.constructor.name} does not support looping`);
    }

    /**
     * @param amount количество токена для разлупки
     * @param deloop Массив Токен-количество
     */
    async deLoop(amount: number, instruction: LendingLeverageInstruction): Promise<void> {
        console.log(`${this.constructor.name} does not support de-looping`);
    }

    protected createReportParams(assets: PositionAssets): URLSearchParams {
        const params = new URLSearchParams({
            tg_id: getEnv("TG_ID"),
            lending_id: String(this.lendingId),
        });

        for (const [key, amount] of Object.entries(assets.supply)) {
            params.set(`supply_${key}`, String(amount));
        }
        for (const [key, amount] of Object.entries(assets.borrow)) {
            params.set(`borrow_${key}`, String(amount));
        }

        return params;
    }

    protected createReportUrl(params: URLSearchParams): URL {
        const url = new URL(LENDING_BOT_URL);
        url.search = params.toString();

        return url;
    }
}
