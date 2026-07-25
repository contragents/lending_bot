import {CONFIG, provider, WATCH_ADDRESS} from "../../config.js";
import {ethers} from "ethers";
import {withRetry} from "../utils.js";

export async function getMoonwellData() {
	console.log(`--- Moonwell Status (${CONFIG.CHAIN}) ---`);
	const comptroller = new ethers.Contract(
		CONFIG.NETWORKS[CONFIG.CHAIN!].MOONWELL.COMPTROLLER,
		CONFIG.ABI.MOONWELL,
		provider
	) as any;

	// Возвращает: (error, liquidity, shortfall)
	// Liquidity > 0 означает, что заем безопасен. Shortfall > 0 означает риск ликвидации.
	const [error, liquidity, shortfall] = await withRetry<[bigint, bigint, bigint]>(
		() => comptroller.getAccountLiquidity(WATCH_ADDRESS)
	);

	console.log(`User: ${WATCH_ADDRESS}`);
	console.log(`Available Liquidity (в USD, 1e18): ${ethers.formatEther(liquidity)}`);
	console.log(`Shortfall (Риск): ${ethers.formatEther(shortfall)}`);
}