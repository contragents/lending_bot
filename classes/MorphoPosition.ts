import {ethers, formatUnits} from "ethers";
import {BASE_CHAIN, CONFIG, getEnv, LENDING, type ChainType, WATCH_ADDRESS} from "../config.js";
import {Position} from "./Position.js";
import {withRetry} from "../utils/utils.js";

const MORPHO_BLUE_ADDRESS = ethers.getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb".toLowerCase());
const MARKET_ID = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const SUPPORTED_CHAINS: readonly ChainType[] = [BASE_CHAIN];

export class MorphoPosition extends Position {
    protected readonly lendingId = 5;
    static readonly SUPPORTED_CHAINS: ChainType[] = [BASE_CHAIN];

    private hasPosition = false;
    private positionLoaded = false;

    async getPosition(): Promise<boolean> {
        this.assets = {supply: {}, borrow: {}};
        this.hasPosition = false;
        this.positionLoaded = false;
        console.log(`--- Morpho Blue Assets & Liabilities (${this.chain}) ---`);
        const morpho = new ethers.Contract(MORPHO_BLUE_ADDRESS, CONFIG.ABI.MORPHO, this.provider);

        try {
            const tgId = getEnv("TG_ID");
            const userConfig = LENDING[BASE_CHAIN][tgId as keyof typeof LENDING[typeof BASE_CHAIN]];
            if (!userConfig) {
                throw new Error(`Lending configuration is missing for user ${tgId} on ${this.chain}`);
            }

            const [supplyShares, borrowShares, collateral] = await withRetry<[bigint, bigint, bigint]>(() =>
                (morpho as any).position(MARKET_ID, WATCH_ADDRESS)
            );

            this.hasPosition = collateral !== 0n || borrowShares !== 0n;
            if (!this.hasPosition) {
                console.log("Позиции на Morpho Blue не найдены.");
                this.positionLoaded = true;
                return true;
            }

            const collateralSymbol = "cbBTC";
            const borrowSymbol = "USDC";

            if (collateral > 0n) {
                const formattedSupply = formatUnits(collateral, CONFIG.TOKEN_DECIMALS[collateralSymbol]);
                console.log(`🟢 Снабжение (Asset - Collateral) -> ${formattedSupply} ${collateralSymbol}`);
                const pairId = userConfig.PAIR_IDS[collateralSymbol as keyof typeof userConfig.PAIR_IDS];
                if (pairId !== undefined) this.assets.supply[pairId] = Number(formattedSupply);
            }

            if (borrowShares > 0n) {
                const [, , totalBorrowAssets, totalBorrowShares] =
                    await withRetry<[bigint, bigint, bigint, bigint]>(() =>
                        (morpho as any).market(MARKET_ID)
                    );
                const borrowAmountWei = totalBorrowShares > 0n
                    ? (borrowShares * totalBorrowAssets) / totalBorrowShares
                    : 0n;
                const formattedBorrow = formatUnits(borrowAmountWei, CONFIG.TOKEN_DECIMALS[borrowSymbol]);
                console.log(`🔴 Заем (Liability - Debt) -> ${formattedBorrow} ${borrowSymbol}`);
                const pairId = userConfig.PAIR_IDS[borrowSymbol as keyof typeof userConfig.PAIR_IDS];
                if (pairId !== undefined) this.assets.borrow[pairId] = Number(formattedBorrow);
            }

            this.positionLoaded = true;
            return true;
        } catch (err) {
            console.error("Ошибка при получении позиций Morpho Blue:", err);
            return false;
        }
    }

    async reportPosition(): Promise<boolean> {
        if (!this.positionLoaded) {
            throw new Error("Call getPosition() before reportPosition()");
        }
        if (!this.hasPosition) return true;

        try {
            const url = this.createReportUrl(this.createReportParams(this.assets));
            const response = await fetch(url.href);
            const text = await response.text();
            console.log(url.href, text);
            return text === "OK";
        } catch (err) {
            console.error("Ошибка при отправке позиций Morpho Blue:", err);
            return false;
        }
    }
}
